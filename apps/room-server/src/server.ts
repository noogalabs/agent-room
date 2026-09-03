import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AgentCardVerifier, AuthenticatedRoomJoinServer, MemberJoinError, RoomRecordServer } from '@agent-room/room-persistence';
import type { Message, Room } from '@agent-room/shared';
import { loadTrustStore } from './trust-store.js';

export interface HostedRoomServer { server: Server; rooms: RoomRecordServer; close(): Promise<void> }

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const item = Buffer.from(chunk); size += item.length;
    if (size > 1_048_576) throw new Error('request_too_large');
    chunks.push(item);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function error(res: ServerResponse, value: unknown): void {
  const code = value instanceof MemberJoinError ? value.code : value instanceof Error ? value.message : 'internal_error';
  const status = code === 'room_not_found' ? 404 : code === 'internal_error' ? 500 : 400;
  reply(res, status, { error: code });
}

export async function createHostedRoomServer(
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostedRoomServer> {
  if (env.AGENT_ROOM_MEMBER_AUTH && env.AGENT_ROOM_MEMBER_AUTH !== 'required') {
    throw new MemberJoinError('member_auth_configuration_invalid', 'Hosted member authentication must be required.');
  }
  const trustKeys = await loadTrustStore(env.AGENT_ROOM_TRUST_STORE);
  const rooms = await RoomRecordServer.fromEnvironment(env);
  const joins = new AuthenticatedRoomJoinServer(rooms, new AgentCardVerifier(trustKeys), 'required');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://room.invalid');
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(res, 200, { ready: true, persistence: env.AGENT_ROOM_PERSISTENCE ?? 'redis', memberAuth: 'required', trustKeyCount: trustKeys.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const room = await body(req) as Room; await rooms.createRoom(room); return reply(res, 201, room);
      }
      const match = /^\/api\/rooms\/([^/]+)(?:\/(join|messages))?$/.exec(url.pathname);
      if (!match) return reply(res, 404, { error: 'not_found' });
      const code = decodeURIComponent(match[1]!); const action = match[2];
      if (req.method === 'GET' && !action) {
        const room = await rooms.getRoom(code); return room ? reply(res, 200, room) : reply(res, 404, { error: 'room_not_found' });
      }
      if (req.method === 'POST' && action === 'join') return reply(res, 200, await joins.join(code, await body(req) as never));
      if (req.method === 'POST' && action === 'messages') return reply(res, 201, { sequence: await rooms.appendMessage(code, await body(req) as Message) });
      if (req.method === 'GET' && action === 'messages') return reply(res, 200, await rooms.listMessages(code, Number(url.searchParams.get('from') ?? 0)));
      reply(res, 405, { error: 'method_not_allowed' });
    } catch (caught) { error(res, caught); }
  });
  return { server, rooms, async close() { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await rooms.close(); } };
}

export async function startHostedRoomServer(env = process.env): Promise<HostedRoomServer> {
  const hosted = await createHostedRoomServer(env);
  const port = Number(env.PORT ?? 3000);
  await new Promise<void>((resolve, reject) => { hosted.server.once('error', reject); hosted.server.listen(port, resolve); });
  return hosted;
}
