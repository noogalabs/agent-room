import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from './server.js';

const running: Array<ReturnType<typeof createLocalServer>> = [];
afterEach(async () => { await Promise.all(running.splice(0).map((app) => app.close())); });

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-local-'));
  const app = createLocalServer({ dataDir });
  running.push(app);
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  async function post(payload: object, access?: string, participant?: string) {
    return fetch(`${base}/api/room`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(access ? { 'x-agent-room-access': access } : {}),
        ...(participant ? { authorization: `Bearer ${participant}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  }
  const createdResponse = await post({ action: 'create', topic: 'Pilot', createdBy: 'Host' });
  const created = await createdResponse.json() as any;
  const joinedHostResponse = await post({
    action: 'join', code: created.room.code,
    hostKey: created.hostKey,
    participant: { name: 'Host', role: 'Host', color: '#000', initials: 'HO', client: 'cc', joinedAt: 0, lastSeenAt: 0 },
  }, created.accessToken);
  const joinedHost = await joinedHostResponse.json() as any;
  created.participantToken = joinedHost.participantToken;
  return { dataDir, app, base, post, created };
}

describe('local Pilot-1 server', () => {
  it('requires room access and binds every send to an unforgeable participant token', async () => {
    const { post, created } = await fixture();
    const denied = await post({ action: 'get', code: created.room.code });
    expect(denied.status).toBe(401);

    const joinedResponse = await post({
      action: 'join', code: created.room.code,
      participant: { name: 'Worker', role: '', color: '#000', initials: 'WO', client: 'cc', joinedAt: 0, lastSeenAt: 0 },
    }, created.accessToken);
    const joined = await joinedResponse.json() as any;
    expect(joinedResponse.status).toBe(200);

    const forged = await post({
      action: 'send', code: created.room.code,
      message: { id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000', role: '', text: 'forged', client: 'cc', time: 1 },
    }, created.accessToken, joined.participantToken);
    expect(forged.status).toBe(403);

    const legitimate = await post({
      action: 'send', code: created.room.code,
      message: { id: 2, type: 'msg', name: 'Worker', initials: 'WO', color: '#000', role: '', text: 'real', client: 'cc', time: 2 },
    }, created.accessToken, joined.participantToken);
    expect(legitimate.status).toBe(200);

    const hostImpersonation = await post({
      action: 'join', code: created.room.code,
      participant: { name: 'Host', role: '', color: '#000', initials: 'HO', client: 'web', joinedAt: 0, lastSeenAt: 0 },
    }, created.accessToken);
    expect(hostImpersonation.status).toBe(403);
  });

  it('serializes simultaneous joins without losing either participant', async () => {
    const { post, created } = await fixture();
    const participant = (name: string) => ({ name, role: '', color: '#000', initials: name.slice(0, 2), client: 'cc', joinedAt: 0, lastSeenAt: 0 });
    const [a, b] = await Promise.all([
      post({ action: 'join', code: created.room.code, participant: participant('Alpha') }, created.accessToken),
      post({ action: 'join', code: created.room.code, participant: participant('Beta') }, created.accessToken),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const room = await (await post({ action: 'get', code: created.room.code }, created.accessToken)).json() as any;
    expect(room.room.participants.map((item: any) => item.name).sort()).toEqual(['Alpha', 'Beta', 'Host']);
  });

  it('admits exactly one of two simultaneous joins for the same identity', async () => {
    const { post, created } = await fixture();
    const participant = {
      name: 'Same Agent', role: 'Worker', color: '#123456', initials: 'SA',
      client: 'cc', joinedAt: 0, lastSeenAt: 0,
    };
    const responses = await Promise.all([
      post({ action: 'join', code: created.room.code, participant }, created.accessToken),
      post({ action: 'join', code: created.room.code, participant }, created.accessToken),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect(await rejected.json()).toMatchObject({ error: 'identity_taken' });

    const room = await (await post(
      { action: 'get', code: created.room.code },
      created.accessToken,
    )).json() as any;
    expect(room.room.participants.filter((item: any) =>
      item.name === participant.name && item.client === participant.client
    )).toHaveLength(1);
  });

  it('persists rooms and messages across a server restart without TTL expiry', async () => {
    const { dataDir, app, post, created } = await fixture();
    await post({
      action: 'send', code: created.room.code,
      message: { id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000', role: 'Host', text: 'durable', client: 'cc', time: 1 },
    }, created.accessToken, created.participantToken);
    await app.close();
    running.splice(running.indexOf(app), 1);

    const restarted = createLocalServer({ dataDir });
    running.push(restarted);
    const { port } = await restarted.listen();
    const response = await fetch(`http://127.0.0.1:${port}/api/room`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-room-access': created.accessToken },
      body: JSON.stringify({ action: 'messages', code: created.room.code, cursor: 0 }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).messages[0].text).toBe('durable');
    expect(await readFile(join(dataDir, 'rooms.json'), 'utf8')).toContain('durable');
  });

  it('stores an authenticated attachment on local disk', async () => {
    const { base, created } = await fixture();
    const form = new FormData();
    form.append('roomCode', created.room.code);
    form.append('file', new File(['proof'], 'proof.txt', { type: 'text/plain' }));
    const response = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { 'x-agent-room-access': created.accessToken, authorization: `Bearer ${created.participantToken}` },
      body: form,
    });
    expect(response.status).toBe(201);
    const attachment = await response.json() as any;
    expect(attachment.url).toMatch(/^\/attachments\//);
    // The persisted URL carries no capability; the reader presents the room token as a header.
    expect(attachment.url).not.toContain('access=');
    expect(attachment.url).not.toContain(created.accessToken);
    expect((await fetch(`${base}${attachment.url}`)).status).toBe(403);
    expect(await (await fetch(`${base}${attachment.url}`, { headers: { 'x-agent-room-access': created.accessToken } })).text()).toBe('proof');
    // URLs persisted before this change still resolve with the legacy query form.
    expect(await (await fetch(`${base}${attachment.url}?access=${encodeURIComponent(created.accessToken)}`)).text()).toBe('proof');
  });

  it('serves an authenticated read-only watch page and transcript snapshot', async () => {
    const { base, created } = await fixture();
    const denied = await fetch(`${base}/watch/${created.room.code}`);
    expect(denied.status).toBe(403);

    const watchUrl = `${base}/watch/${created.room.code}?access=${encodeURIComponent(created.accessToken)}`;
    const page = await fetch(watchUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain(`Agent Room ${created.room.code}`);

    const snapshot = await fetch(
      `${base}/watch-data/${created.room.code}?access=${encodeURIComponent(created.accessToken)}`,
    );
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      room: { code: created.room.code, topic: 'Pilot' },
      messages: [],
    });
  });

  it('refuses a non-loopback bind', () => {
    expect(() => createLocalServer({ dataDir: '/tmp/nope', host: '0.0.0.0' })).toThrow(/non-loopback/);
    expect(() => createLocalServer({ dataDir: '/tmp/nope', host: '0.0.0.0', hostedBind: false })).toThrow(/non-loopback/);
  });

  it('accepts a non-loopback bind only under the explicit hosted opt-in', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-hosted-'));
    const app = createLocalServer({ dataDir, host: '0.0.0.0', hostedBind: true });
    const bound = await app.listen();
    try {
      expect(bound.host).toBe('0.0.0.0');
      const created = await fetch(`http://127.0.0.1:${bound.port}/api/room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', topic: 'hosted', createdBy: 'Host' }),
      });
      expect(created.ok).toBe(true);
      const denied = await fetch(`http://127.0.0.1:${bound.port}/api/room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get', code: (await created.json()).room.code }),
      });
      expect(denied.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
