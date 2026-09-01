#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { checkoutPinnedRevision } from './checkout.js';
import type { BootstrapOffer, StarterReceipt } from './contracts.js';
import { executeBootstrapOffer } from './orchestrator.js';
import { requestLocalApproval } from './approval.js';
import { StarterRoomTransport, type BootstrapPoll, type StarterIdentity } from './transport.js';

export interface StarterConfiguration {
  roomUrl: string;
  roomCode: string;
  accessToken: string;
  stateRoot: string;
  identity: StarterIdentity;
}

export interface StarterSession {
  pollBootstrapOffers(cursor: number): Promise<BootstrapPoll>;
  sendReceipt(receipt: StarterReceipt): Promise<void>;
}

export interface StarterEntrypointDependencies {
  connect: (configuration: StarterConfiguration) => Promise<StarterSession>;
  checkout?: (offer: BootstrapOffer, stateRoot: string) => Promise<string>;
  approve?: (offer: BootstrapOffer) => Promise<boolean>;
  log?: (message: string) => void;
}

export function readStarterConfiguration(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): StarterConfiguration {
  if (argv.length !== 0) throw new Error('starter accepts no command-line arguments; configure it through the environment');
  const roomUrl = required(env.AGENT_ROOM_URL, 'AGENT_ROOM_URL');
  const roomCode = required(env.AGENT_ROOM_CODE, 'AGENT_ROOM_CODE');
  const accessToken = required(env.AGENT_ROOM_ACCESS_TOKEN, 'AGENT_ROOM_ACCESS_TOKEN');
  const stateRoot = env.AGENT_ROOM_STARTER_STATE ?? join(homedir(), '.agent-room', 'starter');
  return {
    roomUrl,
    roomCode,
    accessToken,
    stateRoot,
    identity: {
      name: env.AGENT_ROOM_STARTER_NAME ?? 'Starter',
      role: 'Installer',
      color: '#10B981',
      initials: 'ST',
    },
  };
}

export async function runStarterOnce(
  configuration: StarterConfiguration,
  dependencies: StarterEntrypointDependencies,
): Promise<readonly StarterReceipt[]> {
  const log = dependencies.log ?? console.log;
  const session = await dependencies.connect(configuration);
  const poll = await session.pollBootstrapOffers(0);
  const receipts: StarterReceipt[] = [];
  for (const candidate of poll.accepted) {
    if (!candidate.accepted) {
      log(`Rejected bootstrap offer: ${candidate.reason}`);
      continue;
    }
    const receipt = await executeBootstrapOffer(candidate.offer, {
      checkout: () => (dependencies.checkout ?? checkoutPinnedRevision)(candidate.offer, configuration.stateRoot),
      approve: dependencies.approve ?? promptForApproval,
      sendReceipt: (value) => session.sendReceipt(value),
    });
    receipts.push(receipt);
    log(`Bootstrap disposition: ${receipt.disposition} revision=${receipt.revision}`);
  }
  return receipts;
}

async function connect(configuration: StarterConfiguration): Promise<StarterSession> {
  return new StarterRoomTransport(
    configuration.roomUrl,
    configuration.roomCode,
    configuration.accessToken,
  ).join(configuration.identity);
}

async function promptForApproval(offer: BootstrapOffer): Promise<boolean> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`Verified bootstrap ${offer.revision} (${offer.artifactSha256}). Run locally? [y/N] `);
    return requestLocalApproval({ readLine: () => reader.question(''), timeoutMs: 60_000 });
  } finally {
    reader.close();
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configuration = readStarterConfiguration(process.env, process.argv.slice(2));
  await runStarterOnce(configuration, { connect });
}
