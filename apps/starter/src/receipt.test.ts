import { describe, expect, it } from 'vitest';
import { createStarterReceipt } from './receipt.js';

const revision = 'a'.repeat(40);

describe('createStarterReceipt', () => {
  it('emits only the non-secret receipt schema', () => {
    const receipt = createStarterReceipt('bootstrap_completed', revision, 1250, 0, 13);

    expect(receipt).toEqual({
      kind: 'bootstrap_receipt',
      disposition: 'bootstrap_completed',
      revision,
      elapsedMs: 1250,
      exitCode: 0,
      completedPhases: 13,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      'completedPhases', 'disposition', 'elapsedMs', 'exitCode', 'kind', 'revision',
    ]);
  });

  it('cannot carry extra untyped secret-bearing arguments', () => {
    const untypedCreate = createStarterReceipt as (...args: unknown[]) => unknown;
    const receipt = untypedCreate(
      'bootstrap_completed',
      revision,
      1,
      0,
      13,
      { stdout: 'ROOM_ACCESS_TOKEN=secret', env: { API_KEY: 'secret' } },
    );

    expect(JSON.stringify(receipt)).not.toMatch(/ROOM_ACCESS_TOKEN|API_KEY|secret|stdout|env/);
  });

  it.each([
    ['unknown', revision, 1],
    ['bootstrap_completed', 'main', 1],
    ['bootstrap_completed', revision, -1],
    ['bootstrap_completed', revision, 1.5],
  ])('refuses invalid terminal evidence at runtime: %j', (disposition, inputRevision, elapsedMs) => {
    const untypedCreate = createStarterReceipt as (...args: unknown[]) => unknown;
    expect(() => untypedCreate(disposition, inputRevision, elapsedMs)).toThrow();
  });
});
