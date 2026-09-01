import type { BootstrapOffer } from './contracts.js';

export const STARTER_REPOSITORY = 'https://github.com/agent-room-alkl/agent-room.git';

export type OfferValidation =
  | { accepted: true; offer: BootstrapOffer }
  | { accepted: false; reason: string };

const OFFER_KEYS = ['artifactSha256', 'kind', 'repository', 'revision'] as const;

export function parseBootstrapOffer(input: unknown): OfferValidation {
  if (!isRecord(input)) return refused('offer must be an object');

  const keys = Object.keys(input).sort();
  if (keys.length !== OFFER_KEYS.length || keys.some((key, index) => key !== OFFER_KEYS[index])) {
    return refused('offer must contain only the typed bootstrap fields');
  }
  if (input.kind !== 'bootstrap_offer') return refused('unsupported offer kind');
  if (input.repository !== STARTER_REPOSITORY) return refused('repository is not pinned');
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{40}$/.test(input.revision)) {
    return refused('revision must be a full lowercase commit SHA');
  }
  if (typeof input.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.artifactSha256)) {
    return refused('artifact digest must be lowercase SHA-256');
  }

  return {
    accepted: true,
    offer: {
      kind: 'bootstrap_offer',
      repository: STARTER_REPOSITORY,
      revision: input.revision,
      artifactSha256: input.artifactSha256,
    },
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function refused(reason: string): OfferValidation {
  return { accepted: false, reason };
}
