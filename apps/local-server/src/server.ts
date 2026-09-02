import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Message, MessageAttachment, Participant, Room, Task, TaskBoard } from '@agent-room/shared';
import { DurableStore, hashSecret, secret, type DurableRoom } from './store.js';

export interface LocalServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  /**
   * Hosted deployments (a TLS-terminating platform such as Railway) must opt in
   * explicitly to a non-loopback bind. Default off: the pilot-1 loopback
   * contract holds unless the operator sets this, and room access stays
   * token-gated either way.
   */
  hostedBind?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function roomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  for (let i = 0; i < 9; i++) raw += chars[Math.floor(Math.random() * chars.length)];
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6)}`;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 12 * 1024 * 1024) throw new HttpError(413, 'body_too_large', 'Request exceeds 12 MiB.');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function accessToken(req: IncomingMessage): string {
  const token = req.headers['x-agent-room-access'];
  if (typeof token !== 'string' || !token) throw new HttpError(401, 'room_access_required', 'Room access token required.');
  return token;
}

function participantToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'participant_auth_required', 'Participant bearer token required.');
  return header.slice(7);
}

type RoomDb = { rooms: Record<string, DurableRoom> };

function headerAccess(req: IncomingMessage): string | null {
  const token = req.headers['x-agent-room-access'];
  return typeof token === 'string' && token !== '' ? token : null;
}

const WATCH_TOKEN_TTL_MS = 15 * 60 * 1000;

function watchToken(record: DurableRoom, expiresAt = Date.now() + WATCH_TOKEN_TTL_MS): string {
  const expires = String(expiresAt);
  const signature = createHmac('sha256', record.accessHash)
    .update(`${record.room.code}:${expires}`)
    .digest('base64url');
  return `${expires}.${signature}`;
}

function validWatchToken(record: DurableRoom, token: string | null): boolean {
  if (!token) return false;
  const [expires, signature, extra] = token.split('.');
  if (!expires || !signature || extra || !/^\d+$/.test(expires)) return false;
  const expiry = Number(expires);
  if (!Number.isSafeInteger(expiry) || expiry < Date.now() || expiry > Date.now() + WATCH_TOKEN_TTL_MS) return false;
  const expected = createHmac('sha256', record.accessHash)
    .update(`${record.room.code}:${expires}`)
    .digest('base64url');
  const supplied = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function openRoomForWatch(db: RoomDb, code: string, req: IncomingMessage, url: URL): DurableRoom {
  const access = headerAccess(req) ?? url.searchParams.get('access');
  if (access) return openRoom(db, code, access);
  const record = db.rooms[code];
  const view = url.searchParams.get('view');
  if (!view) throw new HttpError(401, 'room_access_required', 'Room access token required.');
  if (!record || !validWatchToken(record, view)) {
    throw new HttpError(403, 'room_access_denied', 'Invalid room access token.');
  }
  return record;
}

/**
 * Open a room by code AND capability, credential first. A missing token is
 * refused 401 and a wrong one 403 before the code is ever looked up, and a
 * fabricated code gets the same status and body as a real one, so an
 * unauthenticated caller cannot use the response to learn which room codes
 * exist. Only an authenticated caller can observe "not found" (never, in
 * practice: a valid token exists only for a room that exists).
 */
function openRoom(db: RoomDb, code: unknown, suppliedAccess: string | null): DurableRoom {
  if (!suppliedAccess) throw new HttpError(401, 'room_access_required', 'Room access token required.');
  const record = typeof code === 'string' ? db.rooms[code] : undefined;
  if (!record || hashSecret(suppliedAccess) !== record.accessHash) {
    throw new HttpError(403, 'room_access_denied', 'Invalid room access token.');
  }
  return record;
}

function openRoomForRequest(db: RoomDb, code: unknown, req: IncomingMessage): DurableRoom {
  return openRoom(db, code, headerAccess(req));
}

function authorizeParticipant(db: RoomDb, code: unknown, req: IncomingMessage): { record: DurableRoom; participant: Participant } {
  const record = openRoomForRequest(db, code, req);
  const hash = hashSecret(participantToken(req));
  const identity = Object.values(record.participants).find((candidate) => candidate.tokenHash === hash);
  if (!identity) throw new HttpError(403, 'participant_auth_denied', 'Invalid participant token.');
  return { record, participant: identity.participant };
}

export function createLocalServer(options: LocalServerOptions) {
  const host = options.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && options.hostedBind !== true) {
    throw new Error('Local Agent Room refuses non-loopback bind addresses.');
  }
  const store = new DurableStore(options.dataDir);
  const attachmentsDir = join(options.dataDir, 'attachments');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname.startsWith('/watch/')) {
        const code = url.pathname.slice('/watch/'.length);
        const record = await store.read((db) => openRoomForWatch(db, code, req, url));
        // Rotate only a non-empty legacy query capability that authenticated
        // this request. A view-only caller must not renew its own expiry by
        // appending an empty access parameter.
        if (!headerAccess(req) && url.searchParams.get('access')) {
          res.writeHead(302, {
            location: `/watch/${encodeURIComponent(code)}?view=${encodeURIComponent(watchToken(record))}`,
            'cache-control': 'private, no-store',
            'referrer-policy': 'no-referrer',
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          'x-frame-options': 'DENY',
        });
        res.end(watchPage(code, url.searchParams.get('view') ?? watchToken(record)));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/watch-data/')) {
        const code = url.pathname.slice('/watch-data/'.length);
        const snapshot = await store.read((db) => {
          const record = openRoomForWatch(db, code, req, url);
          return {
            room: {
              code: record.room.code,
              topic: record.room.topic,
              status: record.room.status,
              participants: record.room.participants.map(({ name, role, client }) => ({ name, role, client })),
            },
            messages: record.messages.map(({ name, role, client, text, time }) => ({ name, role, client, text, time })),
            board: record.board,
          };
        });
        send(res, 200, snapshot);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/attachments/')) {
        const file = basename(url.pathname);
        const code = file.slice(0, 11);
        // Header first (the persisted URL no longer carries the token); the
        // legacy ?access= form is still honored for URLs persisted before that.
        // Header first (the persisted URL carries no token); legacy ?access= still honored.
        await store.read((db) => { openRoom(db, code, headerAccess(req) ?? url.searchParams.get('access')); });
        const bytes = await readFile(join(attachmentsDir, file));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' });
        res.end(bytes);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const raw = await body(req);
        const request = new Request(`http://${host}/api/upload`, {
          method: 'POST',
          headers: req.headers as HeadersInit,
          body: new Uint8Array(raw),
        });
        const form = await request.formData();
        const code = String(form.get('roomCode') ?? '');
        await store.read((db) => authorizeParticipant(db, code, req));
        const file = form.get('file');
        if (!(file instanceof File)) throw new HttpError(400, 'missing_file', 'Multipart file field required.');
        if (file.size > 10 * 1024 * 1024) throw new HttpError(413, 'file_too_large', 'Attachment exceeds 10 MiB.');
        const id = randomUUID();
        const storedName = `${code}-${id}-${basename(file.name).replace(/[^A-Za-z0-9._-]/g, '_')}`;
        await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
        await writeFile(join(attachmentsDir, storedName), Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        const attachment: MessageAttachment = {
          id, type: file.type.startsWith('image/') ? 'image' : 'file',
          // No capability in the persisted URL: readers send x-agent-room-access.
          url: `/attachments/${storedName}`,
          storageKey: storedName, name: file.name,
          size: file.size, mime: file.type || 'application/octet-stream', uploadedAt: Date.now(),
        };
        send(res, 201, attachment);
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/api/room') throw new HttpError(404, 'not_found', 'Route not found.');
      const input = JSON.parse((await body(req)).toString('utf8')) as Record<string, any>;
      const result = await dispatch(store, req, input);
      send(res, 200, result);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'internal_error', error instanceof Error ? error.message : 'Internal error');
      send(res, known.status, { error: known.code, message: known.message });
    }
  });

  return {
    server,
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unexpected server address.');
      return { host, port: address.port };
    },
    async close(): Promise<void> { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); },
  };
}

