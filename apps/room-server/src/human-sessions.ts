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
  client?: 'web' | 'cc';
  identityFingerprint?: string;
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

  async issueInvite(roomCode: string, ttlMs = 15 * 60_000): Promise<{ id: string; token: string; expiresAt: number }> {
    const room = await this.rooms.getRoom(roomCode);
    if (!room || room.status !== 'active') throw new HumanSessionError('room_not_found');
    const id = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    const receipt: RoomReceipt = { id: `human-invite:${id}:issued`, roomCode, kind: 'receipt', createdAt: this.now(), payload: { event: 'human_invite_issued', inviteId: id, expiresAt } };
    if (!await this.rooms.appendReceipt(receipt)) throw new HumanSessionError('human_invite_collision');
    return { id, expiresAt, token: this.sign({ purpose: 'invite', roomCode, id, expiresAt }) };
  }

  async revokeInvite(roomCode: string, id: string): Promise<void> {
    await this.rooms.appendReceipt({ id: `human-invite:${id}:revoked`, roomCode, kind: 'receipt', createdAt: this.now(), payload: { event: 'human_invite_revoked', inviteId: id } });
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

  async exchangeInvite(roomCode: string, token: string, name: string, _role: string, creator = false): Promise<{ token: string; expiresAt: number; identity: AuthenticatedMemberIdentity }> {
    const invite = this.verify(token, 'invite');
    if (invite.roomCode !== roomCode || !name.trim()) throw new HumanSessionError('human_invite_invalid');
    const receipts = await this.rooms.listReceipts(roomCode);
    if (receipts.some(item => item.id === `human-invite:${invite.id}:revoked`)) throw new HumanSessionError('human_invite_revoked');
    const redeemed: RoomReceipt = { id: `human-invite:${invite.id}:redeemed`, roomCode, kind: 'receipt', createdAt: this.now(), payload: { event: 'human_invite_redeemed', inviteId: invite.id } };
    if (!await this.rooms.appendReceipt(redeemed)) throw new HumanSessionError('human_invite_used');
    const id = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + 8 * 60 * 60_000;
    const cleanName = name.trim();
    const identity: AuthenticatedMemberIdentity = {
      cardFingerprint: createHash('sha256').update(this.issuer).update('\0').update(id).digest('hex'),
      fleetId: this.issuer,
      cardName: cleanName,
      scheme: 'oauth2',
      keyId: 'host-human-session',
      verifiedAt: this.now(),
    };
    return { expiresAt, identity, token: this.sign({ purpose: 'session', roomCode, id, expiresAt, name: cleanName, role: creator ? 'host' : 'human', inviteId: invite.id, client: 'web', identityFingerprint: identity.cardFingerprint }) };
  }

  issueAgentSession(roomCode: string, identity: AuthenticatedMemberIdentity, ttlMs = 8 * 60 * 60_000): { token: string; expiresAt: number } {
    const expiresAt = this.now() + ttlMs;
    return { expiresAt, token: this.sign({ purpose: 'agent', roomCode,
      id: randomBytes(18).toString('base64url'), identityFingerprint: identity.cardFingerprint,
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
    if (session.roomCode !== roomCode || !session.name || !session.inviteId || !session.identityFingerprint) throw new HumanSessionError('human_session_invalid');
    const receipts = await this.rooms.listReceipts(roomCode);
    if (receipts.some(item => item.id === `human-invite:${session.inviteId}:revoked`)) throw new HumanSessionError('human_session_revoked');
    return session;
  }

  verifyAgentSession(token: string, roomCode: string): Capability {
    const session = this.verify(token, 'agent');
    if (session.roomCode !== roomCode || !session.name || !session.identityFingerprint || session.client !== 'cc') throw new HumanSessionError('agent_session_invalid');
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
    if (signed.purpose === 'agent') return this.verifyAgentSession(token, roomCode);
    return this.verifySession(token, roomCode);
  }

  async verifyMemberSession(token: string, roomCode: string): Promise<Capability> {
    const signed = this.verifySigned(token);
    return signed.purpose === 'agent' ? this.verifyAgentSession(token, roomCode) : this.verifySession(token, roomCode);
  }
}
