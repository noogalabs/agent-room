import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { AgentCardVerifier, AuthenticatedRoomJoinServer, MemberJoinError, RoomRecordServer } from '@agent-room/room-persistence';
import { extractArtifacts, type Message, type ReplyMode, type ReplyModeConfig, type Room, type RoomReport } from '@agent-room/shared';
import { hydrateTrustKeys, loadStoredTrustStore, TrustStoreError, validateStoredTrustKeys } from './trust-store.js';
import { HumanSessionAuthority, HumanSessionError } from './human-sessions.js';
import { canonicalHumanMessage, resolveSessionParticipant } from './human-message-identity.js';

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
  const code = value instanceof MemberJoinError || value instanceof HumanSessionError || value instanceof TrustStoreError ? value.code : 'internal_error';
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
  const rooms = await RoomRecordServer.fromEnvironment(env);
  let storedTrustKeys = await rooms.listFleetTrustKeys();
  if (storedTrustKeys.length === 0) {
    let seedTrustKeys;
    try { seedTrustKeys = await loadStoredTrustStore(env.AGENT_ROOM_TRUST_STORE); }
    catch (caught) { await rooms.close(); throw caught; }
    if (seedTrustKeys.length === 0) {
      console.warn('agent_room_trust_store_empty: starting with zero trusted fleets');
    }
    for (const key of seedTrustKeys) await rooms.putFleetTrustKey(key);
    storedTrustKeys = await rooms.listFleetTrustKeys();
  }
  const verifier = new AgentCardVerifier(hydrateTrustKeys(storedTrustKeys));
  const refreshTrustKeys = async () => {
    storedTrustKeys = await rooms.listFleetTrustKeys();
    verifier.replaceTrustKeys(hydrateTrustKeys(storedTrustKeys));
  };
  const joins = new AuthenticatedRoomJoinServer(rooms, verifier, 'required');
  const humanSecret = env.AGENT_ROOM_HUMAN_SESSION_SECRET;
  if (!humanSecret) throw new HumanSessionError('human_session_secret_required');
  const humans = new HumanSessionAuthority(rooms, humanSecret, env.AGENT_ROOM_HUMAN_ISSUER ?? 'hosted-room');
  const hostToken = env.AGENT_ROOM_HOST_TOKEN;
  if (!hostToken) throw new HumanSessionError('host_token_required');
  const adminToken = env.AGENT_ROOM_ADMIN_TOKEN;
  const createRoomExclusive = async (room: Room): Promise<void> => {
    try { await rooms.createRoom(room); }
    catch (caught) {
      if (caught instanceof Error && caught.message.includes('already exists')) throw new HumanSessionError('room_already_exists');
      throw caught;
    }
  };
  const bearer = (req: IncomingMessage): string | undefined => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const requireHost = (req: IncomingMessage): void => {
    const token = bearer(req);
    if (!token || token.length !== hostToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(hostToken))) {
      throw new HumanSessionError('host_auth_required');
    }
  };
  const requireAdmin = (req: IncomingMessage): void => {
    const token = bearer(req);
    if (!adminToken || !token || token.length !== adminToken.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) {
      throw new HumanSessionError('admin_auth_required');
    }
  };
  const authorizeRoomHost = async (req: IncomingMessage, code: string): Promise<void> => {
    const token = bearer(req);
    if (token && token.length === hostToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(hostToken))) return;
    const session = await humans.verifySession(token ?? '', code);
    const room = await rooms.getRoom(code);
    const member = room?.participants.find(item => item.client === 'web' && item.authenticatedIdentity?.cardFingerprint === session.identityFingerprint);
    if (!room || session.role !== 'host' || !member?.authenticatedIdentity || member.authenticatedIdentity.cardFingerprint !== session.identityFingerprint) throw new HumanSessionError('host_auth_required');
  };
  const authorizeRead = async (req: IncomingMessage, url: URL, code: string): Promise<void> => {
    const headerToken = bearer(req);
    if (headerToken?.length === hostToken.length && timingSafeEqual(Buffer.from(headerToken), Buffer.from(hostToken))) return;
    const token = headerToken ?? url.searchParams.get('access') ?? '';
    await humans.verifyReadCapability(token, code);
  };
  const addHuman = async (code: string, input: { inviteToken: string; name: string; role?: string; color?: string; initials?: string; creator?: boolean }) => {
    const room = await rooms.getRoom(code);
    if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
    const cleanName = input.name.trim();
    const roster = await rooms.listReceipts(code);
    if ((!input.creator && cleanName === room.createdBy) || room.participants.some(item => item.name === cleanName) || roster.some(item => item.payload.memberName === cleanName)) throw new HumanSessionError('human_name_taken');
    const issued = await humans.exchangeInvite(code, input.inviteToken, cleanName, input.role ?? '', input.creator === true);
    const participant = { name: issued.identity.cardName, role: input.creator ? 'host' : 'human', color: input.color ?? '#555555', initials: input.initials ?? 'HU', client: 'web' as const, joinedAt: issued.identity.verifiedAt, lastSeenAt: issued.identity.verifiedAt, authenticatedIdentity: issued.identity };
    const next = { ...room, version: room.version + 1, participants: [...room.participants, participant] };
    const rosterReceipt = { id: `member-roster:${issued.identity.cardFingerprint}`, roomCode: code,
      kind: 'receipt', createdAt: participant.joinedAt,
      payload: { memberName: participant.name, memberClient: participant.client } } as const;
    if (!await rooms.updateRoomAndReceipts(code, room.version, next, [],
      [...(issued.redeemedReceipt ? [issued.redeemedReceipt] : []), rosterReceipt])) {
      throw new HumanSessionError('room_version_conflict');
    }
    return { ...issued, participant };
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://room.invalid');
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(res, 200, { ready: true, persistence: env.AGENT_ROOM_PERSISTENCE ?? 'redis', memberAuth: 'required', trustKeyCount: storedTrustKeys.length });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveWeb(res, env.AGENT_ROOM_WEB_ROOT ?? 'apps/web/dist', url.pathname);
      }
      if (req.method === 'POST' && url.pathname === '/api/room') {
        const input = await body(req) as Record<string, any>;
        const code = String(input.code ?? '');
        if (input.action === 'create') {
          const requested = input.participant as Record<string, any>;
          if (!requested?.name || requested.name !== input.createdBy) throw new HumanSessionError('agent_card_identity_mismatch');
          const identity = verifier.verify(input.signedCard, input.scheme);
          if (identity.cardName !== requested.name) throw new HumanSessionError('agent_card_identity_mismatch');
          const generatedCode = randomBytes(6).toString('base64url').toUpperCase();
          const room: Room = { code: generatedCode, topic: String(input.topic ?? '').trim(), createdBy: requested.name, createdAt: Date.now(), status: 'active', version: 1, participants: [], acceptedMemberAuthSchemes: ['oauth2'] };
          if (!room.topic) throw new HumanSessionError('room_topic_required');
          await createRoomExclusive(room);
          return reply(res, 200, { room, hostKey: '' });
        }
        if (input.action === 'join') {
          await refreshTrustKeys();
          const participant = await joins.join(code, input as never);
          return reply(res, 200, { room: await rooms.getRoom(code), participant, participantToken: (await humans.issueAgentSession(code, participant.authenticatedIdentity!)).token });
        }
        const token = bearer(req) ?? '';
        if (input.action === 'get' || input.action === 'messages' || input.action === 'taskBoard' || input.action === 'sweep') {
          await humans.verifyReadCapability(token, code);
          if (input.action === 'get' || input.action === 'sweep') return reply(res, 200, { room: await rooms.getRoom(code) });
          if (input.action === 'messages') return reply(res, 200, { messages: await rooms.listMessages(code, Number(input.cursor ?? 0)) });
          return reply(res, 200, { board: await rooms.getTaskBoard(code) });
        }
        if (input.action === 'send' || input.action === 'presence') {
          const session = await humans.verifyMemberSession(token, code);
          const room = await rooms.getRoom(code); const member = room?.participants.find(item =>
            item.client === session.client && item.authenticatedIdentity?.cardFingerprint === session.identityFingerprint);
          if (!room || !member?.authenticatedIdentity) throw new HumanSessionError('member_session_required');
          if (input.action === 'presence') {
            const next = { ...room, version: room.version + 1, participants: room.participants.map(item => item === member ? { ...item, lastSeenAt: Date.now(), listenUntil: Number(input.until) } : item) };
            if (!await rooms.updateRoom(code, room.version, next)) throw new HumanSessionError('room_version_conflict');
            return reply(res, 200, {});
          }
          const supplied = input.message as Message;
          if (supplied.name !== member.name || supplied.client !== member.client || supplied.type !== 'msg') throw new HumanSessionError('member_identity_mismatch');
          const message: Message = { id: supplied.id, type: 'msg', name: member.name, role: member.role, initials: member.initials, color: member.color, client: member.client, text: supplied.text, time: supplied.time, attachments: supplied.attachments };
          const sequence = await rooms.appendMessage(code, message);
          return reply(res, 200, { result: { cursor: sequence, message } });
        }
        if (input.action === 'removeParticipant') {
          const session = await humans.verifyMemberSession(token, code);
          const room = await rooms.getRoom(code);
          const member = room?.participants.find(item =>
            item.client === session.client &&
            item.authenticatedIdentity?.cardFingerprint === session.identityFingerprint);
          if (!room || !member?.authenticatedIdentity || input.targetName !== member.name || input.targetClient !== member.client) {
            throw new HumanSessionError('member_session_required');
          }
          const next = { ...room, version: room.version + 1,
            participants: room.participants.filter(item => item !== member) };
          const revocation = await humans.sessionRevocationChange(code, member.authenticatedIdentity.cardFingerprint);
          if (!await rooms.updateRoomAndReceipts(
            code, room.version, next,
            [`member-roster:${member.authenticatedIdentity.cardFingerprint}`, ...revocation.deleteReceiptIds],
            [revocation.receipt],
          )) throw new HumanSessionError('room_version_conflict');
          return reply(res, 200, { room: next });
        }
        throw new HumanSessionError('room_action_invalid');
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        requireHost(req); const room = await body(req) as Room; await createRoomExclusive(room); return reply(res, 201, room);
      }
      if (req.method === 'POST' && url.pathname === '/api/browser-creator-invites') {
        requireHost(req); const input = await body(req) as { code?: string };
        const code = input.code?.trim(); if (!code) throw new HumanSessionError('browser_room_invalid');
        const creator = humans.issueCreator(code);
        return reply(res, 201, { ...creator, createPath: `/new?code=${encodeURIComponent(code)}&creator=${encodeURIComponent(creator.token)}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/browser-rooms') {
        const input = await body(req) as { code?: string; topic?: string; name?: string; role?: string; color?: string; initials?: string };
        if (!input.code || !input.topic?.trim() || !input.name?.trim()) throw new HumanSessionError('browser_room_invalid');
        humans.verifyCreator(bearer(req) ?? '', input.code);
        const room: Room = { code: input.code, topic: input.topic.trim(), createdBy: input.name.trim(), createdAt: Date.now(), status: 'active', version: 1, participants: [], acceptedMemberAuthSchemes: ['oauth2'] };
        await createRoomExclusive(room);
        try {
          const invite = await humans.issueInvite(room.code);
          const joined = await addHuman(room.code, { ...input, inviteToken: invite.token, name: input.name, creator: true });
          return reply(res, 201, { room: await rooms.getRoom(room.code), ...joined });
        } catch (error) {
          await rooms.deleteRoomIfVersion(room.code, room.version);
          throw error;
        }
      }
      const inviteMatch = /^\/api\/rooms\/([^/]+)\/human-invites(?:\/([^/]+))?$/.exec(url.pathname);
      if (inviteMatch) {
        const code = decodeURIComponent(inviteMatch[1]!); const inviteId = inviteMatch[2] && decodeURIComponent(inviteMatch[2]);
        await authorizeRoomHost(req, code);
        if (req.method === 'POST' && !inviteId) {
          const singleUse = url.searchParams.get('singleUse') === 'true';
          const invite = await humans.issueInvite(code, 15 * 60_000, !singleUse);
          return reply(res, 201, { ...invite, joinPath: `/j/${encodeURIComponent(code)}?invite=${encodeURIComponent(invite.token)}` });
        }
        if (req.method === 'DELETE' && inviteId) { await humans.revokeInvite(code, inviteId); return reply(res, 200, { revoked: true }); }
        return reply(res, 405, { error: 'method_not_allowed' });
      }
      const sessionMatch = /^\/api\/rooms\/([^/]+)\/human-session$/.exec(url.pathname);
      if (req.method === 'POST' && sessionMatch) {
        const code = decodeURIComponent(sessionMatch[1]!);
        const input = await body(req) as { inviteToken?: string; name?: string; role?: string; color?: string; initials?: string };
        return reply(res, 200, await addHuman(code, { inviteToken: input.inviteToken ?? '', name: input.name ?? '', role: input.role, color: input.color, initials: input.initials }));
      }
      if (req.method === 'DELETE' && sessionMatch) {
        const code = decodeURIComponent(sessionMatch[1]!);
        const session = await humans.verifySession(bearer(req) ?? '', code);
        const room = await rooms.getRoom(code); const member = resolveSessionParticipant(room, session);
        const next = { ...room!, version: room!.version + 1, participants: room!.participants.filter(item => item !== member) };
        const revocation = await humans.sessionRevocationChange(code, member.authenticatedIdentity!.cardFingerprint);
        if (!await rooms.updateRoomAndReceipts(code, room!.version, next,
          [`member-roster:${member.authenticatedIdentity!.cardFingerprint}`, ...revocation.deleteReceiptIds],
          [revocation.receipt])) {
          throw new HumanSessionError('room_version_conflict');
        }
        return reply(res, 200, next);
      }
      const presenceMatch = /^\/api\/rooms\/([^/]+)\/human-presence$/.exec(url.pathname);
      if (req.method === 'POST' && presenceMatch) {
        const code = decodeURIComponent(presenceMatch[1]!);
        const session = await humans.verifySession(bearer(req) ?? '', code);
        const room = await rooms.getRoom(code); const member = resolveSessionParticipant(room, session);
        const lastSeenAt = Date.now();
        const next = { ...room!, version: room!.version + 1,
          participants: room!.participants.map(item => item === member ? { ...item, lastSeenAt } : item) };
        if (!await rooms.updateRoom(code, room!.version, next)) throw new HumanSessionError('room_version_conflict');
        return reply(res, 200, { lastSeenAt });
      }
      const joinInfoMatch = /^\/api\/rooms\/([^/]+)\/join-info$/.exec(url.pathname);
      if (req.method === 'GET' && joinInfoMatch) {
        const room = await rooms.getRoom(decodeURIComponent(joinInfoMatch[1]!));
        if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
        return reply(res, 200, { code: room.code, topic: room.topic, createdBy: room.createdBy,
          status: room.status, participantCount: room.participants.length });
      }
      const watchMatch = /^\/api\/rooms\/([^/]+)\/watch-links$/.exec(url.pathname);
      if (req.method === 'POST' && watchMatch) {
        requireHost(req);
        const requestedTtl = Number(url.searchParams.get('ttlMs') ?? 15 * 60_000);
        const ttlMs = Number.isSafeInteger(requestedTtl) && requestedTtl > 0 && requestedTtl <= 15 * 60_000 ? requestedTtl : 15 * 60_000;
        return reply(res, 201, await humans.issueWatch(decodeURIComponent(watchMatch[1]!), ttlMs));
      }
      const trustMatch = /^\/api\/fleet-trust(?:\/([^/]+)\/([^/]+))?$/.exec(url.pathname);
      if (trustMatch) {
        requireAdmin(req);
        if (req.method === 'GET' && !trustMatch[1]) return reply(res, 200, storedTrustKeys);
        if (req.method === 'POST' && !trustMatch[1]) {
          const submitted = validateStoredTrustKeys(await body(req));
          if (submitted.length !== 1) throw new TrustStoreError('trust_store_entry_invalid', 'Submit exactly one fleet trust key.');
          const [key] = submitted;
          await rooms.putFleetTrustKey(key!); await refreshTrustKeys();
          return reply(res, 201, key);
        }
        if (req.method === 'DELETE' && trustMatch[1] && trustMatch[2]) {
          const removed = await rooms.deleteFleetTrustKey(decodeURIComponent(trustMatch[1]), decodeURIComponent(trustMatch[2]));
          await refreshTrustKeys();
          return reply(res, 200, { removed });
        }
        return reply(res, 405, { error: 'method_not_allowed' });
      }
      const match = /^\/api\/rooms\/([^/]+)(?:\/(join|messages))?$/.exec(url.pathname);
      const reportMatch = /^\/api\/rooms\/([^/]+)\/report$/.exec(url.pathname);
      if (reportMatch) {
        const code = decodeURIComponent(reportMatch[1]!);
        if (req.method === 'GET') { await authorizeRead(req, url, code); return reply(res, 200, await rooms.getMinutes(code, 'report')); }
        if (req.method === 'POST') {
          await authorizeRoomHost(req, code);
          const room = await rooms.getRoom(code); if (!room) throw new HumanSessionError('room_not_found');
          const messages = await rooms.listMessages(code, 0); const user = messages.filter(item => item.type === 'msg' && item.text.trim());
          const report: RoomReport = { code, topic: room.topic, createdAt: room.createdAt, exportedAt: Date.now(), participants: room.participants.map(({ name, role, client }) => ({ name, role, client })), messageCount: messages.length, summary: `This report captures ${messages.length} message(s) from "${room.topic}".`, highlights: user.slice(0, 8).map(item => `${item.name}: ${item.text.split('\n')[0]}`), decisions: [], actionItems: [], artifacts: extractArtifacts(user), transcript: messages };
          await rooms.putMinutes(code, 'report', report); return reply(res, 200, report);
        }
      }
      const actionMatch = /^\/api\/rooms\/([^/]+)\/actions$/.exec(url.pathname);
      if (req.method === 'POST' && actionMatch) {
        const code = decodeURIComponent(actionMatch[1]!); await authorizeRoomHost(req, code);
        const input = await body(req) as { action?: string; targetName?: string; targetClient?: 'web' | 'cc'; muted?: boolean; mode?: ReplyMode; config?: ReplyModeConfig; message?: Message };
        const room = await rooms.getRoom(code); if (!room) throw new HumanSessionError('room_not_found');
        if (input.action === 'system-message' && input.message) {
          const session = await humans.verifySession(bearer(req) ?? '', code);
          const member = resolveSessionParticipant(room, session);
          const supplied = input.message;
          const message: Message = { id: supplied.id, type: 'sys', name: member.name, role: member.role, initials: member.initials, color: member.color, client: 'web', text: supplied.text, time: supplied.time, attachments: supplied.attachments };
          return reply(res, 200, { sequence: await rooms.appendMessage(code, message) });
        }
        if (input.action === 'turn-state') return reply(res, 200, null);
        if (input.action === 'direct-invoke') return reply(res, 200, false);
        if (input.action === 'skip-current') return reply(res, 200, null);
        let next = room; let removedRosterReceiptId: string | undefined; let removedIdentityFingerprint: string | undefined;
        if (input.action === 'mute') next = { ...room, participants: room.participants.map(item => item.name === input.targetName && item.client === input.targetClient ? { ...item, canSpeak: !input.muted } : item) };
        else if (input.action === 'remove') {
          const removed = room.participants.find(item => item.name === input.targetName && item.client === input.targetClient);
          next = { ...room, participants: room.participants.filter(item => item !== removed) };
          if (removed?.authenticatedIdentity) {
            removedIdentityFingerprint = removed.authenticatedIdentity.cardFingerprint;
            removedRosterReceiptId = `member-roster:${removed.authenticatedIdentity.cardFingerprint}`;
          }
        }
        else if (input.action === 'end') next = { ...room, status: 'ended', endedAt: Date.now() };
        else if (input.action === 'reactivate') next = { ...room, status: 'active', endedAt: undefined };
        else if (input.action === 'reply-mode') next = { ...room, replyMode: input.mode, modeConfig: input.config };
        else throw new HumanSessionError('room_action_invalid');
        next = { ...next, version: room.version + 1 };
        const revocation = removedIdentityFingerprint
          ? await humans.sessionRevocationChange(code, removedIdentityFingerprint) : undefined;
        const updated = removedRosterReceiptId && revocation
          ? await rooms.updateRoomAndReceipts(code, room.version, next,
              [removedRosterReceiptId, ...revocation.deleteReceiptIds], [revocation.receipt])
          : await rooms.updateRoom(code, room.version, next);
        if (!updated) throw new HumanSessionError('room_version_conflict');
        return reply(res, 200, next);
      }
      if (!match) return reply(res, 404, { error: 'not_found' });
      const code = decodeURIComponent(match[1]!); const action = match[2];
      if (req.method === 'GET' && !action) {
        await authorizeRead(req, url, code);
        const room = await rooms.getRoom(code); return room ? reply(res, 200, room) : reply(res, 404, { error: 'room_not_found' });
      }
      if (req.method === 'POST' && action === 'join') {
        await refreshTrustKeys();
        const participant = await joins.join(code, await body(req) as never);
        return reply(res, 200, { ...participant, participantToken: (await humans.issueAgentSession(code, participant.authenticatedIdentity!)).token });
      }
      if (req.method === 'POST' && action === 'messages') {
        const session = await humans.verifySession(bearer(req) ?? '', code);
        const supplied = await body(req) as Message;
        const room = await rooms.getRoom(code);
        const member = resolveSessionParticipant(room, session);
        const message = canonicalHumanMessage(member, supplied);
        return reply(res, 201, { sequence: await rooms.appendMessage(code, message), message });
      }
      if (req.method === 'GET' && action === 'messages') { await authorizeRead(req, url, code); return reply(res, 200, await rooms.listMessages(code, Number(url.searchParams.get('from') ?? 0))); }
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