function watchPage(code: string, viewToken: string): string {
  const safeCode = JSON.stringify(code).replace(/</g, '\\u003c');
  const safeViewToken = JSON.stringify(viewToken).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Room ${code}</title><style>
body{font:16px system-ui;background:#111827;color:#f9fafb;max-width:850px;margin:auto;padding:24px}
h1{font-size:1.3rem}.meta{color:#9ca3af}.msg{border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#1f2937}
.who{font-weight:700}.time{color:#9ca3af;font-size:.8rem}pre{white-space:pre-wrap;font:inherit;margin:.4rem 0 0}
</style></head><body><h1 id="title">Agent Room ${code}</h1><div id="meta" class="meta">Connecting…</div><main id="messages"></main>
<script>
const code=${safeCode}; const view=${safeViewToken};
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(){
 const response=await fetch('/watch-data/'+encodeURIComponent(code)+'?view='+encodeURIComponent(view),{cache:'no-store'});
 if(!response.ok){document.getElementById('meta').textContent='Access denied';return;}
 const data=await response.json(); document.getElementById('title').textContent=data.room.topic+' — '+data.room.code;
 document.getElementById('meta').textContent=data.room.participants.map(p=>p.name+' ('+p.role+')').join(' · ');
 document.getElementById('messages').innerHTML=data.messages.map(m=>'<article class="msg"><div><span class="who">'+esc(m.name)+'</span> <span class="time">'+new Date(m.time).toLocaleTimeString()+'</span></div><pre>'+esc(m.text)+'</pre></article>').join('');
}
refresh(); setInterval(refresh,1000);
</script></body></html>`;
}

async function dispatch(store: DurableStore, req: IncomingMessage, input: Record<string, any>): Promise<unknown> {
  if (input.action === 'create') {
    const access = secret();
    const hostKey = secret();
    const now = Date.now();
    const code = roomCode();
    const room: Room = {
      code, topic: String(input.topic), createdAt: now, createdBy: String(input.createdBy),
      status: 'active', version: 1, participants: [], replyMode: 'open', hostKeyHash: hashSecret(hostKey),
    };
    await store.transaction((db) => {
      db.rooms[code] = { room, accessHash: hashSecret(access), participants: {}, messages: [], board: { code, tasks: [], version: 1 } };
    });
    const record = await store.read((db) => db.rooms[code]!);
    return {
      room: { ...room, hostKey }, hostKey, accessToken: access,
      watchPath: `/watch/${encodeURIComponent(code)}?view=${encodeURIComponent(watchToken(record))}`,
    };
  }

  if (input.action === 'join') {
    return store.transaction((db) => {
      const record = openRoomForRequest(db, input.code, req);
      const requested = input.participant as Participant;
      if (!requested?.name) throw new HttpError(400, 'bad_participant', 'Participant name required.');
      if (requested.name === record.room.createdBy && hashSecret(String(input.hostKey ?? '')) !== record.room.hostKeyHash) {
        throw new HttpError(403, 'HostNameTakenError', 'Host identity requires the creation secret.');
      }
      const bearer = req.headers.authorization;
      if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
        const existing = Object.values(record.participants).find((candidate) =>
          candidate.tokenHash === hashSecret(bearer.slice(7)) &&
          candidate.participant.name === requested.name && candidate.participant.client === requested.client
        );
        if (existing) return { room: record.room, participant: existing.participant };
      }
      if (record.room.participants.some((item) => item.name === requested.name && item.client === requested.client)) {
        throw new HttpError(409, 'identity_taken', 'Participant identity is already active.');
      }
      const token = secret();
      const id = randomUUID();
      const participant = { ...requested, joinedAt: Date.now(), lastSeenAt: Date.now() };
      record.participants[id] = { id, tokenHash: hashSecret(token), participant };
      record.room.participants.push(participant);
      record.room.version++;
      return { room: record.room, participant, participantToken: token };
    });
  }

  if (input.action === 'get' || input.action === 'messages' || input.action === 'taskBoard') {
    return store.read((db) => {
      const record = openRoomForRequest(db, input.code, req);
      if (input.action === 'get') return { room: record.room };
      if (input.action === 'messages') return { messages: record.messages.slice(Number(input.cursor ?? 0)) };
      return { board: record.board };
    });
  }

  if (input.action === 'send') {
    return store.transaction((db) => {
      const { record, participant: identity } = authorizeParticipant(db, input.code, req);
      const supplied = input.message as Message;
      if (supplied.name !== identity.name || supplied.client !== identity.client) throw new HttpError(403, 'identity_mismatch', 'Message identity does not match authenticated participant.');
      record.messages.push(supplied);
      return { result: { cursor: record.messages.length, message: supplied } };
    });
  }

  if (input.action === 'presence') {
    return store.transaction((db) => {
      const { record, participant: identity } = authorizeParticipant(db, input.code, req);
      if (input.name !== identity.name) throw new HttpError(403, 'identity_mismatch', 'Presence identity mismatch.');
      identity.lastSeenAt = Date.now();
      identity.listenUntil = Number(input.until);
      return {};
    });
  }

  if (input.action === 'taskCreate' || input.action === 'taskClaim' || input.action === 'taskSubmit') {
    return store.transaction((db) => {
      const { record, participant: identity } = authorizeParticipant(db, input.code, req);
      if (String(input.requesterName ?? input.name) !== identity.name) throw new HttpError(403, 'identity_mismatch', 'Task identity mismatch.');
      let task: Task;
      if (input.action === 'taskCreate') {
        task = { id: input.id ?? `T-${String(record.board.tasks.length + 1).padStart(2, '0')}`, title: String(input.title), owner: input.owner, ownerClient: input.ownerClient, verifier: input.verifier, verifierClient: input.verifierClient, dod: input.dod, state: 'todo', createdBy: identity.name, createdAt: Date.now(), updatedAt: Date.now() };
        record.board.tasks.push(task);
      } else {
        task = record.board.tasks.find((item) => item.id === input.id) ?? (() => { throw new HttpError(404, 'TaskNotFoundError', 'Task not found.'); })();
        if (input.action === 'taskClaim') { task.owner = identity.name; task.ownerClient = identity.client; task.state = 'in_progress'; }
        else { task.state = 'awaiting_review'; task.evidence = { fileListing: input.evidence.fileListing, fileExcerpt: input.evidence.fileExcerpt, runOutput: input.evidence.runOutput, exitCode: input.evidence.exitCode, submittedBy: identity.name, submittedClient: identity.client, at: Date.now() }; }
        task.updatedAt = Date.now();
      }
      record.board.version++;
      return { board: record.board, task };
    });
  }

  throw new HttpError(400, 'unsupported_action', `Local Pilot-1 server does not implement action ${String(input.action)}.`);
}
