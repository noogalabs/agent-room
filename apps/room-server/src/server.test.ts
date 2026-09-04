import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Server as HttpServer } from 'node:http';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
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
  let refuseAtomicRemoval = false;
  let refuseAtomicJoin = false;
  const trustKeys: Array<{ fleetId: string; keyId: string; publicKey: Readonly<Record<string, unknown>> }> = [];
  const receipts: Array<{ id: string; roomCode: string; kind: 'receipt'; createdAt: number; payload: Readonly<Record<string, unknown>> }> = [];
  const records = {
    createRoom: vi.fn(async (value: Room) => { if (value.code === current.code) throw new Error(`Room ${value.code} already exists`); current = structuredClone(value); }), getRoom: vi.fn(async (code: string) => code === current.code ? structuredClone(current) : null),
    updateRoom: vi.fn(async (_code: string, version: number, next: Room) => { if (version !== current.version) return false; current = structuredClone(next); return true; }),
    updateRoomAndDeleteReceipt: vi.fn(async (_code: string, version: number, next: Room, id: string) => {
      if (refuseAtomicRemoval || version !== current.version) return false;
      const index = receipts.findIndex(item => item.id === id);
      if (index < 0) return false;
      current = structuredClone(next);
      receipts.splice(index, 1);
      return true;
    }),
    updateRoomAndReplaceReceipt: vi.fn(async (_code: string, version: number, next: Room, receipt: typeof receipts[number], deleteId?: string) => {
      if (refuseAtomicJoin || refuseAtomicRemoval || version !== current.version || receipts.some(item => item.id === receipt.id)) return false;
      const deleteIndex = deleteId ? receipts.findIndex(item => item.id === deleteId) : -1;
      if (deleteId && deleteIndex < 0) return false;
      current = structuredClone(next);
      if (deleteIndex >= 0) receipts.splice(deleteIndex, 1);
      receipts.push(structuredClone(receipt));
      return true;
    }),
    updateRoomAndReceipts: vi.fn(async (_code: string, version: number, next: Room,
      deleteIds: readonly string[], appends: readonly typeof receipts[number][]) => {
      if (refuseAtomicJoin || refuseAtomicRemoval || version !== current.version) return false;
      const deleteIndexes = deleteIds.map(id => receipts.findIndex(item => item.id === id));
      if (deleteIndexes.some(index => index < 0) || appends.some(receipt =>
        !deleteIds.includes(receipt.id) && receipts.some(item => item.id === receipt.id))) return false;
      current = structuredClone(next);
      for (const index of [...deleteIndexes].sort((a, b) => b - a)) receipts.splice(index, 1);
      receipts.push(...structuredClone(appends));
      return true;
    }),
    appendMessage: vi.fn(async () => 1), listMessages: vi.fn(async () => []), close: vi.fn(),
    appendReceipt: vi.fn(async (value: typeof receipts[number]) => { if (receipts.some(item => item.id === value.id)) return false; receipts.push(value); return true; }),
    deleteReceipt: vi.fn(async (_code: string, id: string) => {
      const index = receipts.findIndex(item => item.id === id);
      if (index < 0) return false;
      receipts.splice(index, 1);
      return true;
    }),
    listReceipts: vi.fn(async () => structuredClone(receipts)),
    listFleetTrustKeys: vi.fn(async () => structuredClone(trustKeys)),
    putFleetTrustKey: vi.fn(async (key: typeof trustKeys[number]) => {
      const index = trustKeys.findIndex(item => item.fleetId === key.fleetId && item.keyId === key.keyId);
      if (index >= 0) trustKeys[index] = structuredClone(key); else trustKeys.push(structuredClone(key));
    }),
    deleteFleetTrustKey: vi.fn(async (fleetId: string, keyId: string) => {
      const index = trustKeys.findIndex(item => item.fleetId === fleetId && item.keyId === keyId);
      if (index < 0) return false;
      trustKeys.splice(index, 1); return true;
    }),
  } as unknown as RoomRecordServer;
  return { records, current: () => current, receipts: () => structuredClone(receipts),
    refuseAtomicRemoval: () => { refuseAtomicRemoval = true; },
    refuseAtomicJoin: () => { refuseAtomicJoin = true; }, trustKeys: () => structuredClone(trustKeys) };
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

