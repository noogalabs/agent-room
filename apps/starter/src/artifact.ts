import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { BootstrapOffer } from './contracts.js';

export interface VerifiedBootstrapArtifact {
  readonly path: string;
  readonly repositoryRoot: string;
  readonly sha256: string;
}

const verifiedArtifacts = new WeakSet<object>();

export async function verifyBootstrapArtifact(
  repositoryRoot: string,
  offer: BootstrapOffer,
): Promise<VerifiedBootstrapArtifact> {
  const root = resolve(repositoryRoot);
  const path = resolve(root, 'scripts', 'bootstrap-local.mjs');
  if (!path.startsWith(`${root}${sep}`)) throw new Error('bootstrap artifact escaped repository root');

  const bytes = await readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== offer.artifactSha256) throw new Error('bootstrap artifact digest mismatch');

  const artifact = Object.freeze({ path, repositoryRoot: root, sha256: actual });
  verifiedArtifacts.add(artifact);
  return artifact;
}

export function isVerifiedBootstrapArtifact(input: unknown): input is VerifiedBootstrapArtifact {
  return typeof input === 'object' && input !== null && verifiedArtifacts.has(input);
}
