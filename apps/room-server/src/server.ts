import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { AgentCardVerifier, AuthenticatedRoomJoinServer, MemberJoinError, RoomRecordServer } from '@agent-room/room-persistence';
import type { Message, Room } from '@agent-room/shared';
import { loadTrustStore } from './trust-store.js';
import { HumanSessionAuthority, HumanSessionError } from './human-sessions.js';

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
  const code = value instanceof MemberJoinError || value instanceof HumanSessionError ? value.code : 'internal_error';
  const status = code === 'room_not_found' ? 404 : code === 'internal_error' ? 500 : 400;
  reply(res, status, { error: code });
}

async function serveWeb(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const root = resolve(webRoot);
  const requested = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return reply(res, 404, { error: 'not_found' });
  let path = requested;
  let content: Buffer;
  try { content = await readFile(path); }
  catch { path = resolve(root, 'index.html'); content = await readFile(path); }
  const contentType: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': contentType[extname(path)] ?? 'application/octet-stream' });
  res.end(content);
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
  const humanSecret = env.AGENT_ROOM_HUMAN_SESSION_SECRET;
  if (!humanSecret) throw new HumanSessionError('human_session_secret_required');
  const humans = new HumanSessionAuthority(rooms, humanSecret, env.AGENT_ROOM_HUMAN_ISSUER ?? 'hosted-room');
  const hostToken = env.AGENT_ROOM_HOST_TOKEN;
  if (!hostToken) throw new HumanSessionError('host_token_required');
  const bearer = (req: IncomingMessage): string | undefined => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const requireHost = (req: IncomingMessage): void => {
    const token = bearer(req);
    if (!token || token.length !== hostToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(hostToken))) {
      throw new HumanSessionError('host_auth_required');
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://room.invalid');
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(res, 200, { ready: true, persistence: env.AGENT_ROOM_PERSISTENCE ?? 'redis', memberAuth: 'required', trustKeyCount: trustKeys.length });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveWeb(res, env.AGENT_ROOM_WEB_ROOT ?? 'apps/web/dist', url.pathname);
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        requireHost(req); const room = await body(req) as Room; await rooms.createRoom(room); return reply(res, 201, room);
      }
      const inviteMatch = /^\/api\/rooms\/([^/]+)\/human-invites(?:\/([^/]+))?$/.exec(url.pathname);
      if (inviteMatch) {
        requireHost(req);
        const code = decodeURIComponent(inviteMatch[1]!); const inviteId = inviteMatch[2] && decodeURIComponent(inviteMatch[2]);
        if (req.method === 'POST' && !inviteId) {
          const invite = await humans.issueInvite(code);
          return reply(res, 201, { ...invite, joinPath: `/j/${encodeURIComponent(code)}?invite=${encodeURIComponent(invite.token)}` });
        }
        if (req.method === 'DELETE' && inviteId) { await humans.revokeInvite(code, inviteId); return reply(res, 200, { revoked: true }); }
        return reply(res, 405, { error: 'method_not_allowed' });
      }
      const sessionMatch = /^\/api\/rooms\/([^/]+)\/human-session$/.exec(url.pathname);
      if (req.method === 'POST' && sessionMatch) {
        const code = decodeURIComponent(sessionMatch[1]!);
        const input = await body(req) as { inviteToken?: string; name?: string; role?: string; color?: string; initials?: string };
        const issued = await humans.exchangeInvite(code, input.inviteToken ?? '', input.name ?? '', input.role ?? '');
        const room = await rooms.getRoom(code);
        if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
        if (room.participants.some(item => item.name === issued.identity.cardName)) throw new HumanSessionError('human_name_taken');
        const participant = { name: issued.identity.cardName, role: 'human', color: input.color ?? '#555555', initials: input.initials ?? 'HU', client: 'web' as const, joinedAt: issued.identity.verifiedAt, lastSeenAt: issued.identity.verifiedAt, authenticatedIdentity: issued.identity };
        const next = { ...room, version: room.version + 1, participants: [...room.participants, participant] };
        if (!await rooms.updateRoom(code, room.version, next)) throw new HumanSessionError('room_version_conflict');
        return reply(res, 200, { ...issued, participant });
      }
      const watchMatch = /^\/api\/rooms\/([^/]+)\/watch-links$/.exec(url.pathname);
      if (req.method === 'POST' && watchMatch) {
        requireHost(req);
        const requestedTtl = Number(url.searchParams.get('ttlMs') ?? 15 * 60_000);
        const ttlMs = Number.isSafeInteger(requestedTtl) && requestedTtl > 0 && requestedTtl <= 15 * 60_000 ? requestedTtl : 15 * 60_000;
        return reply(res, 201, await humans.issueWatch(decodeURIComponent(watchMatch[1]!), ttlMs));
      }
      const match = /^\/api\/rooms\/([^/]+)(?:\/(join|messages))?$/.exec(url.pathname);
      if (!match) return reply(res, 404, { error: 'not_found' });
      const code = decodeURIComponent(match[1]!); const action = match[2];
      if (req.method === 'GET' && !action) {
        const room = await rooms.getRoom(code); return room ? reply(res, 200, room) : reply(res, 404, { error: 'room_not_found' });
      }
      if (req.method === 'POST' && action === 'join') return reply(res, 200, await joins.join(code, await body(req) as never));
      if (req.method === 'POST' && action === 'messages') {
        const session = await humans.verifySession(bearer(req) ?? '', code);
        const message = await body(req) as Message;
        if (message.client !== 'web' || message.name !== session.name) throw new HumanSessionError('human_identity_mismatch');
        const room = await rooms.getRoom(code);
        const member = room?.participants.find(item => item.client === 'web' && item.name === session.name);
        if (!member?.authenticatedIdentity || member.authenticatedIdentity.cardName !== session.name) throw new HumanSessionError('human_membership_required');
        return reply(res, 201, { sequence: await rooms.appendMessage(code, message) });
      }
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
