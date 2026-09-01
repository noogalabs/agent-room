import { describe, expect, it, vi } from 'vitest';
import { readStarterConfiguration, runStarterOnce, type StarterConfiguration } from './cli.js';
import type { BootstrapOffer, StarterReceipt } from './contracts.js';
import { STARTER_REPOSITORY } from './offer.js';

const token = 'secret-room-access-token-that-must-not-leak';
const configuration: StarterConfiguration = {
  roomUrl: 'http://127.0.0.1:3000',
  roomCode: 'ABC-DEF-GHJ',
  accessToken: token,
  stateRoot: '/tmp/starter-state',
  identity: { name: 'Starter', role: 'Installer', color: '#10B981', initials: 'ST' },
};

const offer: BootstrapOffer = {
  kind: 'bootstrap_offer',
  repository: STARTER_REPOSITORY,
  revision: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
};

describe('starter entrypoint', () => {
  it('requires secrets from the environment and refuses command-line arguments', () => {
    expect(() => readStarterConfiguration({
      AGENT_ROOM_URL: configuration.roomUrl,
      AGENT_ROOM_CODE: configuration.roomCode,
      AGENT_ROOM_ACCESS_TOKEN: token,
    }, [token])).toThrow('accepts no command-line arguments');
    expect(() => readStarterConfiguration({
      AGENT_ROOM_URL: configuration.roomUrl,
      AGENT_ROOM_CODE: configuration.roomCode,
    }, [])).toThrow('AGENT_ROOM_ACCESS_TOKEN is required');
  });

  it('executes accepted offers while keeping capabilities out of logs and receipts', async () => {
    const logs: string[] = [];
    const sent: StarterReceipt[] = [];
    const connect = vi.fn(async (received: StarterConfiguration) => {
      expect(received.accessToken).toBe(token);
      return {
        pollBootstrapOffers: async () => ({ cursor: 1, accepted: [{ accepted: true as const, offer }] }),
        sendReceipt: async (receipt: StarterReceipt) => { sent.push(receipt); },
      };
    });
    const receipts = await runStarterOnce(configuration, {
      connect,
      checkout: async () => '/verified-checkout',
      approve: async () => false,
      log: (message) => logs.push(message),
    });

    expect(receipts).toEqual(sent);
    expect(receipts[0]?.disposition).toBe('verification_failed');
    const visible = JSON.stringify({ logs, sent });
    expect(visible).not.toContain(token);
  });

  it('surfaces invalid offers without checkout or execution', async () => {
    const logs: string[] = [];
    const checkout = vi.fn(async () => '/checkout');
    await runStarterOnce(configuration, {
      connect: async () => ({
        pollBootstrapOffers: async () => ({ cursor: 1, accepted: [{ accepted: false, reason: 'invalid schema' }] }),
        sendReceipt: async () => undefined,
      }),
      checkout,
      log: (message) => logs.push(message),
    });
    expect(checkout).not.toHaveBeenCalled();
    expect(logs).toEqual(['Rejected bootstrap offer: invalid schema']);
  });
});