async function joinedHuman() {
  const trust = await trustFile(); const memory = memoryRecords();
  vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
  const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
  const invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
  const session = await (await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Sam', role: 'Lead', color: '#123456', initials: 'SA' }) })).json() as { token: string };
  return { base, memory, session };
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
  it('refuses every invalid first-boot trust store before listen', async () => {
    const memory = memoryRecords(); const fromEnvironment = vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
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
    expect(fromEnvironment).toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('starts from persisted fleet trust without retaining the seed file as a runtime dependency', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const seeded = await createHostedRoomServer(hostedEnv(trust.path)); await seeded.rooms.close();
    const restarted = await createHostedRoomServer(hostedEnv('/missing-after-first-boot.json'));
    const base = await listenHosted(restarted);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ trustKeyCount: 1 });
  });

  it('keeps the production agent post path server-owned and unchanged', async () => {
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
    const joined = await response.json() as { participantToken: string };
    const agentGet = await fetch(`${base}/api/room`, { method: 'POST', headers: { authorization: `Bearer ${joined.participantToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'get', code: 'ROOM1' }) });
    expect(agentGet.status).toBe(200);
    const agentMessage = { id: 12, type: 'msg', name: 'Agent A', role: 'forged', initials: 'ZZ', color: '#ffffff', client: 'cc', text: 'agent here', time: 12 };
    const agentSend = await fetch(`${base}/api/room`, { method: 'POST', headers: { authorization: `Bearer ${joined.participantToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'send', code: 'ROOM1', message: agentMessage }) });
    expect(agentSend.status).toBe(200);
    expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ name: 'Agent A', client: 'cc', role: '', initials: 'AA', color: '#000000' }));
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
    expect((memory.records.updateRoomAndReplaceReceipt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    let response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey), 'Different Agent');
    expect(await response.json()).toStrictEqual({ error: 'agent_card_identity_mismatch' });
    response = await post('MISSING', signAgentCard(card, 'key-a', trust.privateKey));
    expect(response.status).toBe(404); expect(await response.json()).toStrictEqual({ error: 'room_not_found' });

    (memory.records.updateRoomAndReplaceReceipt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey));
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });

    response = await post('ROOM1', signAgentCard(card, 'key-a', trust.privateKey));
    expect(response.status).toBe(200);
    expect(memory.records.updateRoomAndReplaceReceipt).toHaveBeenCalledTimes(2);
  });

  it('returns a generic error for unexpected runtime failures', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    (memory.records.getRoom as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('postgres://secret-host:5432'));
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const response = await fetch(`${base}/api/rooms/ROOM1`, { headers: { authorization: 'Bearer host-test-token' } });
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

  it('posts typed and empty UI roles, then refuses a revoked session after its first successful post', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const inviteResponse = await fetch(`${base}/api/rooms/ROOM1/human-invites?singleUse=true`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as { id: string; token: string; joinPath: string };
    expect(invite.joinPath).toBe(`/j/ROOM1?invite=${encodeURIComponent(invite.token)}`);
    const sessionResponse = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Sam', role: 'Lead', color: '#123456', initials: 'SL' }) });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json() as { token: string; participant: Room['participants'][number] };
    expect(session.participant.authenticatedIdentity).toMatchObject({ cardName: 'Sam', fleetId: 'hosted-room', scheme: 'oauth2', keyId: 'host-human-session' });
    expect(memory.current().participants[0]?.authenticatedIdentity).toEqual(session.participant.authenticatedIdentity);
    const message = { id: 10, type: 'msg' as const, name: 'Sam', role: 'Lead', initials: 'SL', color: '#123456', client: 'web' as const, text: 'hello', time: 10 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: 'Bearer read-only-watch-token', 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
    const liveWatch = await (await fetch(`${base}/api/rooms/ROOM1/watch-links`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    expect((await fetch(`${base}/api/rooms/ROOM1`, { headers: { authorization: `Bearer ${liveWatch.token}` } })).status).toBe(200);
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${liveWatch.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'watch_session_read_only' });
    expect(await (await fetch(`${base}/api/rooms/ROOM1`)).json()).toStrictEqual({ error: 'human_session_invalid' });
    expect(await (await fetch(`${base}/api/rooms/ROOM1`, { headers: { authorization: 'Bearer malformed' } })).json()).toStrictEqual({ error: 'human_session_invalid' });
    const watch = await (await fetch(`${base}/api/rooms/ROOM1/watch-links?ttlMs=1`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    await new Promise(resolve => setTimeout(resolve, 5));
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${watch.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'watch_session_expired' });
    response = await fetch(`${base}/api/rooms/ROOM1`, { headers: { authorization: `Bearer ${watch.token}` } });
    expect(await response.json()).toStrictEqual({ error: 'watch_session_expired' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, name: 'Agent A', client: 'cc' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, role: 'agent' }) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', { ...message, role: 'human' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, type: 'sys', role: 'host', metadata: { roleAtSend: 'host_directed' } }) });
    expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', { ...message, role: 'human' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, id: 11, role: '' }) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', { ...message, id: 11, role: 'human' });
    await fetch(`${base}/api/rooms/ROOM1/human-invites/${invite.id}`, { method: 'DELETE', headers: { authorization: 'Bearer host-test-token' } });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_revoked' });
    const reuse = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Other', role: '' }) });
    expect(await reuse.json()).toStrictEqual({ error: 'human_invite_revoked' });
  });

  it('production post refuses only a forged human name while the same self-name succeeds', async () => {
    const { base, memory, session } = await joinedHuman();
    const message = { id: 30, type: 'msg', name: 'Other', role: 'Lead', initials: 'SA', color: '#123456', client: 'web', text: 'hello', time: 30 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(400); expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, name: 'Sam' }) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ name: 'Sam', role: 'human', client: 'web' }));
  });

  it('production post refuses only a forged client while the same web client succeeds', async () => {
    const { base, memory, session } = await joinedHuman();
    const message = { id: 31, type: 'msg', name: 'Sam', role: 'Lead', initials: 'SA', color: '#123456', client: 'cc', text: 'hello', time: 31 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(400); expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, client: 'web' }) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ name: 'Sam', client: 'web' }));
  });

  it('production post ignores a forged participant id and supplies the persisted identity', async () => {
    const { base, memory, session } = await joinedHuman();
    const message = { id: 32, type: 'msg', name: 'Sam', role: 'Lead', initials: 'SA', color: '#123456', client: 'web', text: 'hello', time: 32 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, participantId: 'fingerprint-other' }) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ name: 'Sam', role: 'human', client: 'web' }));
    expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.not.objectContaining({ participantId: expect.anything() }));
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ name: 'Sam', role: 'human', client: 'web' }));
  });

  it('production post accepts absent client identity fields and supplies them from the participant', async () => {
    const { base, memory, session } = await joinedHuman();
    const response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 33, type: 'msg', client: 'web', text: 'hello', time: 33 }) });
    expect(response.status).toBe(201);
    expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', { id: 33, type: 'msg', name: 'Sam', role: 'human', initials: 'SA', color: '#123456', client: 'web', text: 'hello', time: 33, attachments: undefined });
  });

  it('production post refuses only supplied metadata while the same request without metadata succeeds', async () => {
    const { base, memory, session } = await joinedHuman();
    const message = { id: 34, type: 'msg', name: 'Sam', role: 'Lead', initials: 'SA', color: '#123456', client: 'web', text: 'hello', time: 34 };
    let response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, metadata: { roleAtSend: 'host_directed' } }) });
    expect(response.status).toBe(400); expect(await response.json()).toStrictEqual({ error: 'human_identity_mismatch' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    expect(response.status).toBe(201); expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ id: 34, name: 'Sam', role: 'human', client: 'web' }));
  });

  it('production post canonicalizes host moderator system and agent display roles to the persisted member role', async () => {
    const { base, memory, session } = await joinedHuman();
    for (const [offset, role] of ['host', 'moderator', 'system', 'agent'].entries()) {
      const response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 40 + offset, type: 'msg', name: 'Sam', role, initials: 'SA', color: '#123456', client: 'web', text: role, time: 40 + offset }) });
      expect(response.status).toBe(201);
      expect(memory.records.appendMessage).toHaveBeenLastCalledWith('ROOM1', expect.objectContaining({ id: 40 + offset, name: 'Sam', role: 'human', client: 'web', text: role }));
    }
  });

  it('refuses to mint a browser creator capability without the host credential', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const unauthenticated = await fetch(`${base}/api/browser-creator-invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ROOM1' }) });
    expect(unauthenticated.status).toBe(400);
    expect(await unauthenticated.json()).toStrictEqual({ error: 'host_auth_required' });
    const wrongToken = await fetch(`${base}/api/browser-creator-invites`, { method: 'POST', headers: { authorization: 'Bearer not-the-host-token', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ROOM1' }) });
    expect(await wrongToken.json()).toStrictEqual({ error: 'host_auth_required' });
    const authorized = await fetch(`${base}/api/browser-creator-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ROOM1' }) });
    expect(authorized.status).toBe(201);
    expect(await authorized.json()).toMatchObject({ token: expect.any(String) });
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

  it('refuses the complete human and agent operation matrix after host removal', async () => {
    const trust = await trustFile();
    const seats = [
      { kind: 'human' as const, name: 'Sam', client: 'web' as const, expected: 'human_session_revoked' },
      { kind: 'agent' as const, name: 'Agent A', client: 'cc' as const, expected: 'agent_session_revoked' },
    ];
    for (const seat of seats) {
      const memory = memoryRecords();
      vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValueOnce(memory.records);
      const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
      let token: string;
      if (seat.kind === 'human') {
        const invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, {
          method: 'POST', headers: { authorization: 'Bearer host-test-token' },
        })).json() as { token: string };
        token = (await (await fetch(`${base}/api/rooms/ROOM1/human-session`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inviteToken: invite.token, name: seat.name, role: 'Lead', color: '#123456', initials: 'SL' }),
        })).json() as { token: string }).token;
      } else {
        const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: seat.name, url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
        token = (await (await fetch(`${base}/api/rooms/ROOM1/join`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ participant: { name: seat.name, role: '', color: '#000000', initials: 'AA', client: seat.client }, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
        })).json() as { participantToken: string }).participantToken;
      }
      expect((await fetch(`${base}/api/rooms/ROOM1/actions`, {
        method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove', targetName: seat.name, targetClient: seat.client }),
      })).status).toBe(200);
      for (const action of ['send', 'messages', 'get'] as const) {
        const response = await fetch(`${base}/api/room`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action, code: 'ROOM1', cursor: 0,
            message: { id: 1, type: 'msg', name: seat.name, role: seat.kind, initials: 'XX', color: '#000000', client: seat.client, text: 'after removal', time: 1 } }),
        });
        expect([seat.kind, action, response.status, await response.json()]).toStrictEqual([
          seat.kind, action, 400, { error: seat.expected },
        ]);
      }
    }
  });

  it('fails human self-leave without changing the room or receipts when atomic cleanup refuses', async () => {
    const { base, memory, session } = await joinedHuman();
    const beforeRoom = memory.current(); const beforeReceipts = memory.receipts();
    (memory.records.updateRoomAndReceipts as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const response = await fetch(`${base}/api/rooms/ROOM1/human-session`, {
      method: 'DELETE', headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });
    expect(memory.current()).toStrictEqual(beforeRoom);
    expect(memory.receipts()).toStrictEqual(beforeReceipts);
  });

  it('fails human join without consuming its invite or partially adding roster state', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites?singleUse=true`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token' },
    })).json() as { token: string };
    const beforeRoom = memory.current(); const beforeReceipts = memory.receipts();
    (memory.records.updateRoomAndReceipts as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const response = await fetch(`${base}/api/rooms/ROOM1/human-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.token, name: 'Atomic Human', role: 'Lead' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });
    expect(memory.current()).toStrictEqual(beforeRoom);
    expect(memory.receipts()).toStrictEqual(beforeReceipts);
  });

  it('fails host removal without changing the room or receipts when atomic cleanup refuses', async () => {
    const { base, memory } = await joinedHuman();
    const beforeRoom = memory.current(); const beforeReceipts = memory.receipts();
    (memory.records.updateRoomAndReceipts as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const response = await fetch(`${base}/api/rooms/ROOM1/actions`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', targetName: 'Sam', targetClient: 'web' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });
    expect(memory.current()).toStrictEqual(beforeRoom);
    expect(memory.receipts()).toStrictEqual(beforeReceipts);
  });

  it('checks human name and historical agent roster before burning an invite', async () => {
    const trust = await trustFile(); const seeded = room();
    seeded.participants = [{ name: 'Sam', role: 'human', color: '#111111', initials: 'SA', client: 'web', joinedAt: 1, lastSeenAt: 1 }];
    const memory = memoryRecords(seeded); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    let invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    let response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Sam' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_name_taken' });
    response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Other' }) });
    expect(response.status).toBe(200);

    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    await fetch(`${base}/api/rooms/ROOM1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    const current = memory.current(); await memory.records.updateRoom('ROOM1', current.version, { ...current, version: current.version + 1, participants: current.participants.filter(item => item.name !== 'Agent A') });
    invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Agent A' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_name_taken' });
  });

  it('posts a browser creator message as the server-owned host identity and issues a capability-bearing lobby invite', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const creator = await (await fetch(`${base}/api/browser-creator-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WEB01' }) })).json() as { token: string; createPath: string };
    expect(creator.createPath).toBe(`/new?code=WEB01&creator=${encodeURIComponent(creator.token)}`);
    const createdResponse = await fetch(`${base}/api/browser-rooms`, { method: 'POST', headers: { authorization: `Bearer ${creator.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WEB01', topic: 'demo', name: 'David', role: 'host', color: '#123456', initials: 'DH' }) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { token: string; participant: Room['participants'][number] };
    expect(created.participant.authenticatedIdentity).toMatchObject({ cardName: 'David', scheme: 'oauth2' });
    expect(created.participant.role).toBe('host');
    const creatorPost = await fetch(`${base}/api/rooms/WEB01/messages`, { method: 'POST', headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 2, type: 'msg', name: 'David', role: 'host', initials: 'DH', color: '#123456', client: 'web', text: 'creator here', time: 2 }) });
    expect(creatorPost.status).toBe(201);
    expect(memory.records.appendMessage).toHaveBeenLastCalledWith('WEB01', { id: 2, type: 'msg', name: 'David', role: 'host', initials: 'DH', color: '#123456', client: 'web', text: 'creator here', time: 2, attachments: undefined });
    const inviteResponse = await fetch(`${base}/api/rooms/WEB01/human-invites`, { method: 'POST', headers: { authorization: `Bearer ${created.token}` } });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as { token: string; joinPath: string };
    expect(invite.joinPath).toBe(`/j/WEB01?invite=${encodeURIComponent(invite.token)}`);
    expect(invite.joinPath).not.toBe('/j/WEB01');
    const forged = { id: 3, type: 'msg', name: 'Agent A', role: 'agent', initials: 'AA', color: '#000', client: 'cc', text: 'host note', time: 3, metadata: { roleAtSend: 'host_directed' } };
    const action = await fetch(`${base}/api/rooms/WEB01/actions`, { method: 'POST', headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'system-message', message: forged }) });
    expect(action.status).toBe(200);
    expect(memory.records.appendMessage).toHaveBeenCalledWith('WEB01', { id: 3, type: 'sys', name: 'David', role: 'host', initials: 'DH', color: '#123456', client: 'web', text: 'host note', time: 3, attachments: undefined });
  });

  it('keeps a room-lifetime human invite reusable, revokes only future joins, refreshes presence, and frees a seat on leave', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const issued = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token' },
    })).json() as { id: string; token: string; expiresAt: number };
    expect(issued.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    const joinHuman = async (name: string, inviteToken = issued.token) => {
      const response = await fetch(`${base}/api/rooms/ROOM1/human-session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken, name, role: '', color: '#123456', initials: name.slice(0, 2).toUpperCase() }),
      });
      return { response, body: await response.json() as { token: string; participant: Room['participants'][number]; error?: string } };
    };
    const alice = await joinHuman('Alice'); const bob = await joinHuman('Bob');
    expect(alice.response.status).toBe(200); expect(bob.response.status).toBe(200);
    expect(memory.current().participants.map(item => item.name)).toEqual(['Alice', 'Bob']);

    const beforePresence = memory.current().participants[0]!.lastSeenAt;
    await new Promise(resolve => setTimeout(resolve, 2));
    const presence = await fetch(`${base}/api/rooms/ROOM1/human-presence`, { method: 'POST', headers: { authorization: `Bearer ${alice.body.token}` } });
    expect(presence.status).toBe(200);
    expect(memory.current().participants[0]!.lastSeenAt).toBeGreaterThan(beforePresence);

    await fetch(`${base}/api/rooms/ROOM1/human-invites/${issued.id}`, { method: 'DELETE', headers: { authorization: 'Bearer host-test-token' } });
    const existingPost = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${alice.body.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 90, type: 'msg', name: 'Alice', role: '', initials: 'AL', color: '#123456', client: 'web', text: 'still seated', time: 90 }) });
    expect(existingPost.status).toBe(201);
    expect((await joinHuman('Charlie')).body).toMatchObject({ error: 'human_invite_revoked' });

    const leave = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'DELETE', headers: { authorization: `Bearer ${alice.body.token}` } });
    expect(leave.status).toBe(200);
    expect(memory.current().participants.map(item => item.name)).toEqual(['Bob']);
    expect(memory.receipts().some(item => item.id === `member-roster:${alice.body.participant.authenticatedIdentity!.cardFingerprint}`)).toBe(false);
    expect(memory.receipts()).toContainEqual(expect.objectContaining({
      id: `human-session:${alice.body.participant.authenticatedIdentity!.cardFingerprint}:revoked`,
      payload: expect.objectContaining({ event: 'human_session_revoked', revokedAt: expect.any(Number) }),
    }));
    const departedPost = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${alice.body.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 91, type: 'msg', name: 'Alice', role: '', initials: 'AL', color: '#123456', client: 'web', text: 'departed', time: 91 }) });
    expect(await departedPost.json()).toStrictEqual({ error: 'human_session_revoked' });
    const revokedRejoin = await joinHuman('Alice');
    expect(revokedRejoin.response.status).toBe(400);
    expect(revokedRejoin.body).toMatchObject({ error: 'human_invite_revoked' });

    const replacementInvite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    const rejoined = await joinHuman('Alice', replacementInvite.token);
    expect(rejoined.response.status).toBe(200);
    expect(memory.current().participants.map(item => item.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('lets a person with the room code use an active room-lifetime invite without exposing the room record', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } });
    const info = await fetch(`${base}/api/rooms/ROOM1/join-info`);
    expect(await info.json()).toStrictEqual({ code: 'ROOM1', topic: 'test', createdBy: 'host', status: 'active', participantCount: 0 });
    const joined = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Code Guest', role: '', color: '#123456', initials: 'CG' }) });
    expect(joined.status).toBe(200);
    expect(memory.current().participants.map(item => item.name)).toEqual(['Code Guest']);
  });

  it('persists host-managed fleet trust, applies it immediately, and keeps revocation across restart', async () => {
    const seed = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const firstBase = await listenHosted(await createHostedRoomServer(hostedEnv(seed.path)));
    const alreadyRunningSecondBase = await listenHosted(await createHostedRoomServer(hostedEnv(seed.path)));
    const creator = await (await fetch(`${firstBase}/api/browser-creator-invites`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'TRUST1' }),
    })).json() as { token: string };
    const created = await (await fetch(`${firstBase}/api/browser-rooms`, {
      method: 'POST', headers: { authorization: `Bearer ${creator.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'TRUST1', topic: 'trust', name: 'Host', role: '', color: '#123456', initials: 'HO' }),
    })).json() as { token: string };
    const addedKeys = generateKeyPairSync('ed25519');
    const added = { fleetId: 'fleet-b', keyId: 'key-b', publicKey: addedKeys.publicKey.export({ format: 'jwk' }) };
    let response = await fetch(`${firstBase}/api/fleet-trust`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([added]),
    });
    expect(await response.json()).toStrictEqual({ error: 'host_auth_required' });
    response = await fetch(`${firstBase}/api/fleet-trust`, {
      method: 'POST', headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }, body: JSON.stringify([added]),
    });
    expect(await response.json()).toStrictEqual({ error: 'host_auth_required' });
    const privateKey = { ...added, keyId: 'private-key', publicKey: addedKeys.privateKey.export({ format: 'jwk' }) };
    response = await fetch(`${firstBase}/api/fleet-trust`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify([privateKey]),
    });
    expect(await response.json()).toStrictEqual({ error: 'trust_store_key_invalid' });
    response = await fetch(`${firstBase}/api/fleet-trust`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify([added]),
    });
    expect(response.status).toBe(201);
    for (const attempt of [
      { method: 'GET', path: '/api/fleet-trust' },
      { method: 'DELETE', path: '/api/fleet-trust/fleet-b/key-b' },
    ]) {
      response = await fetch(`${firstBase}${attempt.path}`, { method: attempt.method, headers: { authorization: `Bearer ${created.token}` } });
      expect(response.status).toBe(400);
      expect(await response.json()).toStrictEqual({ error: 'host_auth_required' });
    }
    const card = { protocolVersion: '0.3', fleetId: 'fleet-b', name: 'Agent B', url: 'https://fleet.invalid/b', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent B', role: '', color: '#000000', initials: 'AB', client: 'cc' as const };
    response = await fetch(`${alreadyRunningSecondBase}/api/rooms/TRUST1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-b', addedKeys.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200);
    const seated = await response.json() as { participantToken: string };
    // Simulate a different replica mutating the shared store: neither running
    // server receives an in-process refresh callback.
    expect(await memory.records.deleteFleetTrustKey('fleet-b', 'key-b')).toBe(true);
    response = await fetch(`${alreadyRunningSecondBase}/api/rooms/TRUST1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-b', addedKeys.privateKey), scheme: 'oauth2' }) });
    expect(await response.json()).toStrictEqual({ error: 'agent_card_signature_invalid' });
    for (const action of ['get', 'messages', 'send'] as const) {
      response = await fetch(`${firstBase}/api/room`, {
        method: 'POST', headers: { authorization: `Bearer ${seated.participantToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, code: 'TRUST1', cursor: 0,
          message: { id: 1, type: 'msg', name: card.name, role: '', color: '#000000', initials: 'AB', client: 'cc', text: 'after revoke', time: 1 } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toStrictEqual({ error: 'agent_fleet_revoked' });
    }
    await memory.records.putFleetTrustKey(added);
    response = await fetch(`${firstBase}/api/fleet-trust/fleet-b/key-b`, { method: 'DELETE', headers: { authorization: 'Bearer host-test-token' } });
    expect(response.status).toBe(200);

    const restartedBase = await listenHosted(await createHostedRoomServer(hostedEnv(seed.path)));
    expect(memory.trustKeys().map(key => `${key.fleetId}:${key.keyId}`)).toEqual(['fleet-a:key-a']);
    expect(await (await fetch(`${restartedBase}/health`)).json()).toMatchObject({ trustKeyCount: 1 });
  });

  it('refuses unauthenticated browser creation and a signed overwrite of a live room', async () => {
    const trust = await trustFile(); const memory = memoryRecords(); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const attempted = { code: 'ROOM1', topic: 'takeover', name: 'Attacker', role: 'host', color: '#000', initials: 'AT' };
    let response = await fetch(`${base}/api/browser-rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempted) });
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
    const creator = await (await fetch(`${base}/api/browser-creator-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ROOM1' }) })).json() as { token: string };
    response = await fetch(`${base}/api/browser-rooms`, { method: 'POST', headers: { authorization: `Bearer ${creator.token}`, 'content-type': 'application/json' }, body: JSON.stringify(attempted) });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_already_exists' });
    expect(memory.current()).toEqual(room());
    expect(memory.current().participants).toHaveLength(0);
  });

  it('binds host authority to the creator session and reserves the creator name before invite burn', async () => {
    const trust = await trustFile(); const memory = memoryRecords(); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const issued = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    let response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: issued.token, name: 'host' }) });
    expect(await response.json()).toStrictEqual({ error: 'human_name_taken' });
    response = await fetch(`${base}/api/rooms/ROOM1/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: issued.token, name: 'Other' }) });
    expect(response.status).toBe(200);
    const other = await response.json() as { token: string };
    response = await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: `Bearer ${other.token}` } });
    expect(await response.json()).toStrictEqual({ error: 'host_auth_required' });
    response = await fetch(`${base}/api/rooms/ROOM1?access=host-test-token`);
    expect(await response.json()).toStrictEqual({ error: 'human_session_invalid' });
  });

  it('refuses a revoked invite capability on room and message reads', async () => {
    const trust = await trustFile(); const memory = memoryRecords(); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const invite = await (await fetch(`${base}/api/rooms/ROOM1/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { id: string; token: string };
    expect((await fetch(`${base}/api/rooms/ROOM1?access=${encodeURIComponent(invite.token)}`)).status).toBe(200);
    await fetch(`${base}/api/rooms/ROOM1/human-invites/${invite.id}`, { method: 'DELETE', headers: { authorization: 'Bearer host-test-token' } });
    let response = await fetch(`${base}/api/rooms/ROOM1?access=${encodeURIComponent(invite.token)}`);
    expect(await response.json()).toStrictEqual({ error: 'human_invite_revoked' });
    response = await fetch(`${base}/api/rooms/ROOM1/messages?access=${encodeURIComponent(invite.token)}`);
    expect(await response.json()).toStrictEqual({ error: 'human_invite_revoked' });
  });

  it('refuses a valid unexpired watch capability on the write path', async () => {
    const trust = await trustFile(); const memory = memoryRecords(); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const watch = await (await fetch(`${base}/api/rooms/ROOM1/watch-links`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string; expiresAt: number };
    expect(watch.expiresAt).toBeGreaterThan(Date.now());
    const response = await fetch(`${base}/api/rooms/ROOM1/messages`, { method: 'POST', headers: { authorization: `Bearer ${watch.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, type: 'msg', name: 'Sam', role: 'human', initials: 'SA', color: '#000', client: 'web', text: 'hello', time: 1 }) });
    expect(await response.json()).toStrictEqual({ error: 'watch_session_read_only' });
  });

  it('refuses participant removal without partially changing the room when atomic roster-receipt deletion fails', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const joined = await (await fetch(`${base}/api/rooms/ROOM1/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
    })).json() as typeof participant & { participantToken: string; authenticatedIdentity: { cardFingerprint: string } };
    const receiptId = `member-roster:${joined.authenticatedIdentity.cardFingerprint}`;
    expect(memory.receipts().map(item => item.id)).toContain(receiptId);
    memory.refuseAtomicRemoval();

    const response = await fetch(`${base}/api/room`, {
      method: 'POST', headers: { authorization: `Bearer ${joined.participantToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'removeParticipant', code: 'ROOM1', requesterName: 'Agent A', targetName: 'Agent A', targetClient: 'cc' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });
    expect(memory.current().participants.map(item => item.name)).toEqual(['Agent A']);
    expect(memory.receipts().map(item => item.id)).toContain(receiptId);
  });

  it('migrates only the verified cards exact legacy roster row and receipt on join', async () => {
    const trust = await trustFile(); const memory = memoryRecords();
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const publicDer = trust.publicKey.export({ type: 'spki', format: 'der' });
    const legacyFingerprint = createHash('sha256').update(card.fleetId).update('\0').update(publicDer).digest('hex');
    const legacyReceiptId = `member-roster:${legacyFingerprint}`;
    const unrelatedReceiptId = 'human-invite:keep-this-revocation:revoked';
    const legacyIdentity = { cardFingerprint: legacyFingerprint, fleetId: card.fleetId, cardName: card.name,
      scheme: 'oauth2' as const, keyId: 'key-a', verifiedAt: 1 };
    const legacyRow = { ...participant, joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: legacyIdentity };
    const memoryWithLegacy = memoryRecords({ ...room(), participants: [legacyRow] });
    await memoryWithLegacy.records.appendReceipt({ id: legacyReceiptId, roomCode: 'ROOM1', kind: 'receipt', createdAt: 1, payload: { memberName: card.name, memberClient: 'cc' } });
    await memoryWithLegacy.records.appendReceipt({ id: unrelatedReceiptId, roomCode: 'ROOM1', kind: 'receipt', createdAt: 1, payload: { inviteId: 'keep-this-revocation' } });
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memoryWithLegacy.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    expect((await fetch(`${base}/api/rooms/ROOM1/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
    })).status).toBe(200);
    const roster = memoryWithLegacy.receipts().filter(item => item.id.startsWith('member-roster:'));
    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).not.toBe(legacyReceiptId);
    expect(roster[0]?.payload.fingerprintVersion).toBe(2);
    expect(memoryWithLegacy.current().participants).toHaveLength(1);
    expect(memoryWithLegacy.current().participants[0]?.authenticatedIdentity?.cardFingerprint)
      .not.toBe(legacyFingerprint);
    expect(memoryWithLegacy.receipts().map(item => item.id)).toContain(unrelatedReceiptId);
  });

  it('refuses an atomic agent join failure without changing the participant or receipt state', async () => {
    const trust = await trustFile();
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: card.name, role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const publicDer = trust.publicKey.export({ type: 'spki', format: 'der' });
    const legacyFingerprint = createHash('sha256').update(card.fleetId).update('\0').update(publicDer).digest('hex');
    const legacyReceiptId = `member-roster:${legacyFingerprint}`;
    const legacyRow = { ...participant, joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: {
      cardFingerprint: legacyFingerprint, fleetId: card.fleetId, cardName: card.name,
      scheme: 'oauth2' as const, keyId: 'key-a', verifiedAt: 1,
    } };
    const memory = memoryRecords({ ...room(), participants: [legacyRow] });
    await memory.records.appendReceipt({ id: legacyReceiptId, roomCode: 'ROOM1', kind: 'receipt', createdAt: 1,
      payload: { memberName: card.name, memberClient: 'cc' } });
    await memory.records.appendReceipt({ id: 'human-invite:still-revoked:revoked', roomCode: 'ROOM1', kind: 'receipt', createdAt: 1,
      payload: { inviteId: 'still-revoked' } });
    const beforeRoom = memory.current(); const beforeReceipts = memory.receipts();
    memory.refuseAtomicJoin();
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const response = await fetch(`${base}/api/rooms/ROOM1/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: 'room_version_conflict' });
    expect(memory.current()).toStrictEqual(beforeRoom);
    expect(memory.receipts()).toStrictEqual(beforeReceipts);
  });

  it('does not let one same-key agent consume another agents legacy receipt', async () => {
    const trust = await trustFile();
    const beeCard = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent Bee', url: 'https://fleet.invalid/bee', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const ceeCard = { ...beeCard, name: 'Agent Cee', url: 'https://fleet.invalid/cee' };
    const publicDer = trust.publicKey.export({ type: 'spki', format: 'der' });
    const legacyFingerprint = createHash('sha256').update(beeCard.fleetId).update('\0').update(publicDer).digest('hex');
    const legacyReceiptId = `member-roster:${legacyFingerprint}`;
    const bee = { name: beeCard.name, role: '', color: '#000000', initials: 'AB', client: 'cc' as const,
      joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: { cardFingerprint: legacyFingerprint,
        fleetId: beeCard.fleetId, cardName: beeCard.name, scheme: 'oauth2' as const, keyId: 'key-a', verifiedAt: 1 } };
    const memory = memoryRecords({ ...room(), participants: [bee] });
    await memory.records.appendReceipt({ id: legacyReceiptId, roomCode: 'ROOM1', kind: 'receipt', createdAt: 1,
      payload: { memberName: bee.name, memberClient: bee.client } });
    vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(memory.records);
    const base = await listenHosted(await createHostedRoomServer(hostedEnv(trust.path)));
    const joinAgent = (card: typeof beeCard) => fetch(`${base}/api/rooms/ROOM1/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant: { name: card.name, role: '', color: '#000000', initials: card.name.slice(-1), client: 'cc' },
        signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
    });

    expect((await joinAgent(ceeCard)).status).toBe(200);
    expect((memory.records.updateRoomAndReplaceReceipt as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[4]).toBeUndefined();
    expect(memory.receipts().map(item => item.id)).toContain(legacyReceiptId);
    const authority = new HumanSessionAuthority(memory.records, 'h'.repeat(48), 'hosted-room');
    const beeToken = (await authority.issueAgentSession('ROOM1', bee.authenticatedIdentity)).token;
    const leave = await fetch(`${base}/api/room`, { method: 'POST',
      headers: { authorization: `Bearer ${beeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'removeParticipant', code: 'ROOM1', requesterName: bee.name,
        targetName: bee.name, targetClient: bee.client }) });
    expect(leave.status).toBe(200);
    expect(memory.receipts().map(item => item.id)).not.toContain(legacyReceiptId);

    expect((await joinAgent(beeCard)).status).toBe(200);
    expect(memory.current().participants.map(item => item.name).sort()).toEqual(['Agent Bee', 'Agent Cee']);
    const roster = memory.receipts().filter(item => item.id.startsWith('member-roster:'));
    expect(roster).toHaveLength(2);
    expect(roster.every(item => item.payload.fingerprintVersion === 2)).toBe(true);
  });

  it('refuses expired and tampered human sessions by name', async () => {
    const memory = memoryRecords(); let now = 1_000;
    const authority = new HumanSessionAuthority(memory.records, 's'.repeat(48), 'hosted-room', () => now);
    const invite = await authority.issueInvite('ROOM1', 100);
    const session = await authority.exchangeInvite('ROOM1', invite.token, 'Sam', 'Lead');
    await expect(authority.verifySession(session.token, 'ROOM1')).resolves.toMatchObject({ name: 'Sam', role: 'human' });
    const [payload, signature] = session.token.split('.');
    const tampered = `${payload!.startsWith('a') ? 'b' : 'a'}${payload!.slice(1)}.${signature}`;
    await expect(authority.verifySession(tampered, 'ROOM1')).rejects.toMatchObject({ name: 'human_session_invalid' });
    now = session.expiresAt;
    await expect(authority.verifySession(session.token, 'ROOM1')).rejects.toMatchObject({ name: 'human_session_expired' });
    const legacyPayload = Buffer.from(JSON.stringify({ purpose: 'session', roomCode: 'ROOM1', id: 'old', expiresAt: now + 100, name: 'Sam', role: 'human', client: 'web' })).toString('base64url');
    const legacy = `${legacyPayload}.${createHmac('sha256', 's'.repeat(48)).update(legacyPayload).digest('base64url')}`;
    await expect(authority.verifySession(legacy, 'ROOM1')).rejects.toMatchObject({ name: 'human_session_invalid' });
  });

  it('issues a rejoined agent strictly after an identity watermark in the same millisecond', async () => {
    const memory = memoryRecords(); const now = 1_000;
    const identity = { cardFingerprint: 'agent-watermark', fleetId: 'fleet-a', cardName: 'Agent Watermark',
      scheme: 'oauth2' as const, keyId: 'key-a', verifiedAt: now };
    await memory.records.appendReceipt({ id: `human-session:${identity.cardFingerprint}:revoked`,
      roomCode: 'ROOM1', kind: 'receipt', createdAt: now,
      payload: { event: 'human_session_revoked', identityFingerprint: identity.cardFingerprint, revokedAt: now } });
    const authority = new HumanSessionAuthority(memory.records, 'w'.repeat(48), 'hosted-room', () => now);
    const session = await authority.issueAgentSession('ROOM1', identity);
    await expect(authority.verifyAgentSession(session.token, 'ROOM1')).resolves.toMatchObject({
      identityFingerprint: identity.cardFingerprint, issuedAt: now + 1,
    });
  });

  it('consumer census pins the durable server as the production image entry', async () => {
    const root = new URL('../../../', import.meta.url);
    const docker = await readFile(new URL('Dockerfile', root), 'utf8');
    const railway = await readFile(new URL('railway.json', root), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('apps/room-server/package.json', root), 'utf8'));
    const entry = await readFile(new URL('apps/room-server/src/server.ts', root), 'utf8');
    const joinScreen = await readFile(new URL('apps/web/src/screens/Join.tsx', root), 'utf8');
    const lobbyScreen = await readFile(new URL('apps/web/src/screens/Lobby.tsx', root), 'utf8');
    const createScreen = await readFile(new URL('apps/web/src/screens/CreateMeeting.tsx', root), 'utf8');
    const roomScreen = await readFile(new URL('apps/web/src/screens/Room.tsx', root), 'utf8');
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
    expect(lobbyScreen).toContain('issueHostedInvite');
    expect(lobbyScreen).toContain('invite.joinPath');
    expect(lobbyScreen).toContain('revokeHostedInvite');
    expect(lobbyScreen).toContain('listHostedFleetTrust');
    expect(lobbyScreen).toContain('addHostedFleetTrust');
    expect(lobbyScreen).toContain('revokeHostedFleetTrust');
    expect(webClient).toContain('listHostedFleetTrust');
    expect(webClient).toContain('addHostedFleetTrust');
    expect(webClient).toContain('revokeHostedFleetTrust');
    expect(lobbyScreen).not.toContain('`${window.location.origin}/j/${code}`');
    expect(createScreen).toContain('persistHumanSeat');
    expect(joinScreen).toContain('persistHumanSeat');
    expect(roomScreen).toContain('loadHumanSeat');
    expect(roomScreen).toContain('touchHostedHumanPresence');
    expect(roomScreen).toContain('60_000');
    expect(roomScreen).toContain('leaveHostedHumanRoom');
    expect(roomScreen).toContain('clearHumanSeat');
    expect(roomHook).toContain('appendHostedMessage');
    expect(`${joinScreen}\n${roomHook}`).not.toContain('@agent-room/upstash-client');
    expect(webClient).toContain('ENV.roomServerBaseUrl');
    const webFiles = [
      ...(await readdir(new URL('apps/web/src/screens', root))).filter(name => name.endsWith('.tsx')).map(name => new URL(`apps/web/src/screens/${name}`, root)),
      ...(await readdir(new URL('apps/web/src/hooks', root))).filter(name => name.endsWith('.ts')).map(name => new URL(`apps/web/src/hooks/${name}`, root)),
    ];
    const directStorageImports = (await Promise.all(webFiles.map(async path => ({ path: path.pathname, source: await readFile(path, 'utf8') })))).filter(file => file.source.includes('@agent-room/upstash-client'));
    expect(directStorageImports).toStrictEqual([]);
    const envSource = await readFile(new URL('apps/web/src/env.ts', root), 'utf8');
    expect(envSource).toContain('VITE_ROOM_SERVER_BASE_URL');
    expect(envSource).not.toContain('UPSTASH_REDIS_REST_TOKEN');
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
  async function rejectReceiptAppendFor(code: string): Promise<() => Promise<void>> {
    const admin = new Pool({ connectionString: postgresUrl });
    const suffix = `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const functionName = `reject_receipt_append_${suffix}`;
    const triggerName = `reject_receipt_append_${suffix}`;
    const literalCode = code.replaceAll("'", "''");
    await admin.query(`CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.room_code = '${literalCode}' THEN RAISE EXCEPTION 'synthetic append-leg failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await admin.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON agent_room_receipts
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    return async () => {
      await admin.query(`DROP TRIGGER IF EXISTS ${triggerName} ON agent_room_receipts`);
      await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await admin.end();
    };
  }

  async function postgresHosted(code: string) {
    const trust = await trustFile();
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, {
      AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl,
    }));
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: {
      authorization: 'Bearer host-test-token', 'content-type': 'application/json',
    }, body: JSON.stringify({ ...room(), code }) })).status).toBe(201);
    return { base, hosted, trust };
  }

  async function expectAppendFailureRollsBack(
    hosted: Awaited<ReturnType<typeof createHostedRoomServer>>, code: string, action: () => Promise<Response>,
  ) {
    const beforeRoom = await hosted.rooms.getRoom(code); const beforeReceipts = await hosted.rooms.listReceipts(code);
    const restore = await rejectReceiptAppendFor(code);
    try {
      const response = await action();
      expect(response.status).not.toBe(200);
      expect(await hosted.rooms.getRoom(code)).toStrictEqual(beforeRoom);
      expect(await hosted.rooms.listReceipts(code)).toStrictEqual(beforeReceipts);
    } finally { await restore(); }
  }

  it('rolls back human join when its real Postgres roster-receipt append leg fails', async () => {
    const code = `HJ${Date.now()}`; const { base, hosted } = await postgresHosted(code);
    const invite = await (await fetch(`${base}/api/rooms/${code}/human-invites?singleUse=true`, {
      method: 'POST', headers: { authorization: 'Bearer host-test-token' },
    })).json() as { token: string };
    await expectAppendFailureRollsBack(hosted, code, () => fetch(`${base}/api/rooms/${code}/human-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.token, name: 'Append Human', role: 'human' }),
    }));
  });

  it('rolls back agent self-leave when its real Postgres revocation append leg fails', async () => {
    const code = `AL${Date.now()}`; const { base, hosted, trust } = await postgresHosted(code);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent Leave', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const joined = await (await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant: { name: card.name, role: '', color: '#000000', initials: 'AL', client: 'cc' }, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) })).json() as { participantToken: string };
    await expectAppendFailureRollsBack(hosted, code, () => fetch(`${base}/api/room`, { method: 'POST', headers: { authorization: `Bearer ${joined.participantToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'removeParticipant', code, targetName: card.name, targetClient: 'cc' }) }));
  });

  it('rolls back human self-leave when its real Postgres revocation append leg fails', async () => {
    const code = `HL${Date.now()}`; const { base, hosted } = await postgresHosted(code);
    const invite = await (await fetch(`${base}/api/rooms/${code}/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    const joined = await (await fetch(`${base}/api/rooms/${code}/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Human Leave' }) })).json() as { token: string };
    await expectAppendFailureRollsBack(hosted, code, () => fetch(`${base}/api/rooms/${code}/human-session`, { method: 'DELETE', headers: { authorization: `Bearer ${joined.token}` } }));
  });

  it('rolls back host removal when its real Postgres revocation append leg fails', async () => {
    const code = `HR${Date.now()}`; const { base, hosted } = await postgresHosted(code);
    const invite = await (await fetch(`${base}/api/rooms/${code}/human-invites`, { method: 'POST', headers: { authorization: 'Bearer host-test-token' } })).json() as { token: string };
    await fetch(`${base}/api/rooms/${code}/human-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: invite.token, name: 'Host Removed' }) });
    await expectAppendFailureRollsBack(hosted, code, () => fetch(`${base}/api/rooms/${code}/actions`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', targetName: 'Host Removed', targetClient: 'web' }) }));
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: postgresUrl });
    try { await pool.query('TRUNCATE agent_room_fleet_trust_keys'); } finally { await pool.end(); }
  });
  it('creates, reads, and authenticates a member through the real hosted entry', async () => {
    const trust = await trustFile(); const code = `PG${Date.now()}`;
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl }));
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`; const value = { ...room(), code };
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify(value) })).status).toBe(201);
    expect((await (await fetch(`${base}/api/rooms/${code}`, { headers: { authorization: 'Bearer host-test-token' } })).json() as Room).code).toBe(code);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: 'Agent A', role: '', color: '#000000', initials: 'AA', client: 'cc' as const };
    const response = await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
    expect(response.status).toBe(200);
    const persisted = await (await fetch(`${base}/api/rooms/${code}`, { headers: { authorization: 'Bearer host-test-token' } })).json() as Room;
    expect(persisted.participants).toHaveLength(1); expect(persisted.participants[0]?.authenticatedIdentity?.fleetId).toBe('fleet-a');
  });

  it('seats same-fleet agents independently and makes repeat join and leave-rejoin idempotent at the Postgres receipt seam', async () => {
    const trust = await trustFile(); const code = `PI${Date.now()}`;
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl }));
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ ...room(), code }) })).status).toBe(201);
    const join = async (name: string) => {
      const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name, url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
      const participant = { name, role: '', color: '#000000', initials: name.slice(0, 2).toUpperCase(), client: 'cc' as const };
      const response = await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<typeof participant & { joinedAt: number; lastSeenAt: number; authenticatedIdentity: { cardFingerprint: string }; participantToken: string }>;
    };
    const alpha = await join('Agent Alpha');
    const beta = await join('Agent Beta');
    expect(alpha.authenticatedIdentity.cardFingerprint).not.toBe(beta.authenticatedIdentity.cardFingerprint);
    let persisted = await hosted.rooms.getRoom(code);
    expect(persisted?.participants.map(item => item.name)).toEqual(['Agent Alpha', 'Agent Beta']);
    expect((await hosted.rooms.listReceipts(code)).filter(item => item.id.startsWith('member-roster:'))).toHaveLength(2);

    const repeated = await join('Agent Alpha');
    expect(repeated.authenticatedIdentity.cardFingerprint).toBe(alpha.authenticatedIdentity.cardFingerprint);
    expect(repeated.participantToken).not.toBe(alpha.participantToken);
    persisted = await hosted.rooms.getRoom(code);
    expect(persisted?.participants.map(item => item.name)).toEqual(['Agent Alpha', 'Agent Beta']);
    expect((await hosted.rooms.listReceipts(code)).filter(item => item.id.startsWith('member-roster:'))).toHaveLength(2);

    const leave = await fetch(`${base}/api/room`, { method: 'POST', headers: { authorization: `Bearer ${repeated.participantToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'removeParticipant', code, requesterName: 'Agent Alpha', targetName: 'Agent Alpha', targetClient: 'cc' }) });
    expect(leave.status).toBe(200);
    expect((await hosted.rooms.getRoom(code))?.participants.map(item => item.name)).toEqual(['Agent Beta']);
    expect((await hosted.rooms.listReceipts(code)).filter(item => item.id.startsWith('member-roster:'))).toHaveLength(1);

    const rejoined = await join('Agent Alpha');
    expect(rejoined.participantToken).not.toBe(repeated.participantToken);
    expect((await hosted.rooms.getRoom(code))?.participants.map(item => item.name).sort()).toEqual(['Agent Alpha', 'Agent Beta']);
    expect((await hosted.rooms.listReceipts(code)).filter(item => item.id.startsWith('member-roster:'))).toHaveLength(2);
    const rejoinedRead = await fetch(`${base}/api/room`, { method: 'POST',
      headers: { authorization: `Bearer ${rejoined.participantToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'messages', code }) });
    expect(rejoinedRead.status).toBe(200);
    const oldTokenRead = await fetch(`${base}/api/room`, { method: 'POST',
      headers: { authorization: `Bearer ${repeated.participantToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'messages', code }) });
    expect([oldTokenRead.status, await oldTokenRead.json()]).toStrictEqual([
      400, { error: 'agent_session_revoked' },
    ]);
    const removedAgain = await fetch(`${base}/api/rooms/${code}/actions`, { method: 'POST',
      headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', targetName: 'Agent Alpha', targetClient: 'cc' }) });
    expect(removedAgain.status).toBe(200);
    for (const action of ['messages', 'get', 'send'] as const) {
      const revokedAgain = await fetch(`${base}/api/room`, { method: 'POST',
        headers: { authorization: `Bearer ${rejoined.participantToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, code, message: { id: 42, type: 'msg', name: 'Agent Alpha',
          role: 'agent', initials: 'AA', color: '#000000', client: 'cc', text: 'after kick', time: 42 } }) });
      expect([action, revokedAgain.status, await revokedAgain.json()]).toStrictEqual([
        action, 400, { error: 'agent_session_revoked' },
      ]);
    }
    const idempotentRemoval = await fetch(`${base}/api/rooms/${code}/actions`, { method: 'POST',
      headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', targetName: 'Agent Alpha', targetClient: 'cc' }) });
    expect(idempotentRemoval.status).toBe(200);
  });

  it('converges simultaneous first joins of one signed identity on one Postgres seat with two fresh tokens', async () => {
    const trust = await trustFile(); const code = `PC${Date.now()}`;
    const hosted = await createHostedRoomServer(hostedEnv(trust.path, { AGENT_ROOM_PERSISTENCE: 'postgres', AGENT_ROOM_DATABASE_URL: postgresUrl }));
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ ...room(), code }) })).status).toBe(201);
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent Concurrent', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2' as const] };
    const participant = { name: card.name, role: '', color: '#000000', initials: 'AC', client: 'cc' as const };
    const atomicJoin = hosted.rooms.persistence.compareAndSwapRoomAndReplaceReceipt.bind(hosted.rooms.persistence);
    let arrivals = 0; let release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(hosted.rooms.persistence, 'compareAndSwapRoomAndReplaceReceipt').mockImplementation(async (...args) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReady;
      return atomicJoin(...args);
    });
    const request = () => fetch(`${base}/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participant, signedCard: signAgentCard(card, 'key-a', trust.privateKey), scheme: 'oauth2' }),
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const joined = await Promise.all(responses.map(response => response.json() as Promise<{ participantToken: string; authenticatedIdentity: { cardFingerprint: string } }>));
    expect(joined[0]!.participantToken).not.toBe(joined[1]!.participantToken);
    expect(joined[0]!.authenticatedIdentity.cardFingerprint).toBe(joined[1]!.authenticatedIdentity.cardFingerprint);
    expect((await hosted.rooms.getRoom(code))?.participants.map(item => item.name)).toEqual(['Agent Concurrent']);
    expect((await hosted.rooms.listReceipts(code)).filter(item => item.id.startsWith('member-roster:'))).toHaveLength(1);
  });

});
