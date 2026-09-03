import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-room/shared';
import type { RoomPersistence } from '../src/types.js';
import { RoomRecordServer } from '../src/server.js';
import {
  AgentCardVerifier,
  AuthenticatedRoomJoinServer,
  signAgentCard,
  memberAuthModeFromEnvironment,
  type AgentCard,
} from '../src/member-auth.js';

function room(): Room {
  return {
    code: 'AUT-MEM-BER', topic: 'Synthetic', createdAt: 1, createdBy: 'Host',
    status: 'active', version: 1, participants: [], acceptedMemberAuthSchemes: ['oauth2'],
  };
}

function card(): AgentCard {
  return {
    protocolVersion: '0.3.0', fleetId: 'fleet-synthetic', name: 'Builder',
    url: 'https://agent.invalid/a2a', version: '1.0.0',
    securitySchemes: { oauth2: { type: 'oauth2' }, mTLS: { type: 'mutualTLS' } },
    security: ['oauth2', 'mTLS'],
  };
}

class MemoryPersistence implements RoomPersistence {
  readonly kind = 'postgres' as const;
  current: Room = room();
  writes = 0;
  async createRoom(value: Room) { this.current = structuredClone(value); }
  async getRoom(code: string) { return code === this.current.code ? structuredClone(this.current) : null; }
  async compareAndSwapRoom(_code: string, expected: number, next: Room) {
    if (this.current.version !== expected) return false;
    this.current = structuredClone(next); this.writes++; return true;
  }
  async appendMessage() { return 0; }
  async listMessages() { return []; }
  async getTaskBoard() { return null; }
  async compareAndSwapTaskBoard() { return false; }
  async putMinutes() {}
  async getMinutes() { return null; }
  async appendReceipt() { return false; }
  async appendLeaseEvent() { return false; }
  async listReceipts() { return []; }
  async close() {}
}

const participant = { name: 'Builder', role: 'builder', color: '#123456', initials: 'BU', client: 'cc' } as const;

describe('authenticated room join production entry', () => {
  it('joins a valid card and keeps the fingerprint binding in the persistence seam', async () => {
    const keys = generateKeyPairSync('ed25519');
    const persistence = new MemoryPersistence();
    const join = new AuthenticatedRoomJoinServer(
      new RoomRecordServer(persistence),
      new AgentCardVerifier([{ fleetId: card().fleetId, keyId: 'key-1', publicKey: keys.publicKey }], () => 20),
      'required', () => 20,
    );
    const saved = await join.join(room().code, {
      participant, scheme: 'oauth2', signedCard: signAgentCard(card(), 'key-1', keys.privateKey),
    });

    expect(saved.authenticatedIdentity).toMatchObject({ fleetId: 'fleet-synthetic', scheme: 'oauth2', keyId: 'key-1' });
    expect((await persistence.getRoom(room().code))?.participants[0]).toEqual(saved);
    expect(persistence.writes).toBe(1);
  });

  it('refuses a tampered signature before any participant write', async () => {
    const keys = generateKeyPairSync('ed25519');
    const persistence = new MemoryPersistence();
    const join = new AuthenticatedRoomJoinServer(new RoomRecordServer(persistence),
      new AgentCardVerifier([{ fleetId: card().fleetId, keyId: 'key-1', publicKey: keys.publicKey }]), 'required');
    const signed = signAgentCard(card(), 'key-1', keys.privateKey);
    signed.card = { ...signed.card, name: 'Tampered' };

    await expect(join.join(room().code, { participant, scheme: 'oauth2', signedCard: signed }))
      .rejects.toMatchObject({ name: 'agent_card_signature_invalid' });
    expect(persistence.writes).toBe(0);
  });

  it('refuses a room-unaccepted scheme before any participant write', async () => {
    const keys = generateKeyPairSync('ed25519');
    const persistence = new MemoryPersistence();
    const join = new AuthenticatedRoomJoinServer(new RoomRecordServer(persistence),
      new AgentCardVerifier([{ fleetId: card().fleetId, keyId: 'key-1', publicKey: keys.publicKey }]), 'required');

    await expect(join.join(room().code, {
      participant, scheme: 'mTLS', signedCard: signAgentCard(card(), 'key-1', keys.privateKey),
    })).rejects.toMatchObject({ name: 'agent_card_scheme_not_accepted' });
    expect(persistence.writes).toBe(0);
  });

  it('keeps legacy joins by default and refuses them when cards are required', async () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new AgentCardVerifier([{ fleetId: card().fleetId, keyId: 'key-1', publicKey: keys.publicKey }]);
    const legacyStore = new MemoryPersistence();
    const legacy = new AuthenticatedRoomJoinServer(new RoomRecordServer(legacyStore), verifier);
    expect((await legacy.join(room().code, { participant })).authenticatedIdentity).toBeUndefined();
    expect(legacyStore.writes).toBe(1);

    const requiredStore = new MemoryPersistence();
    const required = new AuthenticatedRoomJoinServer(new RoomRecordServer(requiredStore), verifier, 'required');
    await expect(required.join(room().code, { participant }))
      .rejects.toMatchObject({ name: 'agent_card_required' });
    expect(requiredStore.writes).toBe(0);
    expect(memberAuthModeFromEnvironment({})).toBe('legacy');
    expect(memberAuthModeFromEnvironment({ AGENT_ROOM_MEMBER_AUTH: 'required' })).toBe('required');
    expect(() => memberAuthModeFromEnvironment({ AGENT_ROOM_MEMBER_AUTH: 'optional' }))
      .toThrow(/must be legacy or required/);
  });

  it.each([
    'card declaration',
    'selected join scheme',
    'room configuration',
  ] as const)('refuses an unknown runtime scheme at the %s boundary without a write', async boundary => {
    const keys = generateKeyPairSync('ed25519');
    const persistence = new MemoryPersistence();
    const validCard = card();
    const unknownCard = {
      ...validCard,
      securitySchemes: { apiKey: { type: 'apiKey' } },
      security: ['apiKey'],
    } as unknown as AgentCard;
    if (boundary === 'room configuration') {
      persistence.current = {
        ...persistence.current,
        acceptedMemberAuthSchemes: ['apiKey'] as unknown as Room['acceptedMemberAuthSchemes'],
      };
    }
    const join = new AuthenticatedRoomJoinServer(
      new RoomRecordServer(persistence),
      new AgentCardVerifier([{
        fleetId: validCard.fleetId, keyId: 'key-1', publicKey: keys.publicKey,
      }]),
      'required',
    );
    const selected = boundary === 'selected join scheme'
      ? 'apiKey' as unknown as 'oauth2'
      : 'oauth2';
    const selectedCard = boundary === 'card declaration' ? unknownCard : validCard;

    await expect(join.join(room().code, {
      participant,
      scheme: selected,
      signedCard: signAgentCard(selectedCard, 'key-1', keys.privateKey),
    })).rejects.toMatchObject({ name: 'agent_card_scheme_not_accepted' });
    expect(persistence.writes).toBe(0);
    expect(persistence.current.participants).toEqual([]);
  });
});
