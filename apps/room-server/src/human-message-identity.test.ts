import { describe, expect, it } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { canonicalHumanMessage, resolveSessionParticipant } from './human-message-identity.js';

const identity = {
  fleetId: 'hosted-room', cardName: 'Sam', cardFingerprint: 'fingerprint-sam',
  scheme: 'oauth2' as const, keyId: 'host-human-session', verifiedAt: 1,
};
const member: Room['participants'][number] = {
  name: 'Sam', role: 'human', initials: 'SA', color: '#123456', client: 'web',
  joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: identity,
};
const base = { id: 1, type: 'msg' as const, client: 'web' as const, text: 'hello', time: 1 };

describe('server-owned human message identity', () => {
  it('posts a page-typed role and absent identity fields as the session-bound participant', () => {
    expect(canonicalHumanMessage(member, { ...base, name: 'Sam', role: 'Lead' })).toMatchObject({ name: 'Sam', role: 'human', initials: 'SA', color: '#123456' });
    expect(canonicalHumanMessage(member, base)).toMatchObject({ name: 'Sam', role: 'human', initials: 'SA', color: '#123456' });
  });

  it('refuses another participant name while the same self-name succeeds', () => {
    expect(() => canonicalHumanMessage(member, { ...base, name: 'Other' })).toThrowError(expect.objectContaining({ code: 'human_identity_mismatch' }));
    expect(canonicalHumanMessage(member, { ...base, name: 'Sam' }).name).toBe('Sam');
  });

  it('refuses an agent role claim while the same descriptive UI role succeeds as human', () => {
    expect(() => canonicalHumanMessage(member, { ...base, role: 'agent' })).toThrowError(expect.objectContaining({ code: 'human_identity_mismatch' }));
    expect(canonicalHumanMessage(member, { ...base, role: 'Lead' }).role).toBe('human');
  });

  it('ignores a client participant id and succeeds identically when it is absent', () => {
    const claimed = canonicalHumanMessage(member, { ...base, participantId: 'fingerprint-other' });
    const absent = canonicalHumanMessage(member, base);
    expect(claimed).toStrictEqual(absent);
    expect(claimed).not.toHaveProperty('participantId');
  });

  it('resolves a creator session to its persisted host participant by fingerprint', () => {
    const host = { ...member, role: 'host', authenticatedIdentity: { ...identity, cardName: 'David', cardFingerprint: 'fingerprint-david' }, name: 'David' };
    const room = { code: 'ROOM1', topic: 'test', createdBy: 'David', createdAt: 1, status: 'active' as const, version: 1, participants: [host] };
    expect(resolveSessionParticipant(room, { name: 'David', identityFingerprint: 'fingerprint-david' })).toBe(host);
    expect(canonicalHumanMessage(host, { ...base, name: 'David', role: 'host' }).role).toBe('host');
  });
});
