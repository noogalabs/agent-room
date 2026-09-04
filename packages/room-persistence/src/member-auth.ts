import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
  type KeyLike,
} from 'node:crypto';
import type {
  AuthenticatedMemberIdentity,
  MemberAuthScheme,
  Participant,
  Room,
} from '@agent-room/shared';
import { RoomRecordServer } from './server.js';

export type MemberAuthMode = 'legacy' | 'required';

export const MEMBER_AUTH_SCHEMES = ['oauth2', 'openIdConnect', 'mTLS'] as const;

export type MemberAuthSchemeBoundary =
  | 'card_declaration'
  | 'selected_join_scheme'
  | 'selected_verification_scheme'
  | 'room_configuration';

export function requireMemberAuthScheme(
  value: unknown,
  boundary: MemberAuthSchemeBoundary,
): MemberAuthScheme {
  if (typeof value === 'string' && (MEMBER_AUTH_SCHEMES as readonly string[]).includes(value)) {
    return value as MemberAuthScheme;
  }
  throw new MemberJoinError('agent_card_scheme_not_accepted',
    'Agent Card authentication scheme is outside the supported closed set.', boundary);
}

export interface AgentCard {
  protocolVersion: string;
  fleetId: string;
  name: string;
  url: string;
  version: string;
  securitySchemes: Partial<Record<MemberAuthScheme, Readonly<Record<string, unknown>>>>;
  security: MemberAuthScheme[];
}

export interface SignedAgentCard {
  protected: string;
  card: AgentCard;
  signature: string;
}

export interface FleetTrustKey {
  fleetId: string;
  keyId: string;
  publicKey: KeyLike;
}

export interface AuthenticatedJoinInput {
  participant: Omit<Participant, 'joinedAt' | 'lastSeenAt' | 'authenticatedIdentity'>;
  signedCard?: SignedAgentCard;
  scheme?: MemberAuthScheme;
}

export class MemberJoinError extends Error {
  constructor(readonly code: string, message: string, readonly boundary?: MemberAuthSchemeBoundary) {
    super(message);
    this.name = code;
  }
}

export function memberAuthModeFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): MemberAuthMode {
  const value = env.AGENT_ROOM_MEMBER_AUTH ?? 'required';
  if (value === 'legacy' || value === 'required') return value;
  throw new MemberJoinError('member_auth_configuration_invalid',
    'AGENT_ROOM_MEMBER_AUTH must be legacy or required.');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signingInput(card: AgentCard, protectedHeader: string): Buffer {
  return Buffer.from(`${protectedHeader}.${base64url(JSON.stringify(canonical(card)))}`);
}

export function signAgentCard(card: AgentCard, keyId: string, privateKey: KeyLike): SignedAgentCard {
  const protectedHeader = base64url(JSON.stringify({ alg: 'EdDSA', kid: keyId, typ: 'agent-card+jws' }));
  return {
    protected: protectedHeader,
    card,
    signature: signBytes(null, signingInput(card, protectedHeader), privateKey).toString('base64url'),
  };
}

function parseProtected(encoded: string): { alg?: string; kid?: string; typ?: string } {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    throw new MemberJoinError('agent_card_signature_invalid', 'Agent Card protected header is malformed.');
  }
}

export class AgentCardVerifier {
  private readonly trustKeys: readonly FleetTrustKey[];

  constructor(trustKeys: readonly FleetTrustKey[], private readonly now: () => number = Date.now) {
    this.trustKeys = [...trustKeys];
  }

  verifyWithLegacyFingerprint(signed: SignedAgentCard, scheme: MemberAuthScheme): {
    identity: AuthenticatedMemberIdentity;
    legacyFingerprint: string;
  } {
    const selectedScheme = requireMemberAuthScheme(scheme, 'selected_verification_scheme');
    for (const declared of signed.card.security as unknown[]) requireMemberAuthScheme(declared, 'card_declaration');
    for (const declared of Object.keys(signed.card.securitySchemes)) requireMemberAuthScheme(declared, 'card_declaration');
    const header = parseProtected(signed.protected);
    if (header.alg !== 'EdDSA' || header.typ !== 'agent-card+jws' || !header.kid) {
      throw new MemberJoinError('agent_card_signature_invalid', 'Agent Card JWS header is not accepted.');
    }
    const key = this.trustKeys.find(item =>
      item.fleetId === signed.card.fleetId && item.keyId === header.kid);
    if (!key || !verifyBytes(null, signingInput(signed.card, signed.protected), key.publicKey,
      Buffer.from(signed.signature, 'base64url'))) {
      throw new MemberJoinError('agent_card_signature_invalid', 'Agent Card signature could not be verified.');
    }
    if (!signed.card.protocolVersion.trim() || !signed.card.fleetId.trim() ||
      !signed.card.name.trim() || !signed.card.version.trim()) {
      throw new MemberJoinError('agent_card_signature_invalid', 'Agent Card is missing a required public field.');
    }
    try {
      if (new URL(signed.card.url).protocol !== 'https:') throw new Error('not https');
    } catch {
      throw new MemberJoinError('agent_card_signature_invalid', 'Agent Card service URL must use HTTPS.');
    }
    if (!signed.card.security.includes(selectedScheme) || !(selectedScheme in signed.card.securitySchemes)) {
      throw new MemberJoinError('agent_card_scheme_not_accepted', 'Agent Card does not declare the selected scheme.');
    }
    const publicObject = typeof key.publicKey === 'object' && 'type' in key.publicKey &&
      (key.publicKey as KeyObject).type === 'public'
      ? key.publicKey as KeyObject
      : createPublicKey(key.publicKey);
    const publicDer = publicObject.export({ type: 'spki', format: 'der' });
    const legacyFingerprint = createHash('sha256')
      .update(signed.card.fleetId).update('\0').update(publicDer).digest('hex');
    const fingerprint = createHash('sha256')
      .update(signed.card.fleetId).update('\0').update(publicDer)
      .update('\0').update(signed.card.name).digest('hex');
    return { legacyFingerprint, identity: {
      cardFingerprint: fingerprint,
      fleetId: signed.card.fleetId,
      cardName: signed.card.name,
      scheme: selectedScheme,
      keyId: key.keyId,
      verifiedAt: this.now(),
    } };
  }

