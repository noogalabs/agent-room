import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomRecordServer, signAgentCard } from '@agent-room/room-persistence';
import type { Room } from '@agent-room/shared';
import { createHostedRoomServer } from './server.js';
import { loadTrustStore } from './trust-store.js';

const opened: Array<Awaited<ReturnType<typeof createHostedRoomServer>>> = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { while (opened.length) await opened.pop()!.close(); vi.restoreAllMocks(); });

async function trustFile() {
  const dir = await mkdtemp(join(tmpdir(), 'room-trust-'));
  const keys = generateKeyPairSync('ed25519');
  const path = join(dir, 'trust.json');
  await writeFile(path, JSON.stringify([{ fleetId: 'fleet-a', keyId: 'key-a', publicKey: keys.publicKey.export({ format: 'jwk' }) }]));
  return { path, ...keys };
}

function room(): Room {
  return { code: 'ROOM1', topic: 'test', createdAt: 1, createdBy: 'host', status: 'active', version: 1,
    participants: [], acceptedMemberAuthSchemes: ['oauth2'] };
}

describe('hosted room production entry', () => {
  it('refuses missing, malformed, private, and duplicate trust stores before persistence or listen', async () => {
    const fromEnvironment = vi.spyOn(RoomRecordServer, 'fromEnvironment');
    await expect(createHostedRoomServer({})).rejects.toMatchObject({ name: 'trust_store_required' });
    const dir = await mkdtemp(join(tmpdir(), 'bad-trust-')); const bad = join(dir, 'bad.json');
    await writeFile(bad, '{');
    await expect(createHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_invalid' });
    const keys = generateKeyPairSync('ed25519');
    await writeFile(bad, JSON.stringify([{ fleetId: 'a', keyId: 'k', publicKey: keys.privateKey.export({ format: 'jwk' }) }]));
    await expect(loadTrustStore(bad)).rejects.toMatchObject({ name: 'trust_store_key_invalid' });
    const pub = keys.publicKey.export({ format: 'jwk' });
    await writeFile(bad, JSON.stringify([{ fleetId: 'a', keyId: 'k', publicKey: pub }, { fleetId: 'a', keyId: 'k', publicKey: pub }]));
    await expect(loadTrustStore(bad)).rejects.toMatchObject({ name: 'trust_store_duplicate_key' });
    expect(fromEnvironment).not.toHaveBeenCalled();
  });

  it('requires a signed card before participant write and persists one valid authenticated join', async () => {
    const trust = await trustFile(); let current = room();
    const records = {
      createRoom: vi.fn(), getRoom: vi.fn(async () => structuredClone(current)),
      updateRoom: vi.fn(async (_code: string, version: number, next: Room) => { if (version !== current.version) return false; current = structuredClone(next); return true; }),
      appendMessage: vi.fn(), listMessages: vi.fn(), close: vi.fn(),
    } as unknown as RoomRecordServer;
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(records);
    const hosted = await createHostedRoomServer({ AGENT_ROOM_TRUST_STORE: trust.path }); opened.push(hosted);
    await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`;
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    let response = await fetch(`${base}/api/rooms/ROOM1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant }) });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'agent_card_required' });
    expect(current.participants).toHaveLength(0);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    response = await fetch(`${base}/api/rooms/ROOM1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200); expect(current.participants).toHaveLength(1);
    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
    expect(health).toEqual({ ready: true, persistence: 'redis', memberAuth: 'required', trustKeyCount: 1 });
    expect(JSON.stringify(health)).not.toContain(trust.path);
  });

  it('consumer census pins the durable server as the production image entry', async () => {
    const root = new URL('../../../', import.meta.url);
    const docker = await readFile(new URL('Dockerfile', root), 'utf8');
    const railway = await readFile(new URL('railway.json', root), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('apps/room-server/package.json', root), 'utf8'));
    const entry = await readFile(new URL('apps/room-server/src/server.ts', root), 'utf8');
    expect(docker).toContain('CMD ["node", "apps/room-server/dist/index.js"]');
    expect(docker).not.toContain('apps/hosted-agent/dist/index.js');
    expect(railway).toContain('apps/room-server/dist/index.js');
    expect(pkg.dependencies['@agent-room/room-persistence']).toBe('*');
    expect(entry).toContain('RoomRecordServer.fromEnvironment');
  });

  it('keypair tool separates private and public custody without leaking key bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-keys-'));
    const privatePath = join(dir, 'fleet-private.json'); const trustPath = join(dir, 'trust.json');
    const script = new URL('../../../scripts/generate-fleet-keypair.mjs', import.meta.url);
    const result = await execFileAsync(process.execPath, [script.pathname, 'fleet-a', 'key-a', privatePath, trustPath]);
    const privateJwk = JSON.parse(await readFile(privatePath, 'utf8')) as Record<string, unknown>;
    const publicRows = JSON.parse(await readFile(trustPath, 'utf8')) as Array<{ publicKey: Record<string, unknown> }>;
    expect(privateJwk.d).toBeTypeOf('string'); expect(publicRows[0]?.publicKey.d).toBeUndefined();
    expect((await import('node:fs/promises')).stat(privatePath).then(value => value.mode & 0o777)).resolves.toBe(0o600);
    expect(result.stdout).not.toContain(String(privateJwk.d)); expect(result.stderr).toBe('');
    await expect(execFileAsync(process.execPath, [script.pathname, 'fleet-a', 'key-a', privatePath, trustPath])).rejects.toThrow('refuse_overwrite');
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('hosted room production entry with Postgres', () => {
  it('creates, reads, and authenticates a member through the real hosted entry', async () => {
    const trust = await trustFile(); const code = `PG${Date.now()}`;
    const hosted = await createHostedRoomServer({ AGENT_ROOM_TRUST_STORE: trust.path, AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl });
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`; const value = { ...room(), code };
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })).status).toBe(201);
    expect((await (await fetch(`${base}/api/rooms/${code}`)).json() as Room).code).toBe(code);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const response = await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200);
    const persisted = await (await fetch(`${base}/api/rooms/${code}`)).json() as Room;
    expect(persisted.participants).toHaveLength(1); expect(persisted.participants[0]?.authenticatedIdentity?.fleetId).toBe('fleet-a');
  });
});
