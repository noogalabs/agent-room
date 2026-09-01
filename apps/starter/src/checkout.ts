import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BootstrapOffer } from './contracts.js';
import { STARTER_REPOSITORY } from './offer.js';

const execFileAsync = promisify(execFile);

export interface GitInvocation {
  file: string;
  args: readonly string[];
  cwd?: string;
}

export type RunGit = (invocation: GitInvocation) => Promise<string>;

export async function checkoutPinnedRevision(
  offer: BootstrapOffer,
  stateRoot: string,
  runGit: RunGit = executeGit,
): Promise<string> {
  assertPinnedOffer(offer);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const checkout = await mkdtemp(join(stateRoot, 'checkout-'));
  await chmod(checkout, 0o700);

  try {
    await runGit({ file: 'git', args: ['init', '--quiet', checkout] });
    await runGit({ file: 'git', args: ['remote', 'add', 'origin', STARTER_REPOSITORY], cwd: checkout });
    await runGit({ file: 'git', args: ['fetch', '--depth=1', 'origin', offer.revision], cwd: checkout });
    await runGit({ file: 'git', args: ['checkout', '--detach', 'FETCH_HEAD'], cwd: checkout });
    const actualRevision = (await runGit({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: checkout })).trim();
    if (actualRevision !== offer.revision) throw new Error('checked-out revision does not match pinned SHA');
    return checkout;
  } catch (error) {
    await rm(checkout, { recursive: true, force: true });
    throw error;
  }
}

function assertPinnedOffer(offer: BootstrapOffer): void {
  if (offer.repository !== STARTER_REPOSITORY) throw new Error('repository is not pinned');
  if (!/^[a-f0-9]{40}$/.test(offer.revision)) throw new Error('revision must be a full lowercase commit SHA');
}

async function executeGit(invocation: GitInvocation): Promise<string> {
  const { stdout } = await execFileAsync(invocation.file, [...invocation.args], {
    cwd: invocation.cwd,
    shell: false,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout;
}
