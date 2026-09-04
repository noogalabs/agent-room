import type { Message, Room } from '@agent-room/shared';
import { HumanSessionError } from './human-sessions.js';

type Participant = Room['participants'][number];
type SessionIdentity = Readonly<{ name?: string; identityFingerprint?: string }>;
type BrowserMessage = Partial<Message> & Readonly<{ participantId?: string }>;

export function resolveSessionParticipant(room: Room | null, session: SessionIdentity): Participant {
  const member = room?.participants.find(item =>
    item.client === 'web' && item.authenticatedIdentity?.cardFingerprint === session.identityFingerprint,
  );
  if (!member?.authenticatedIdentity || member.authenticatedIdentity.cardName !== session.name || member.name !== session.name) {
    throw new HumanSessionError('human_membership_required');
  }
  return member;
}

export function canonicalHumanMessage(member: Participant, supplied: BrowserMessage): Message {
  if (
    supplied.client !== 'web' || supplied.type !== 'msg' || supplied.metadata !== undefined
    || (supplied.name !== undefined && supplied.name !== member.name)
  ) throw new HumanSessionError('human_identity_mismatch');

  return {
    id: supplied.id!, type: 'msg', name: member.name, role: member.role,
    initials: member.initials, color: member.color, client: 'web',
    text: supplied.text!, time: supplied.time!, attachments: supplied.attachments,
  };
}
