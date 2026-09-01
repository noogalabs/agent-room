import type { BootstrapOffer, StarterReceipt } from './contracts.js';
import { verifyBootstrapArtifact, type VerifiedBootstrapArtifact } from './artifact.js';
import { createStarterReceipt } from './receipt.js';
import { runVerifiedBootstrap } from './runner.js';

export interface ExecuteBootstrapDependencies {
  checkout: (offer: BootstrapOffer) => Promise<string>;
  approve: (offer: BootstrapOffer) => Promise<boolean>;
  run?: (artifact: VerifiedBootstrapArtifact) => Promise<number>;
  sendReceipt: (receipt: StarterReceipt) => Promise<void>;
  now?: () => number;
}

export async function executeBootstrapOffer(
  offer: BootstrapOffer,
  dependencies: ExecuteBootstrapDependencies,
): Promise<StarterReceipt> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  let artifact: VerifiedBootstrapArtifact;
  try {
    const repositoryRoot = await dependencies.checkout(offer);
    artifact = await verifyBootstrapArtifact(repositoryRoot, offer);
  } catch {
    return finish('verification_failed');
  }

  if (!await dependencies.approve(offer)) return finish('declined');

  try {
    const exitCode = await (dependencies.run ?? runVerifiedBootstrap)(artifact);
    return finish(exitCode === 0 ? 'bootstrap_completed' : 'bootstrap_failed', exitCode);
  } catch {
    return finish('bootstrap_failed');
  }

  async function finish(
    disposition: Parameters<typeof createStarterReceipt>[0],
    exitCode?: number,
  ): Promise<StarterReceipt> {
    const receipt = createStarterReceipt(disposition, offer.revision, Math.max(0, now() - startedAt), exitCode);
    await dependencies.sendReceipt(receipt);
    return receipt;
  }
}
