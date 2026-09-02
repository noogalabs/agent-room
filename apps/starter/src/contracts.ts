export interface BootstrapOffer {
  kind: 'bootstrap_offer';
  repository: string;
  revision: string;
  artifactSha256: string;
}

export type StarterDisposition =
  | 'declined'
  | 'verification_failed'
  | 'bootstrap_failed'
  | 'bootstrap_completed';

export interface StarterReceipt {
  kind: 'bootstrap_receipt';
  disposition: StarterDisposition;
  revision: string;
  elapsedMs: number;
  exitCode?: number;
  completedPhases?: number;
}
