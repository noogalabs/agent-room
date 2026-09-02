import { createHash } from 'node:crypto';
import type { Message } from '@agent-room/shared';

/** The hosted agent's room identity. Client 'cc' matches the starter's transport contract. */
export const HOSTED_IDENTITY = Object.freeze({
  name: 'Hosted Agent',
  role: 'Ops',
  color: '#8B5CF6',
  initials: 'HA',
  client: 'cc' as const,
});

export interface HostedBootstrapOffer {
  kind: 'bootstrap_offer';
  repository: string;
  revision: string;
  artifactSha256: string;
}

/** Build the typed bootstrap offer the starter validates: pinned repository, full SHA, artifact digest. */
export function buildBootstrapOffer(repository: string, revision: string, artifactBytes: Uint8Array): HostedBootstrapOffer {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)) {
    throw new Error('repository must be a pinned https GitHub .git URL');
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('revision must be a full lowercase commit SHA');
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  return Object.freeze({ kind: 'bootstrap_offer', repository, revision, artifactSha256 });
}

export interface ReplyPlan {
  /** Cursor after the last message considered. */
  cursor: number;
  /** Reply texts to post, in order. */
  replies: string[];
}

/**
 * Decide what the hosted agent says back. Only two inbound shapes get a reply:
 * a typed starter receipt (acknowledged with its disposition) and any other
 * non-self message (acknowledged as seen). Offers and the agent's own messages
 * are never answered, so the loop cannot talk to itself.
 */
export function planReplies(messages: readonly Message[], cursor: number, selfName: string, now: () => number = Date.now): ReplyPlan {
  const replies: string[] = [];
  for (const message of messages) {
    if (message.name === selfName) continue;
    const parsed = parseJson(message.text);
    if (parsed?.kind === 'bootstrap_offer') continue;
    if (parsed?.kind === 'bootstrap_receipt') {
      const disposition = typeof parsed.disposition === 'string' ? parsed.disposition : 'unknown';
      const revision = typeof parsed.revision === 'string' ? parsed.revision.slice(0, 12) : 'unknown';
      const phases = typeof parsed.completedPhases === 'number' ? ` phases=${parsed.completedPhases}` : '';
      const exit = typeof parsed.exitCode === 'number' ? ` exit=${parsed.exitCode}` : '';
      replies.push(`[RESULT] receipt from ${message.name}: ${disposition} revision=${revision}${phases}${exit} (acked ${new Date(now()).toISOString()})`);
      continue;
    }
    replies.push(`[STATUS] seen message from ${message.name} (${message.role}) at ${new Date(now()).toISOString()}`);
  }
  return { cursor: cursor + messages.length, replies };
}

export function makeMessage(text: string, now: number = Date.now()): Message {
  return {
    id: now,
    type: 'msg',
    name: HOSTED_IDENTITY.name,
    initials: HOSTED_IDENTITY.initials,
    color: HOSTED_IDENTITY.color,
    role: HOSTED_IDENTITY.role,
    text,
    client: HOSTED_IDENTITY.client,
    time: now,
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
