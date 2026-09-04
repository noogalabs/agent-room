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

  it('canonicalizes every page-typed role to the persisted member role', () => {
    expect(canonicalHumanMessage(member, { ...base, role: 'agent' }).role).toBe('human');
    expect(canonicalHumanMessage(member, { ...base, role: 'host' }).role).toBe('human');
    expect(canonicalHumanMessage(member, { ...base, role: 'Lead' }).role).toBe('human');
  });

  it('refuses only a non-web client while the web client succeeds', () => {
    expect(() => canonicalHumanMessage(member, { ...base, client: 'cc' })).toThrowError(expect.objectContaining({ code: 'human_identity_mismatch' }));
    expect(canonicalHumanMessage(member, base).client).toBe('web');
  });

  it('refuses only supplied metadata while the same message without metadata succeeds', () => {
    expect(() => canonicalHumanMessage(member, { ...base, metadata: { roleAtSend: 'host_directed' } })).toThrowError(expect.objectContaining({ code: 'human_identity_mismatch' }));
    expect(canonicalHumanMessage(member, base).client).toBe('web');
  });

  it('canonicalizes supplied initials and color from the persisted participant', () => {
    expect(canonicalHumanMessage(member, { ...base, initials: 'XX', color: '#ffffff' })).toMatchObject({ initials: 'SA', color: '#123456' });
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

  it('binds membership by fingerprint when name and fingerprint point at different participants', () => {
    const sameName = { ...member, authenticatedIdentity: { ...identity, cardFingerprint: 'fingerprint-other' } };
    const sameFingerprint = { ...member, name: 'Other', authenticatedIdentity: { ...identity, cardName: 'Other' } };
    const room = { code: 'ROOM1', topic: 'test', createdBy: 'Host', createdAt: 1, status: 'active' as const, version: 1, participants: [sameName, sameFingerprint] };
    expect(() => resolveSessionParticipant(room, { name: 'Sam', identityFingerprint: 'fingerprint-sam' })).toThrowError(expect.objectContaining({ code: 'human_membership_required' }));
  });

  it('never resolves an identity-less participant for a session with an undefined fingerprint', () => {
    const identityLess = { ...member, authenticatedIdentity: undefined };
    const room = { code: 'ROOM1', topic: 'test', createdBy: 'Host', createdAt: 1, status: 'active' as const, version: 1, participants: [identityLess] };
    expect(() => resolveSessionParticipant(room, { name: 'Sam', identityFingerprint: undefined })).toThrowError(expect.objectContaining({ code: 'human_membership_required' }));
  });
});
