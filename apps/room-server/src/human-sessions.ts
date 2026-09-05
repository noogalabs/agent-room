import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedMemberIdentity } from '@agent-room/shared';
import type { RoomRecordServer, RoomReceipt } from '@agent-room/room-persistence';

export class HumanSessionError extends Error {
  constructor(readonly code: string) { super(code); this.name = code; }
}

interface Capability {
  purpose: 'invite' | 'session' | 'agent' | 'watch' | 'creator';
  roomCode: string;
  id: string;
  expiresAt: number;
  name?: string;
  role?: string;
  inviteId?: string;
  inviteRevocationApplies?: boolean;
  reusable?: boolean;
  client?: 'web' | 'cc';
  identityFingerprint?: string;
  issuedAt?: number;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class HumanSessionAuthority {
  constructor(
    private readonly rooms: RoomRecordServer,
    private readonly secret: string,
    private readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    if (Buffer.byteLength(secret) < 32) throw new HumanSessionError('human_session_secret_invalid');
  }

  private sign(payload: Capability): string {
    const body = encode(payload);
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  private verifySigned(token: string): Capability {
    const [body, supplied, extra] = token.split('.');
    if (!body || !supplied || extra) throw new HumanSessionError('human_session_invalid');
    const expected = createHmac('sha256', this.secret).update(body).digest();
    let actual: Buffer;
    try { actual = Buffer.from(supplied, 'base64url'); } catch { throw new HumanSessionError('human_session_invalid'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HumanSessionError('human_session_invalid');
    let payload: Capability;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Capability; }
    catch { throw new HumanSessionError('human_session_invalid'); }
    return payload;
  }

  private verify(token: string, purpose: Capability['purpose']): Capability {
    const payload = this.verifySigned(token);
    if (payload.purpose !== purpose) throw new HumanSessionError('human_session_invalid');
    if (payload.expiresAt <= this.now()) throw new HumanSessionError('human_session_expired');
    return payload;
  }

  async issueInvite(roomCode: string, ttlMs = 15 * 60_000, reusable = false): Promise<{ id: string; token: string; expiresAt: number }> {
    const room = await this.rooms.getRoom(roomCode);
    if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
    const id = randomBytes(18).toString('base64url');
    const expiresAt = reusable ? Number.MAX_SAFE_INTEGER : this.now() + ttlMs;
    const receipt: RoomReceipt = { id: `human-invite:${id}:issued`, roomCode, kind: 'receipt', createdAt: this.now(), payload: { event: 'human_invite_issued', inviteId: id, expiresAt, reusable } };
    // receipt-census-exempt: invite-issued — issuing an invite changes receipt state only; there is no room mutation to pair.
    if (!await this.rooms.appendReceipt(receipt)) throw new HumanSessionError('human_invite_collision');
    return { id, expiresAt, token: this.sign({ purpose: 'invite', roomCode, id, expiresAt, reusable }) };
  }

  async revokeInvite(roomCode: string, id: string): Promise<void> {
    // receipt-census-exempt: invite-revoked — revoking an invite changes receipt state only; there is no room mutation to pair.
    await this.rooms.appendReceipt({ id: `human-invite:${id}:revoked`, roomCode, kind: 'receipt', createdAt: this.now(), payload: { event: 'human_invite_revoked', inviteId: id } });
  }

  async sessionRevocationChange(roomCode: string, identityFingerprint: string): Promise<{
    deleteReceiptIds: string[]; receipt: RoomReceipt;
  }> {
    const id = `human-session:${identityFingerprint}:revoked`;
    const existing = (await this.rooms.listReceipts(roomCode)).find(item => item.id === id);
    const revokedAt = Math.max(this.now(), Number(existing?.payload.revokedAt ?? -1) + 1);
    return {
      deleteReceiptIds: existing ? [id] : [],
      receipt: { id, roomCode, kind: 'receipt', createdAt: revokedAt,
        payload: { event: 'human_session_revoked', identityFingerprint, revokedAt } },
    };
  }

  async issueWatch(roomCode: string, ttlMs = 15 * 60_000): Promise<{ token: string; expiresAt: number }> {
    const room = await this.rooms.getRoom(roomCode);
    if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
    const expiresAt = this.now() + ttlMs;
    return { expiresAt, token: this.sign({ purpose: 'watch', roomCode, id: randomBytes(18).toString('base64url'), expiresAt }) };
  }

  issueCreator(roomCode: string, ttlMs = 15 * 60_000): { token: string; expiresAt: number } {
    if (!roomCode.trim()) throw new HumanSessionError('browser_room_invalid');
    const expiresAt = this.now() + ttlMs;
    return { expiresAt, token: this.sign({ purpose: 'creator', roomCode, id: randomBytes(18).toString('base64url'), expiresAt }) };
  }

  verifyCreator(token: string, roomCode: string): Capability {
    const creator = this.verify(token, 'creator');
    if (creator.roomCode !== roomCode) throw new HumanSessionError('browser_creator_invalid');
    return creator;
  }

  async exchangeInvite(roomCode: string, token: string, name: string, _role: string, creator = false): Promise<{ token: string; expiresAt: number; identity: AuthenticatedMemberIdentity; redeemedReceipt?: RoomReceipt }> {
    const receipts = await this.rooms.listReceipts(roomCode);
    let invite: Capability;
    if (token) {
      invite = this.verify(token, 'invite');
    } else {
      const issued = [...receipts].reverse().find(item => item.payload.event === 'human_invite_issued' && item.payload.reusable === true &&
        !receipts.some(other => other.id === `human-invite:${String(item.payload.inviteId)}:revoked`));
      if (!issued) throw new HumanSessionError('human_invite_required');
      invite = { purpose: 'invite', roomCode, id: String(issued.payload.inviteId),
        expiresAt: Number(issued.payload.expiresAt), reusable: true };
    }
    if (invite.roomCode !== roomCode || !name.trim()) throw new HumanSessionError('human_invite_invalid');
    if (receipts.some(item => item.id === `human-invite:${invite.id}:revoked`)) throw new HumanSessionError('human_invite_revoked');
    const redeemedReceipt: RoomReceipt | undefined = invite.reusable ? undefined : {
      id: `human-invite:${invite.id}:redeemed`, roomCode, kind: 'receipt', createdAt: this.now(),
      payload: { event: 'human_invite_redeemed', inviteId: invite.id },
    };
    if (redeemedReceipt && receipts.some(item => item.id === redeemedReceipt.id)) throw new HumanSessionError('human_invite_used');
    const id = randomBytes(18).toString('base64url');
    const expiresAt = invite.reusable ? Number.MAX_SAFE_INTEGER : this.now() + 8 * 60 * 60_000;
    const cleanName = name.trim();
    const identity: AuthenticatedMemberIdentity = {
      cardFingerprint: createHash('sha256').update(this.issuer).update('\0').update(id).digest('hex'),
      fleetId: this.issuer,
      cardName: cleanName,
      scheme: 'oauth2',
      keyId: 'host-human-session',
      verifiedAt: this.now(),
    };
    const issuedAt = this.now();
    return { expiresAt, identity, redeemedReceipt, token: this.sign({ purpose: 'session', roomCode, id, issuedAt, expiresAt, name: cleanName, role: creator ? 'host' : 'human', inviteId: invite.id, inviteRevocationApplies: !invite.reusable, client: 'web', identityFingerprint: identity.cardFingerprint }) };
  }

  async issueAgentSession(roomCode: string, identity: AuthenticatedMemberIdentity, ttlMs = 8 * 60 * 60_000): Promise<{ token: string; expiresAt: number }> {
    const receipts = await this.rooms.listReceipts(roomCode);
    const watermark = receipts.find(item => item.id === `human-session:${identity.cardFingerprint}:revoked`);
    const issuedAt = Math.max(this.now(), Number(watermark?.payload.revokedAt ?? -1) + 1);
    const expiresAt = issuedAt + ttlMs;
    return { expiresAt, token: this.sign({ purpose: 'agent', roomCode,
      id: randomBytes(18).toString('base64url'), issuedAt, identityFingerprint: identity.cardFingerprint,
      expiresAt, name: identity.cardName, role: 'agent', client: 'cc' }) };
  }

  async verifySession(token: string, roomCode: string): Promise<Capability> {
    const signed = this.verifySigned(token);
    if (signed.purpose === 'watch') {
      throw new HumanSessionError(signed.expiresAt <= this.now() ? 'watch_session_expired' : 'watch_session_read_only');
    }
    if (signed.purpose !== 'session') throw new HumanSessionError('human_session_invalid');
    if (signed.expiresAt <= this.now()) throw new HumanSessionError('human_session_expired');
    const session = signed;
    if (session.roomCode !== roomCode || !session.name || !session.inviteId || !session.identityFingerprint || session.issuedAt === undefined) throw new HumanSessionError('human_session_invalid');
    const receipts = await this.rooms.listReceipts(roomCode);
    if (session.inviteRevocationApplies !== false && receipts.some(item => item.id === `human-invite:${session.inviteId}:revoked`)) throw new HumanSessionError('human_session_revoked');
    const watermark = receipts.find(item => item.id === `human-session:${session.identityFingerprint}:revoked`);
    if (Number(watermark?.payload.revokedAt ?? -1) >= session.issuedAt) throw new HumanSessionError('human_session_revoked');
    return session;
  }

  async verifyAgentSession(token: string, roomCode: string): Promise<Capability> {
    const session = this.verify(token, 'agent');
    if (session.roomCode !== roomCode || !session.name || !session.identityFingerprint || session.issuedAt === undefined || session.client !== 'cc') throw new HumanSessionError('agent_session_invalid');
    const receipts = await this.rooms.listReceipts(roomCode);
    const watermark = receipts.find(item => item.id === `human-session:${session.identityFingerprint}:revoked`);
    if (Number(watermark?.payload.revokedAt ?? -1) >= session.issuedAt) throw new HumanSessionError('agent_session_revoked');
    const room = await this.rooms.getRoom(roomCode);
    const member = room?.participants.find(item => item.client === 'cc' &&
      item.authenticatedIdentity?.cardFingerprint === session.identityFingerprint);
    if (!member?.authenticatedIdentity) throw new HumanSessionError('agent_session_invalid');
    const trusted = (await this.rooms.listFleetTrustKeys()).some(key =>
      key.fleetId === member.authenticatedIdentity!.fleetId && key.keyId === member.authenticatedIdentity!.keyId);
    if (!trusted) throw new HumanSessionError('agent_fleet_revoked');
    return session;
  }

  async verifyReadCapability(token: string, roomCode: string): Promise<Capability> {
    const signed = this.verifySigned(token);
    if (signed.roomCode !== roomCode) throw new HumanSessionError('room_read_denied');
    if (signed.purpose === 'watch' || signed.purpose === 'invite') {
      if (signed.expiresAt <= this.now()) throw new HumanSessionError(signed.purpose === 'watch' ? 'watch_session_expired' : 'human_session_expired');
      if (signed.purpose === 'invite') {
        const receipts = await this.rooms.listReceipts(roomCode);
        if (receipts.some(item => item.id === `human-invite:${signed.id}:revoked`)) throw new HumanSessionError('human_invite_revoked');
      }
      return signed;
    }
    if (signed.purpose === 'agent') return await this.verifyAgentSession(token, roomCode);
    return this.verifySession(token, roomCode);
  }

  async verifyMemberSession(token: string, roomCode: string): Promise<Capability> {
    const signed = this.verifySigned(token);
    return signed.purpose === 'agent' ? await this.verifyAgentSession(token, roomCode) : this.verifySession(token, roomCode);
  }
}
