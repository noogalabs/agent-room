import { createPrivateKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { signAgentCard, type AgentCard, type SignedAgentCard } from '@agent-room/room-persistence';
import type { Participant } from '@agent-room/shared';

export class AgentIdentityConfigurationError extends Error {
  constructor(readonly code: string) { super(code); this.name = code; }
}

export async function signedCardForParticipant(
  participant: Participant,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ signedCard: SignedAgentCard; scheme: 'oauth2' }> {
  const cardPath = env.AGENT_ROOM_AGENT_CARD;
  const privateKeyPath = env.AGENT_ROOM_FLEET_PRIVATE_KEY;
  const keyId = env.AGENT_ROOM_FLEET_KEY_ID;
  if (!cardPath || !privateKeyPath || !keyId) throw new AgentIdentityConfigurationError('agent_identity_configuration_required');
  let card: AgentCard;
  let privateJwk: JsonWebKey;
  try {
    const keyStat = await stat(privateKeyPath);
    if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw new Error('unsafe private key permissions');
    card = JSON.parse(await readFile(cardPath, 'utf8')) as AgentCard;
    privateJwk = JSON.parse(await readFile(privateKeyPath, 'utf8')) as JsonWebKey;
  } catch { throw new AgentIdentityConfigurationError('agent_identity_configuration_invalid'); }
  if (card.name !== participant.name) throw new AgentIdentityConfigurationError('agent_card_identity_mismatch');
  try {
    return { signedCard: signAgentCard(card, keyId, createPrivateKey({ key: privateJwk, format: 'jwk' })), scheme: 'oauth2' };
  } catch { throw new AgentIdentityConfigurationError('agent_identity_configuration_invalid'); }
}
