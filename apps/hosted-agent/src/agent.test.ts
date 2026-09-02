import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-room/shared';
import { buildBootstrapOffer, HOSTED_IDENTITY, makeMessage, planReplies } from './agent.js';

const REVISION = 'a'.repeat(40);
const REPO = 'https://github.com/noogalabs/agent-room.git';

function inbound(name: string, text: string, role = 'Installer'): Message {
  return { id: 1, type: 'msg', name, initials: 'XX', color: '#000', role, text, client: 'cc', time: 1 };
}

describe('hosted agent offer', () => {
  it('carries only the typed fields with the artifact digest', () => {
    const bytes = new TextEncoder().encode('console.log("bootstrap")');
    const offer = buildBootstrapOffer(REPO, REVISION, bytes);
    expect(Object.keys(offer).sort()).toEqual(['artifactSha256', 'kind', 'repository', 'revision']);
    expect(offer.artifactSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('refuses an unpinned repository or a short revision', () => {
    expect(() => buildBootstrapOffer('http://example.test/x.git', REVISION, new Uint8Array())).toThrow(/pinned/);
    expect(() => buildBootstrapOffer(REPO, 'abc123', new Uint8Array())).toThrow(/full lowercase/);
  });
});

describe('hosted agent replies', () => {
  const now = () => 1_700_000_000_000;

  it('acks a starter receipt with its disposition and never answers itself or an offer', () => {
    const messages = [
      inbound(HOSTED_IDENTITY.name, '[STATUS] hello', 'Ops'),
      inbound('Starter', JSON.stringify({ kind: 'bootstrap_offer', repository: REPO, revision: REVISION, artifactSha256: 'b'.repeat(64) })),
      inbound('Starter', JSON.stringify({ kind: 'bootstrap_receipt', disposition: 'bootstrap_completed', revision: REVISION, elapsedMs: 5, exitCode: 0, completedPhases: 13 })),
    ];
    const plan = planReplies(messages, 4, HOSTED_IDENTITY.name, now);
    expect(plan.cursor).toBe(7);
    expect(plan.replies).toEqual([
      '[RESULT] receipt from Starter: bootstrap_completed revision=aaaaaaaaaaaa phases=13 exit=0 (acked 2023-11-14T22:13:20.000Z)',
    ]);
  });

  it('acks a plain message from another participant as seen', () => {
    const plan = planReplies([inbound('Starter', 'preflight ok')], 0, HOSTED_IDENTITY.name, now);
    expect(plan.replies).toEqual(['[STATUS] seen message from Starter (Installer) at 2023-11-14T22:13:20.000Z']);
  });

  it('builds messages under the hosted identity', () => {
    const message = makeMessage('[STATUS] x', 7);
    expect([message.name, message.client, message.id, message.text]).toEqual([HOSTED_IDENTITY.name, 'cc', 7, '[STATUS] x']);
  });
});
