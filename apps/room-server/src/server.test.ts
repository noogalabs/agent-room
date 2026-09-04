import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Server as HttpServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomRecordServer, signAgentCard } from '@agent-room/room-persistence';
import type { Room } from '@agent-room/shared';
import { createHostedRoomServer, startHostedRoomServer } from './server.js';
import { HumanSessionAuthority } from './human-sessions.js';

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

function memoryRecords(initial = room()) {
  let current = structuredClone(initial);
  const receipts: Array<{ id: string; roomCode: string; kind: 'receipt'; createdAt: number; payload: Readonly<Record<string, unknown>> }> = [];
  const records = {
    createRoom: vi.fn(), getRoom: vi.fn(async (code: string) => code === current.code ? structuredClone(current) : null),
    updateRoom: vi.fn(async (_code: string, version: number, next: Room) => { if (version !== current.version) return false; current = structuredClone(next); return true; }),
    appendMessage: vi.fn(async () => 1), listMessages: vi.fn(async () => []), close: vi.fn(),
    appendReceipt: vi.fn(async (value: typeof receipts[number]) => { if (receipts.some(item => item.id === value.id)) return false; receipts.push(value); return true; }),
    listReceipts: vi.fn(async () => structuredClone(receipts)),
  } as unknown as RoomRecordServer;
  return { records, current: () => current };
}

function hostedEnv(path: string, extra: Record<string, string | undefined> = {}) {
  return { AGENT_ROOM_TRUST_STORE: path, AGENT_ROOM_HUMAN_SESSION_SECRET: 'h'.repeat(48), AGENT_ROOM_HOST_TOKEN: 'host-test-token', ...extra };
}

async function listenHosted(hosted: Awaited<ReturnType<typeof createHostedRoomServer>>) {
  opened.push(hosted);
  await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
  const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  return `http://127.0.0.1:${address.port}`;
}

function hasUnrestrictedBuildContextInstruction(dockerfile: string): boolean {
  return dockerfile.split(/\r?\n/).some(rawLine => {
    const match = /^\s*(COPY|ADD)\s+(.+)$/i.exec(rawLine);
    if (!match) return false;
    let operands = match[2]!.trim();
    while (operands.startsWith('--')) operands = operands.replace(/^--\S+\s+/, '');
    let paths: string[];
    if (operands.startsWith('[')) {
      try { paths = JSON.parse(operands) as string[]; }
      catch { return true; }
    } else {
      paths = operands.split(/\s+/);
    }
    const sources = paths.slice(0, -1);
    return sources.some(source => source === '.' || source === './');
  });
}

