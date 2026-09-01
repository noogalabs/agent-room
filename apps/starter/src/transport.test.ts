import { describe, expect, it, vi } from 'vitest';
import { StarterRoomTransport, StarterTransportError } from './transport.js';

const roomCode = 'ABC-DEF-GHJ';
const accessToken = 'a'.repeat(32);
const participantToken = 'p'.repeat(32);
const identity = { name: 'Starter', role: 'Installer', color: '#10B981', initials: 'ST' };

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  } as Response;
}

describe('StarterRoomTransport refusal boundary', () => {
  it.each([
    ['URL credentials', 'https://user:password@example.com', roomCode, accessToken, 'credentials'],
    ['non-loopback HTTP', 'http://example.com', roomCode, accessToken, 'HTTPS'],
    ['invalid URL through validator', 'not a URL', roomCode, accessToken, 'room URL is invalid'],
    ['malformed room code', 'https://example.com', 'abc', accessToken, 'invalid room code'],
    ['short room access token', 'https://example.com', roomCode, 'a'.repeat(31), 'too short'],
  ])('refuses %s', (_case, baseUrl, code, token, reason) => {
    expect(() => new StarterRoomTransport(baseUrl, code, token)).toThrowError(StarterTransportError);
    expect(() => new StarterRoomTransport(baseUrl, code, token)).toThrow(reason);
  });

  it('refuses a short participant capability returned by join', async () => {
    const fetchImpl = vi.fn(async () => response({ participantToken: 'p'.repeat(31) }));
    const transport = new StarterRoomTransport('https://example.com', roomCode, accessToken, fetchImpl);
    await expect(transport.join(identity)).rejects.toThrow('participant capability');
  });

  it('refuses a non-ok room response before consuming its body', async () => {
    const json = vi.fn(async () => ({ participantToken }));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json }) as unknown as Response);
    const transport = new StarterRoomTransport('https://example.com', roomCode, accessToken, fetchImpl);
    await expect(transport.join(identity)).rejects.toThrow('status 503');
    expect(json).not.toHaveBeenCalled();
  });

  it('redacts a dependency error that contains the room token', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`socket failed for token ${accessToken}`); });
    const transport = new StarterRoomTransport('https://example.com', roomCode, accessToken, fetchImpl);
    await expect(transport.join(identity)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('room request failed before a response was received');
      expect((error as Error).message).not.toContain(accessToken);
      return true;
    });
  });
});
