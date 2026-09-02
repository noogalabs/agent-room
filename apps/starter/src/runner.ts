import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  isVerifiedBootstrapArtifact,
  type VerifiedBootstrapArtifact,
} from './artifact.js';

export interface SpawnInvocation {
  command: string;
  args: readonly string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: 'inherit';
  };
}

export type SpawnBootstrap = (invocation: SpawnInvocation) => Promise<number>;

export async function runVerifiedBootstrap(
  artifact: VerifiedBootstrapArtifact,
  spawn: SpawnBootstrap = spawnBootstrap,
): Promise<number> {
  if (!isVerifiedBootstrapArtifact(artifact)) throw new Error('runner requires a verified bootstrap artifact');

  // Re-hash at the execution boundary so a post-verification file replacement
  // cannot launder unverified bytes through a previously valid capability.
  const bytes = await readFile(artifact.path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) throw new Error('bootstrap artifact changed after verification');

  return spawn({
    command: process.execPath,
    args: [artifact.path],
    options: {
      cwd: artifact.repositoryRoot,
      env: bootstrapEnvironment(process.env),
      shell: false,
      stdio: 'inherit',
    },
  });
}

export function bootstrapEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT'] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

async function spawnBootstrap(invocation: SpawnInvocation): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(invocation.command, [...invocation.args], invocation.options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`bootstrap terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
