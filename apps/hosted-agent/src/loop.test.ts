import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '@agent-room/local-server';
import type { Message } from '@agent-room/shared';
import { HOSTED_IDENTITY } from './agent.js';
import { pollOnce } from './loop.js';

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(running.splice(0).map((app) => app.close())); });

async function room() {
  const app = createLocalServer({ dataDir: await mkdtemp(join(tmpdir(), 'hosted-loop-')) });
  running.push(app);
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}/api/room`;
  const post = async (payload: object, auth: { access?: string; participant?: string } = {}) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.access ? { 'x-agent-room-access': auth.access } : {}),
        ...(auth.participant ? { authorization: `Bearer ${auth.participant}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return (await response.json()) as Record<string, any>;
  };
  const created = await post({ action: 'create', topic: 't', createdBy: 'Host' });
  const code = String(created.room.code); const access = String(created.accessToken);
  const joinAs = async (name: string, role: string) => {
    const joined = await post({ action: 'join', code, participant: { name, role, color: '#000', initials: 'XX', client: 'cc', joinedAt: 0, lastSeenAt: 0 } }, { access });
    const participant = String(joined.participantToken);
    return (text: string) => post({ action: 'send', code, message: { id: Date.now(), type: 'msg', name, initials: 'XX', color: '#000', role, text, client: 'cc', time: Date.now() } satisfies Message }, { access, participant });
  };
  const hosted = await post({ action: 'join', code, participant: { ...HOSTED_IDENTITY, joinedAt: 0, lastSeenAt: 0 } }, { access });
  const auth = { access, participant: String(hosted.participantToken) };
  return {
    read: async (cursor: number) => (await post({ action: 'messages', code, cursor }, auth)).messages as Message[],
    send: async (message: Message) => { await post({ action: 'send', code, message }, auth); },
    join: joinAs,
  };
}

describe('hosted agent poll loop', () => {
  it('observes an inbound that lands concurrently during the reply batch', async () => {
    const r = await room();
    const starter = await r.join('Starter', 'Installer');
    await starter('first');
    let injected = false;
    const io = {
      read: r.read,
      // A peer's message is appended between our read and our first send: it now
      // occupies the position a naive cursor would assign to our own reply.
      send: async (message: Message) => {
        if (!injected) { injected = true; await starter('concurrent'); }
        await r.send(message);
      },
    };
    const state = { cursor: 0 };
    const first = await pollOnce(state, io);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('seen message from Starter');
    const second = await pollOnce(state, io);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('seen message from Starter');
    const all = await r.read(0);
    expect(all.map((m) => m.text)).toEqual(['first', 'concurrent', first[0], second[0]]);
    // A third cycle re-reads only our own replies and stays silent: no self-talk.
    expect(await pollOnce(state, io)).toEqual([]);
    expect(state.cursor).toBe(4);
  });
});