describe('hosted room production entry', () => {
  it('refuses every invalid trust store through the production entry before persistence or listen', async () => {
    const fromEnvironment = vi.spyOn(RoomRecordServer, 'fromEnvironment');
    const listen = vi.spyOn(HttpServer.prototype, 'listen');
    await expect(startHostedRoomServer({})).rejects.toMatchObject({ name: 'trust_store_required' });
    const dir = await mkdtemp(join(tmpdir(), 'bad-trust-')); const bad = join(dir, 'bad.json');
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: join(dir, 'missing.json') })).rejects.toMatchObject({ name: 'trust_store_invalid' });
    await writeFile(bad, '{');
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_invalid' });
    await writeFile(bad, '[]');
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_empty' });
    const keys = generateKeyPairSync('ed25519');
    await writeFile(bad, JSON.stringify([{ fleetId: '', keyId: 'k', publicKey: keys.publicKey.export({ format: 'jwk' }) }]));
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_entry_invalid' });
    await writeFile(bad, JSON.stringify([{ fleetId: 'a', keyId: 'k', publicKey: keys.privateKey.export({ format: 'jwk' }) }]));
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_key_invalid' });
    const unsupported = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(bad, JSON.stringify([{ fleetId: 'a', keyId: 'k', publicKey: unsupported.publicKey.export({ format: 'jwk' }) }]));
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_key_invalid' });
    const pub = keys.publicKey.export({ format: 'jwk' });
    await writeFile(bad, JSON.stringify([{ fleetId: 'a', keyId: 'k', publicKey: pub }, { fleetId: 'a', keyId: 'k', publicKey: pub }]));
    await expect(startHostedRoomServer({ AGENT_ROOM_TRUST_STORE: bad })).rejects.toMatchObject({ name: 'trust_store_duplicate_key' });
    expect(fromEnvironment).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('requires a signed card before participant write and persists one valid authenticated join', async () => {
    const trust = await trustFile(); const memory = memoryRecords(); const records = memory.records;
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(records);
    const hosted = await createHostedRoomServer(hostedEnv(trust.path)); opened.push(hosted);
    await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`;
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    let response = await fetch(`${base}/api/rooms/ROOM1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant }) });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'agent_card_required' });
    expect(memory.current().participants).toHaveLength(0);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    response = await fetch(`${base}/api/rooms/ROOM1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200); expect(memory.current().participants).toHaveLength(1);
    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
    expect(health).toStrictEqual({ ready: true, persistence: 'redis', memberAuth: 'required', trustKeyCount: 1 });
    expect(JSON.stringify(health)).not.toContain(trust.path);
  });

  it('health never exposes persistence credentials', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, {
      UPSTASH_REDIS_REST_URL: 'https://redis-secret.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'redis-token-secret',
      AGENT_ROOM_DATABASE_URL: 'postgres://database-secret.invalid/room',
    }));
    const base = await listenHosted(hosted);
    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toStrictEqual({ ready: true, persistence: 'redis', memberAuth: 'required', trustKeyCount: 1 });
  });

  it('refuses invalid hosted auth configuration before persistence', async () => {
    const trust = await trustFile(); const fromEnvironment = vi.spyOn(RoomRecordServer, 'fromEnvironment');
    await expect(createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_MEMBER_AUTH: 'legacy' })))
      .rejects.toMatchObject({ code: 'member_auth_configuration_invalid' });
    expect(fromEnvironment).not.toHaveBeenCalled();
  });

  it('arms hosted join refusals and accepts only the trusted fleet key', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const post = (code: string, signedCard: ReturnType<typeof signAgentCard>, name = 'Agent A') => fetch(`${base}/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant: { ...participant, name }, signedCard, scheme: 'oauth2' }),
    });
    const alien = generateKeyPairSync('ed25519');
    const invalidCards = [
      signAgentCard(card, 'key-a', alien.privateKey),
      signAgentCard({ ...card, fleetId: 'fleet-b' }, 'key-a', trust.privateKey),
      signAgentCard(card, 'key-b', trust.privateKey),
    ];
    for (const signed of invalidCards) {
      const response = await post('ROOM1', signed);
      expect(response.status).toBe(400);
      expect(await response.json()).toStrictEqual({ error: 'agent_card_signature_invalid' });
    }
    expect((memory.records.updateRoom as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    let response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey), 'Different Agent');
    expect(await response.json()).toStrictEqual({ error: 'agent_card_identity_mismatch' });
    response = await post('MISSING', signAgentCard(card, 'key-a', trust.privateKey));
    expect(response.status).toBe(404); expect(await response.json()).toStrictEqual({ error: 'room_not_found' });

    (memory.records.updateRoom as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey));
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });

    response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey));
    expect(response.status).toBe(200);
    expect(memory.records.updateRoom).toHaveBeenCalledTimes(2);
  });

  it('returns a generic error for unexpected runtime failures', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    (memory.records.getRoom as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('postgres://secret-host:5432'));
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const response = await fetch(`${base}/api/rooms/ROOM1`);
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({ error: 'internal_error' });
  });

  it('serves the built web client and SPA routes from the room-server process', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    const webRoot = await mkdtemp(join(tmpdir(), 'room-web-'));
    await writeFile(join(webRoot, 'index.html'), '<main>authenticated human room</main>');
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_WEB_ROOT: webRoot })));
    const response = await fetch(`${base}/j/ROOM1?invite=secret-capability`);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<main>authenticated human room</main>');
  });

  it('startHostedRoomServer reaches listen on a valid configuration', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const listen = vi.spyOn(HttpServer.prototype, 'listen');
    const hosted = await startHostedRoomServer(hostedEnv(trust.path, { PORT: '0' }));
    opened.push(hosted);
    expect(listen).toHaveBeenCalled();
  });

  it('binds human invite, session, join and post identity while watch tokens stay read-only', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const inviteResponse = await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as { id: string; token: string; joinPath: string };
    expect(invite.joinPath).toBe(`/j/ROOM1?invite=${encodeURIComponent(invite.token)}`);
    const sessionResponse = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Sam', role: 'Lead', color: '#123456', initials: 'SL' }) });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json() as { token: string; participant: Room['participants'][number] };
    expect(session.participant.authenticatedIdentity).toMatchObject({ cardName: 'Sam', fleetId: 'hosted-room', scheme: 'oauth2', keyId: 'host-human-session' });
    expect(memory.current().participants[0]?.authenticatedIdentity).toEqual(session.participant.authenticatedIdentity);
    const message = { id: 'm1', name: 'Sam', client: 'web', text: 'hello', ts: 10 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: 'Bearer read-only-watch-token', 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, name: 'Agent A', client: 'cc' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenCalledWith('ROOM1', message);
    const reuse = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Other', role: '' }) });
    expect(await reuse.json()).toStrictEqual({ error: 'human_invite_used' });
  });

  it('refuses a revoked human invite before participant mutation', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const issued = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { id: string; token: string };
    await fetch(`${base}/api/rooms/ROOM1/human-invites/${issued.id}`, { method: 'DELETE', headers: { authorization: 'Bearer host-test-token' } });
    const response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: issued.token, name: 'Sam' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_invite_revoked' });
    expect(memory.records.updateRoom).not.toHaveBeenCalled();
  });

  it('refuses expired and tampered human sessions by name', async () => {
    const memory = memoryRecords(); let now = 1_000;
    const authority = new HumanSessionAuthority(memory.records, 's'.repeat(48), 'hosted-room', () => now);
    const invite = await authority.issueInvite('ROOM1', 100);
    const session = await authority.exchangeInvite('ROOM1', invite.token, 'Sam', 'Lead');
    expect(authority.verifySession(session.token, 'ROOM1')).toMatchObject({ name: 'Sam', role: 'human' });
    const [payload, signature] = session.token.split('.');
    const tampered = `${payload!.startsWith('a') ? 'b' : 'a'}${payload!.slice(1)}.${signature}`;
    expect(() => authority.verifySession(tampered, 'ROOM1')).toThrowError(expect.objectContaining({ name: 'human_session_invalid' }));
    now = session.expiresAt;
    expect(() => authority.verifySession(session.token, 'ROOM1')).toThrowError(expect.objectContaining({ name: 'human_session_expired' }));
  });

  it('consumer census pins the durable server as the production image entry', async () => {
    const root = new URL('../../../', import.meta.url);
    const docker = await readFile(new URL('Dockerfile', root), 'utf8');
    const railway = await readFile(new URL('railway.json', root), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('apps/room-server/package.json', root), 'utf8'));
    const entry = await readFile(new URL('apps/room-server/src/server.ts', root), 'utf8');
    const joinScreen = await readFile(new URL('apps/web/src/screens/Join.tsx', root), 'utf8');
    const roomHook = await readFile(new URL('apps/web/src/hooks/useRoom.ts', root), 'utf8');
    const webClient = await readFile(new URL('apps/web/src/room-server-client.ts', root), 'utf8');
    expect(docker).toContain('CMD ["node", "apps/room-server/dist/index.js"]');
    expect(docker).toContain('COPY apps/web ./apps/web');
    expect(docker).toContain('-w apps/web');
    expect(docker).not.toContain('apps/hosted-agent/dist/index.js');
    expect(hasUnrestrictedBuildContextInstruction(docker)).toBe(false);
    for (const planted of ['COPY . /app', 'COPY ./ ./', 'ADD . .', 'COPY [".", "/app"]']) {
      expect(hasUnrestrictedBuildContextInstruction(`${docker}\n${planted}`), planted).toBe(true);
    }
    const dockerIgnore = await readFile(new URL('.dockerignore', root), 'utf8');
    for (const pattern of [
      '**/.env', '**/.env.*', '**/*.jwk', '**/*.pem', '**/*.key',
      '.env', '.env.*', '*.jwk', '*.pem', '*.key',
    ]) {
      expect(dockerIgnore.split(/\r?\n/)).toContain(pattern);
    }
    expect(railway).toContain('apps/room-server/dist/index.js');
    expect(pkg.dependencies['@agent-room/room-persistence']).toBe('*');
    expect(entry).toContain('RoomRecordServer.fromEnvironment');
    expect(entry).toContain("env.AGENT_ROOM_WEB_ROOT ?? 'apps/web/dist'");
    expect(joinScreen).toContain('exchangeHumanInvite');
    expect(roomHook).toContain('appendHostedMessage');
    expect(`${joinScreen}\n${roomHook}`).not.toContain('@agent-room/upstash-client');
    expect(webClient).toContain('VITE_ROOM_SERVER_BASE_URL');
  });

  it('keypair tool separates private and public custody without leaking key bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-keys-'));
    const privatePath = join(dir, 'fleet-private.json'); const trustPath = join(dir, 'trust.json');
    const script = new URL('../../../scripts/generate-fleet-keypair.mjs', import.meta.url);
    const result = await execFileAsync(process.execPath, [script.pathname, 'fleet-a', 'key-a', privatePath, trustPath]);
    const privateJwk = JSON.parse(await readFile(privatePath, 'utf8')) as Record<string, unknown>;
    const publicRows = JSON.parse(await readFile(trustPath, 'utf8')) as Array<{ publicKey: Record<string, unknown> }>;
    expect(privateJwk.d).toBeTypeOf('string'); expect(publicRows[0]?.publicKey.d).toBeUndefined();
    await expect(stat(privatePath).then(value => value.mode & 0o777)).resolves.toBe(0o600);
    expect(result.stdout).not.toContain(String(privateJwk.d)); expect(result.stderr).toBe('');
    await expect(execFileAsync(process.execPath, [script.pathname, 'fleet-a', 'key-a', privatePath, trustPath])).rejects.toThrow('refuse_overwrite');
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('hosted room production entry with Postgres', () => {
  it('creates, reads, and authenticates a member through the real hosted entry', async () => {
    const trust = await trustFile(); const code = `PG${Date.now()}`;
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl }));
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`; const value = { ...room(), code };
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify(value) })).status).toBe(201);
    expect((await (await fetch(`${base}/api/rooms/${code}`)).json() as Room).code).toBe(code);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const response = await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200);
    const persisted = await (await fetch(`${base}/api/rooms/${code}`)).json() as Room;
    expect(persisted.participants).toHaveLength(1); expect(persisted.participants[0]?.authenticatedIdentity?.fleetId).toBe('fleet-a');
  });
});
