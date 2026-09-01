import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapOffer, StarterReceipt } from './contracts.js';
import { executeBootstrapOffer } from './orchestrator.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'starter-orchestrator-'));
  await mkdir(join(root, 'scripts'));
  const source = 'process.exit(0);\n';
  await writeFile(join(root, 'scripts', 'bootstrap-local.mjs'), source);
  const offer: BootstrapOffer = {
    kind: 'bootstrap_offer',
    repository: 'https://github.com/agent-room-alkl/agent-room.git',
    revision: 'a'.repeat(40),
    artifactSha256: createHash('sha256').update(source).digest('hex'),
  };
  return { root, offer };
}

describe('executeBootstrapOffer', () => {
  it('verifies before requesting approval', async () => {
    const { root, offer } = await fixture();
    const approve = vi.fn(async () => true);
    const run = vi.fn(async () => 0);
    const receipts: StarterReceipt[] = [];

    const receipt = await executeBootstrapOffer({ ...offer, artifactSha256: 'b'.repeat(64) }, {
      checkout: async () => root,
      approve,
      run,
      sendReceipt: async (value) => { receipts.push(value); },
      now: () => 1,
    });

    expect(receipt.disposition).toBe('verification_failed');
    expect(receipts).toEqual([receipt]);
    expect(approve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not run after local approval is declined', async () => {
    const { root, offer } = await fixture();
    const run = vi.fn(async () => 0);

    const receipt = await executeBootstrapOffer(offer, {
      checkout: async () => root,
      approve: async () => false,
      run,
      sendReceipt: async () => undefined,
      now: () => 1,
    });

    expect(receipt.disposition).toBe('declined');
    expect(run).not.toHaveBeenCalled();
  });

  it('records a runner exception as bootstrap_failed instead of dropping the outcome', async () => {
    const { root, offer } = await fixture();
    const receipts: StarterReceipt[] = [];

    const receipt = await executeBootstrapOffer(offer, {
      checkout: async () => root,
      approve: async () => true,
      run: async () => { throw new Error('spawn failed'); },
      sendReceipt: async (value) => { receipts.push(value); },
      now: () => 1,
    });

    expect(receipt.disposition).toBe('bootstrap_failed');
    expect(receipts).toEqual([receipt]);
  });
});
