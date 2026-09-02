import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLocalApproval } from './approval.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('requestLocalApproval', () => {
  it.each(['y', 'Y', ' y '])('allows only an explicit local yes: %j', async (input) => {
    await expect(requestLocalApproval({ readLine: async () => input, timeoutMs: 1_000 })).resolves.toBe(true);
  });

  it.each(['', ' ', 'yes', 'n', 'no', null])('fails closed for non-explicit input or EOF: %j', async (input) => {
    await expect(requestLocalApproval({ readLine: async () => input, timeoutMs: 1_000 })).resolves.toBe(false);
  });

  it('fails closed when local input throws', async () => {
    await expect(requestLocalApproval({
      readLine: async () => { throw new Error('terminal unavailable'); },
      timeoutMs: 1_000,
    })).resolves.toBe(false);
  });

  it('fails closed when local input times out', async () => {
    vi.useFakeTimers();
    const pending = requestLocalApproval({
      readLine: () => new Promise(() => undefined),
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid timeout: %j', async (timeoutMs) => {
    await expect(requestLocalApproval({ readLine: async () => 'y', timeoutMs })).resolves.toBe(false);
  });
});
