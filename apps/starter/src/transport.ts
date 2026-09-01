import type { Message, Participant } from '@agent-room/shared';
import { parseBootstrapOffer, type OfferValidation } from './offer.js';
import type { StarterReceipt } from './contracts.js';

export interface StarterIdentity {
  name: string;
  role: string;
  color: string;
  initials: string;
}

export interface BootstrapPoll {
  cursor: number;
  accepted: OfferValidation[];
}

type FetchLike = typeof fetch;

export class StarterRoomTransport {
  readonly #baseUrl: string;
  readonly #roomCode: string;
  readonly #accessToken: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, roomCode: string, accessToken: string, fetchImpl: FetchLike = fetch) {
    this.#baseUrl = validateBaseUrl(baseUrl);
    if (!/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(roomCode)) throw new Error('invalid room code');
    if (accessToken.length < 32) throw new Error('room access token is missing or too short');
    this.#roomCode = roomCode;
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
  }

  async join(identity: StarterIdentity, resumeParticipantToken?: string): Promise<StarterRoomSession> {
    const participant: Participant = {
      ...identity,
      client: 'cc',
      joinedAt: 0,
      lastSeenAt: 0,
    };
    const result = await this.#post(
      { action: 'join', code: this.#roomCode, participant },
      resumeParticipantToken,
    );
    const participantToken = readString(result, 'participantToken') ?? resumeParticipantToken;
    if (participantToken === undefined || participantToken.length < 32) {
      throw new Error('room join did not return a participant capability');
    }

    return new StarterRoomSession(
      this.#roomCode,
      identity,
      participantToken,
      (payload, token) => this.#post(payload, token),
    );
  }

  async #post(payload: object, participantToken?: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}/api/room`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-room-access': this.#accessToken,
        ...(participantToken === undefined ? {} : { authorization: `Bearer ${participantToken}` }),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`room request failed with status ${response.status}`);
    const result: unknown = await response.json();
    if (!isRecord(result)) throw new Error('room returned a malformed response');
    return result;
  }
}

export class StarterRoomSession {
  readonly #roomCode: string;
  readonly #identity: StarterIdentity;
  readonly #participantToken: string;
  readonly #post: (payload: object, participantToken: string) => Promise<Record<string, unknown>>;

  constructor(
    roomCode: string,
    identity: StarterIdentity,
    participantToken: string,
    post: (payload: object, participantToken: string) => Promise<Record<string, unknown>>,
  ) {
    this.#roomCode = roomCode;
    this.#identity = identity;
    this.#participantToken = participantToken;
    this.#post = post;
  }

  async pollBootstrapOffers(cursor: number): Promise<BootstrapPoll> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer');
    const result = await this.#post(
      { action: 'messages', code: this.#roomCode, cursor },
      this.#participantToken,
    );
    if (!Array.isArray(result.messages)) throw new Error('room returned malformed messages');

    const accepted: OfferValidation[] = [];
    for (const value of result.messages) {
      if (!isRecord(value) || typeof value.text !== 'string') continue;
      const candidate = parseOfferText(value.text);
      if (candidate !== null) accepted.push(parseBootstrapOffer(candidate));
    }
    return { cursor: cursor + result.messages.length, accepted };
  }

  async sendReceipt(receipt: StarterReceipt, now = Date.now()): Promise<void> {
    const message: Message = {
      id: now,
      type: 'msg',
      name: this.#identity.name,
      initials: this.#identity.initials,
      color: this.#identity.color,
      role: this.#identity.role,
      text: JSON.stringify(receipt),
      client: 'cc',
      time: now,
    };
    await this.#post(
      { action: 'send', code: this.#roomCode, message },
      this.#participantToken,
    );
  }
}

function validateBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) throw new Error('room URL must not contain credentials, query, or fragment');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('room URL must use HTTPS except on loopback');
  }
  return url.toString().replace(/\/$/, '');
}

function parseOfferText(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed.kind === 'bootstrap_offer' ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' ? input[key] : undefined;
}
