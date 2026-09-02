import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createLocalServer } from '@agent-room/local-server';
import type { Message } from '@agent-room/shared';
import { buildBootstrapOffer, credentialAnnouncement, HOSTED_IDENTITY, makeMessage } from './agent.js';
import { pollOnce } from './loop.js';

/**
 * Hosted agent: runs the fork room server in-process (public bind behind the
 * platform's TLS edge, token-gated rooms) and acts as the second agent in the
 * room: creates the room once, posts the typed bootstrap offer, then polls and
 * replies to the starter's receipt. Room state and its own credentials persist
 * under the data dir so a restart resumes the same room.
 */
interface HostedState {
  code: string;
  accessToken: string;
  participantToken?: string;
  offerPosted?: boolean;
  cursor: number;
}

const dataDir = resolve(process.env.AGENT_ROOM_DATA_DIR ?? '.agent-room-hosted');
const port = Number(process.env.PORT ?? process.env.AGENT_ROOM_PORT ?? 8787);
const host = process.env.AGENT_ROOM_BIND_HOST ?? '0.0.0.0';
const repository = process.env.AGENT_ROOM_OFFER_REPOSITORY ?? 'https://github.com/noogalabs/agent-room.git';
const revision = process.env.AGENT_ROOM_OFFER_REVISION ?? '';
const artifactPath = resolve(process.env.AGENT_ROOM_ARTIFACT_PATH ?? 'scripts/bootstrap-local.mjs');
const pollMs = Number(process.env.AGENT_ROOM_POLL_MS ?? 2000);
const statePath = join(dataDir, 'hosted-agent.json');

async function main(): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const app = createLocalServer({ dataDir: join(dataDir, 'rooms'), host, port, hostedBind: true });
  const bound = await app.listen();
  const local = `http://127.0.0.1:${bound.port}`;
  process.stdout.write(`hosted room server listening on ${bound.host}:${bound.port}\n`);

  const offer = buildBootstrapOffer(repository, revision, await readFile(artifactPath));
  let state = await loadState();
  if (!state) {
    const created = await post(local, { action: 'create', topic: 'Railway live room test', createdBy: 'Railway Host' }, {});
    state = { code: String(created.room.code), accessToken: String(created.accessToken), cursor: 0 };
    await saveState(state);
    for (const line of credentialAnnouncement(state, statePath, process.env)) process.stdout.write(`${line}\n`);
  }
  if (!state.participantToken) {
    const joined = await post(local, { action: 'join', code: state.code, participant: { ...HOSTED_IDENTITY, joinedAt: 0, lastSeenAt: 0 } }, { access: state.accessToken });
    state.participantToken = String(joined.participantToken);
    await saveState(state);
  }
  const auth = { access: state.accessToken, participant: state.participantToken };
  if (!state.offerPosted) {
    await send(local, state.code, auth, makeMessage(JSON.stringify(offer)));
    await send(local, state.code, auth, makeMessage(`[STATUS] hosted agent online; bootstrap offer posted for ${revision.slice(0, 12)} (artifact ${offer.artifactSha256.slice(0, 12)})`));
    state.offerPosted = true;
    await saveState(state);
  }
  process.stdout.write(`hosted agent in room ${state.code}, polling every ${pollMs}ms\n`);

  const io = {
    read: async (cursor: number) => {
      const result = await post(local, { action: 'messages', code: state.code, cursor }, auth);
      return Array.isArray(result.messages) ? (result.messages as Message[]) : [];
    },
    send: async (message: Message) => {
      await send(local, state.code, auth, message);
      process.stdout.write(`replied: ${message.text}\n`);
    },
  };
  for (;;) {
    try {
      const replies = await pollOnce(state, io);
      if (replies.length > 0) await saveState(state);
    } catch (error) {
      process.stderr.write(`poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function loadState(): Promise<HostedState | null> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as HostedState;
  } catch {
    return null;
  }
}

async function saveState(state: HostedState): Promise<void> {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await chmod(statePath, 0o600);
}

async function post(base: string, payload: object, auth: { access?: string; participant?: string }): Promise<Record<string, any>> {
  const response = await fetch(`${base}/api/room`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth.access ? { 'x-agent-room-access': auth.access } : {}),
      ...(auth.participant ? { authorization: `Bearer ${auth.participant}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`room request failed with status ${response.status}`);
  return (await response.json()) as Record<string, any>;
}

async function send(base: string, code: string, auth: { access: string; participant?: string }, message: Message): Promise<void> {
  await post(base, { action: 'send', code, message }, auth);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
