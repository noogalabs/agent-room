import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutPinnedRevision, type GitInvocation } from './checkout.js';
import { STARTER_REPOSITORY } from './offer.js';

const revision = 'a'.repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function offer(value = revision) {
  return {
    kind: 'bootstrap_offer' as const,
    repository: STARTER_REPOSITORY,
    revision: value,
    artifactSha256: 'b'.repeat(64),
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'starter-checkout-test-'));
  roots.push(value);
  return value;
}

describe('checkoutPinnedRevision', () => {
  it.each(['main', 'a'.repeat(39), 'A'.repeat(40)])('refuses non-pinned ref %s before invoking git', async (ref) => {
    let calls = 0;
    await expect(checkoutPinnedRevision(offer(ref), await root(), async () => {
      calls += 1;
      return '';
    })).rejects.toThrow('full lowercase commit SHA');
    expect(calls).toBe(0);
  });

  it('uses fixed git argv and verifies the immutable checked-out HEAD', async () => {
    const invocations: GitInvocation[] = [];
    const checkout = await checkoutPinnedRevision(offer(), await root(), async (invocation) => {
      invocations.push(invocation);
      return invocation.args[0] === 'rev-parse' ? `${revision}\n` : '';
    });

    expect(invocations.map(({ file, args, cwd }) => ({ file, args, cwd: cwd === checkout ? '<checkout>' : cwd }))).toEqual([
      { file: 'git', args: ['init', '--quiet', checkout], cwd: undefined },
      { file: 'git', args: ['remote', 'add', 'origin', STARTER_REPOSITORY], cwd: '<checkout>' },
      { file: 'git', args: ['fetch', '--depth=1', 'origin', revision], cwd: '<checkout>' },
      { file: 'git', args: ['checkout', '--detach', 'FETCH_HEAD'], cwd: '<checkout>' },
      { file: 'git', args: ['rev-parse', 'HEAD'], cwd: '<checkout>' },
    ]);
  });

  it('fails closed and removes the private checkout when HEAD differs', async () => {
    const stateRoot = await root();
    let checkout = '';
    await expect(checkoutPinnedRevision(offer(), stateRoot, async (invocation) => {
      if (invocation.cwd !== undefined) checkout = invocation.cwd;
      return invocation.args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '';
    })).rejects.toThrow('does not match pinned SHA');
    await expect(access(checkout)).rejects.toThrow();
  });
});