  verify(signed: SignedAgentCard, scheme: MemberAuthScheme): AuthenticatedMemberIdentity {
    return this.verifyWithLegacyFingerprint(signed, scheme).identity;
  }
}

export class AuthenticatedRoomJoinServer {
  constructor(
    private readonly rooms: RoomRecordServer,
    private readonly verifier: AgentCardVerifier,
    private readonly mode: MemberAuthMode = 'required',
    private readonly now: () => number = Date.now,
  ) {}

  async join(code: string, input: AuthenticatedJoinInput, seatSessionId?: string): Promise<Participant> {
    let room = await this.rooms.getRoom(code);
    if (!room || room.status !== 'active') throw new MemberJoinError('room_not_found', 'Room is not active.');
    const acceptedSchemes = (room.acceptedMemberAuthSchemes ?? [])
      .map(value => requireMemberAuthScheme(value, 'room_configuration'));
    let identity: AuthenticatedMemberIdentity | undefined;
    let legacyFingerprint: string | undefined;
    if (!input.signedCard || !input.scheme) {
      if (this.mode === 'required') {
        throw new MemberJoinError('agent_card_required', 'This room requires a signed Agent Card.');
      }
    } else {
      const selectedScheme = requireMemberAuthScheme(input.scheme, 'selected_join_scheme');
      ({ identity, legacyFingerprint } = this.verifier.verifyWithLegacyFingerprint(input.signedCard, selectedScheme));
      if (seatSessionId) identity = { ...identity, seatSessionId };
      if (!acceptedSchemes.includes(selectedScheme)) {
        throw new MemberJoinError('agent_card_scheme_not_accepted', 'Room does not accept the selected Agent Card scheme.');
      }
      if (identity.cardName !== input.participant.name) {
        throw new MemberJoinError('agent_card_identity_mismatch', 'Participant name does not match the verified Agent Card.');
      }
    }
    let legacyReceiptId: string | undefined;
    let legacyRows: Participant[] = [];
    if (identity) {
      legacyReceiptId = `member-roster:${legacyFingerprint}`;
      legacyRows = room.participants.filter(item => {
        const prior = item.authenticatedIdentity;
        if (!prior) return false;
        return prior.cardFingerprint === legacyFingerprint &&
          prior.cardName === identity!.cardName && prior.fleetId === identity!.fleetId &&
          prior.keyId === identity!.keyId;
      });
      const hasLegacyReceipt = (await this.rooms.listReceipts(code)).some(receipt => receipt.id === legacyReceiptId);
      // The v1 id identified a whole fleet key, not one card name. Delete it
      // only when this verified card also owns a matching legacy participant
      // row; otherwise a same-key agent could consume another agent's receipt.
      if (!hasLegacyReceipt || legacyRows.length === 0) legacyReceiptId = undefined;
      const matches = room.participants.filter(item =>
        item.authenticatedIdentity?.cardFingerprint === identity.cardFingerprint);
      if (matches.length > 0) {
        const existing = matches[0]!;
        const active = existing.authenticatedIdentity?.seatSessionId || !identity.seatSessionId
          ? existing
          : { ...existing, authenticatedIdentity: {
            ...existing.authenticatedIdentity!, seatSessionId: identity.seatSessionId,
          } };
        // Historical versions could append the same fleet identity more than
        // once. A repeat join is also the safe opportunity to collapse those
        // rows without changing the surviving seat identity.
        if (matches.length > 1 || active !== existing) {
          const participants = room.participants.flatMap(item => {
            if (item === existing) return [active];
            return item.authenticatedIdentity?.cardFingerprint === identity!.cardFingerprint ? [] : [item];
          });
          const next = { ...room, version: room.version + 1, participants };
          if (!await this.rooms.updateRoom(code, room.version, next)) {
            throw new MemberJoinError('room_version_conflict', 'Room changed while the participant was rejoining.');
          }
        }
        return active;
      }
    }
    const at = this.now();
    const participant: Participant = { ...input.participant, joinedAt: at, lastSeenAt: at,
      ...(identity ? { authenticatedIdentity: identity } : {}) };
    const retained = legacyRows.length === 0 ? room.participants : room.participants.filter(item => !legacyRows.includes(item));
    const next: Room = { ...room, version: room.version + 1, participants: [...retained, participant] };
    const updated = identity
      ? await this.rooms.updateRoomAndReplaceReceipt(code, room.version, next, {
        id: `member-roster:${identity.cardFingerprint}`,
        roomCode: code,
        kind: 'receipt',
        createdAt: participant.joinedAt,
        payload: { memberName: participant.name, memberClient: participant.client, fingerprintVersion: 2 },
      }, legacyReceiptId)
      : await this.rooms.updateRoom(code, room.version, next);
    if (!updated) {
      if (identity) {
        const winner = (await this.rooms.getRoom(code))?.participants.find(item =>
          item.authenticatedIdentity?.cardFingerprint === identity!.cardFingerprint);
        if (winner) return winner;
      }
      throw new MemberJoinError('room_version_conflict', 'Room changed while the participant was joining.');
    }
    return participant;
  }
}
