import type { StarterDisposition, StarterReceipt } from './contracts.js';

const DISPOSITIONS = new Set<StarterDisposition>([
  'declined',
  'verification_failed',
  'bootstrap_failed',
  'bootstrap_completed',
]);

export function createStarterReceipt(
  disposition: StarterDisposition,
  revision: string,
  elapsedMs: number,
  exitCode?: number,
  completedPhases?: number,
): StarterReceipt {
  if (!DISPOSITIONS.has(disposition)) throw new Error('unknown starter disposition');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('receipt revision must be a full lowercase commit SHA');
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('receipt elapsedMs must be a non-negative safe integer');
  if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) throw new Error('receipt exitCode must be a safe integer');
  if (completedPhases !== undefined && (!Number.isSafeInteger(completedPhases) || completedPhases < 0)) {
    throw new Error('receipt completedPhases must be a non-negative safe integer');
  }

  return Object.freeze({
    kind: 'bootstrap_receipt',
    disposition,
    revision,
    elapsedMs,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(completedPhases === undefined ? {} : { completedPhases }),
  });
}
