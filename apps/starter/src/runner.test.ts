import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapOffer } from './contracts.js';
import { verifyBootstrapArtifact } from './artifact.js';
import { bootstrapEnvironment, runVerifiedBootstrap, type SpawnInvocation } from './runner.js';

async function fixture(source = 'process.exit(0);\n') {
  const root = await mkdtemp(join(tmpdir(), 'agent-room-starter-'));
  await mkdir(join(root, 'scripts'));
  const path = join(root, 'scripts', 'bootstrap-local.mjs');
  await writeFile(path, source);
  const offer: BootstrapOffer = {
    kind: 'bootstrap_offer',
    repository: 'https://github.com/agent-room-alkl/agent-room.git',
    revision: 'a'.repeat(40),
    artifactSha256: createHash('sha256').update(source).digest('hex'),
  };
  return { root, path, offer };
}

describe('verified bootstrap runner', () => {
  it('refuses a digest mismatch before returning an executable capability', async () => {
    const { root, offer } = await fixture();
    await expect(verifyBootstrapArtifact(root, { ...offer, artifactSha256: 'b'.repeat(64) }))
      .rejects.toThrow('digest mismatch');
  });

  it('uses a fixed node argv, no shell, repository cwd, and a secret-free environment', async () => {
    const { root, path, offer } = await fixture();
    const artifact = await verifyBootstrapArtifact(root, offer);
    const invocations: SpawnInvocation[] = [];

    const exitCode = await runVerifiedBootstrap(artifact, async (invocation) => {
      invocations.push(invocation);
      return 0;
    });

    expect(exitCode).toBe(0);
    expect(invocations).toEqual([{
      command: process.execPath,
      args: [path],
      options: {
        cwd: root,
        env: bootstrapEnvironment(process.env),
        shell: false,
        stdio: 'inherit',
      },
    }]);
    expect(Object.keys(invocations[0]!.options.env)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/TOKEN|SECRET|PASSWORD|CREDENTIAL|ROOM_CODE/i)]),
    );
  });

  it('removes room credentials and unrelated secrets from the child environment', () => {
    const environment = bootstrapEnvironment({
      PATH: '/usr/bin',
      HOME: '/customer',
      ROOM_ACCESS_TOKEN: 'room-secret',
      PARTICIPANT_TOKEN: 'participant-secret',
      API_KEY: 'api-secret',
      PASSWORD: 'password-secret',
    });

    expect(environment).toEqual({ PATH: '/usr/bin', HOME: '/customer' });
    expect(JSON.stringify(environment)).not.toContain('room-secret');
    expect(JSON.stringify(environment)).not.toContain('participant-secret');
    expect(JSON.stringify(environment)).not.toContain('api-secret');
    expect(JSON.stringify(environment)).not.toContain('password-secret');
  });

  it('refuses an object forged by an untyped caller', async () => {
    const { root, path, offer } = await fixture();
    const spawn = vi.fn(async () => 0);

    await expect(runVerifiedBootstrap({ path, repositoryRoot: root, sha256: offer.artifactSha256 }, spawn))
      .rejects.toThrow('requires a verified bootstrap artifact');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('re-hashes immediately before spawn and refuses post-verification replacement', async () => {
    const { root, path, offer } = await fixture();
    const artifact = await verifyBootstrapArtifact(root, offer);
    const spawn = vi.fn(async () => 0);
    await writeFile(path, 'process.exit(99);\n');

    await expect(runVerifiedBootstrap(artifact, spawn)).rejects.toThrow('changed after verification');
    expect(spawn).not.toHaveBeenCalled();
  });
});
