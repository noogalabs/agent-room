import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomRecordServer } from '@agent-room/room-persistence';
import type { Room } from '@agent-room/shared';
import { createHostedRoomServer } from '../../room-server/src/server.js';
import { registerTools } from '../src/tools.js';
import { signedCardForParticipant } from '../src/agentIdentity.js';

const opened: Array<Awaited<ReturnType<typeof createHostedRoomServer>>> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function records() {
  const rooms = new Map<string, Room>(); const receipts: any[] = [];
  return {
    createRoom: vi.fn(async (room: Room) => { rooms.set(room.code, structuredClone(room)); }),
    getRoom: vi.fn(async (code: string) => structuredClone(rooms.get(code) ?? null)),
    updateRoom: vi.fn(async (code: string, version: number, room: Room) => { if (rooms.get(code)?.version !== version) return false; rooms.set(code, structuredClone(room)); return true; }),
    appendMessage: vi.fn(async () => 1), listMessages: vi.fn(async () => []), close: vi.fn(),
    appendReceipt: vi.fn(async (value: any) => { if (receipts.some(item => item.id === value.id && item.roomCode === value.roomCode)) return false; receipts.push(value); return true; }),
    listReceipts: vi.fn(async (code: string) => receipts.filter(item => item.roomCode === code)),
  } as unknown as RoomRecordServer;
}

function harness() {
  const handlers = new Map<unknown, (request: any) => Promise<any>>();
  const server = { setRequestHandler(schema: unknown, handler: (request: any) => Promise<any>) { handlers.set(schema, handler); }, sendLoggingMessage: async () => {} } as unknown as Server;
  registerTools(server);
  return (name: string, args: Record<string, unknown>) => handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });
}

describe('hosted production MCP entry', () => {
  it('refuses an over-permissive fleet private key before signing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-room-mcp-key-')); const privatePath = join(dir, 'private.jwk'); const cardPath = join(dir, 'card.json');
    const keys = generateKeyPairSync('ed25519'); const participant = { name: 'Agent A', role: '', color: '#000', initials: 'AA', client: 'cc' as const, joinedAt: 1, lastSeenAt: 1 };
    await writeFile(cardPath, JSON.stringify({ protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2'] }));
    await writeFile(privatePath, JSON.stringify(keys.privateKey.export({ format: 'jwk' })), { mode: 0o600 }); await chmod(privatePath, 0o644);
    await expect(signedCardForParticipant(participant, { AGENT_ROOM_AGENT_CARD: cardPath, AGENT_ROOM_FLEET_PRIVATE_KEY: privatePath, AGENT_ROOM_FLEET_KEY_ID: 'key-a' })).rejects.toMatchObject({ name: 'agent_identity_configuration_invalid' });
  });

  it('drives room_create and fresh room_join with signed cards and no pre-join read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-room-mcp-hosted-'));
    const keys = generateKeyPairSync('ed25519');
    const trustPath = join(dir, 'trust.json'); const cardPath = join(dir, 'card.json'); const privatePath = join(dir, 'private.jwk');
    const card = { protocolVersion: '0.3', fleetId: 'fleet-a', name: 'Agent A', url: 'https://fleet.invalid/a', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2'] };
    await writeFile(trustPath, JSON.stringify([{ fleetId: 'fleet-a', keyId: 'key-a', publicKey: keys.publicKey.export({ format: 'jwk' }) }]));
    await writeFile(cardPath, JSON.stringify(card)); await writeFile(privatePath, JSON.stringify(keys.privateKey.export({ format: 'jwk' })), { mode: 0o600 });
    const store = records(); vi.spyOn(RoomRecordServer, 'fromEnvironment').mockResolvedValue(store);
    const hosted = await createHostedRoomServer({ AGENT_ROOM_TRUST_STORE: trustPath, AGENT_ROOM_HUMAN_SESSION_SECRET: 's'.repeat(48), AGENT_ROOM_HOST_TOKEN: 'host-token' });
    opened.push(hosted); await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    const address = hosted.server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    vi.stubEnv('AGENT_ROOM_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('AGENT_ROOM_AGENT_CARD', cardPath); vi.stubEnv('AGENT_ROOM_FLEET_PRIVATE_KEY', privatePath); vi.stubEnv('AGENT_ROOM_FLEET_KEY_ID', 'key-a');
    vi.stubEnv('AGENT_ROOM_STATE_FILE', join(dir, 'state.json'));

    const actions: string[] = []; const payloads: Array<Record<string, unknown>> = []; const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) { const payload = JSON.parse(String(init.body)) as Record<string, unknown>; payloads.push(payload); actions.push(String(payload.action)); }
      return nativeFetch(input, init);
    });
    const invoke = harness();
    const created = await invoke('room_create', { topic: 'Hosted', name: 'Agent A', listenAfterJoin: false });
    const createdBody = JSON.parse(created.content[0].text) as { code: string };
    expect(createdBody.code).toBeTruthy();
    expect(actions.slice(0, 3)).toEqual(['create', 'join', 'messages']);
    expect(payloads[0]).toMatchObject({ action: 'create', scheme: 'oauth2', signedCard: { card: { name: 'Agent A' } } });
    expect(payloads[1]).toMatchObject({ action: 'join', scheme: 'oauth2', signedCard: { card: { name: 'Agent A' } } });

    await fetch(`http://127.0.0.1:${address.port}/api/rooms`, { method: 'POST', headers: { authorization: 'Bearer host-token', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'FRESHROOM', topic: 'Fresh', createdBy: 'Host', createdAt: 1, status: 'active', version: 1, participants: [], acceptedMemberAuthSchemes: ['oauth2'] }) });
    actions.length = 0;
    const joined = await invoke('room_join', { code: 'FRESHROOM', name: 'Agent A', listenAfterJoin: false });
    expect(JSON.parse(joined.content[0].text).code).toBe('FRESHROOM');
    expect(actions[0]).toBe('join');
    expect(actions).not.toEqual(expect.arrayContaining(['get']));
    expect(payloads.find(item => item.action === 'join')).toMatchObject({ action: 'join', scheme: 'oauth2', signedCard: { card: { name: 'Agent A' } } });
  });
});
