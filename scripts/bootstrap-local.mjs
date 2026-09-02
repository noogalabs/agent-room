#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ODS-inspired hard phase boundaries: every phase either completes and is
// recorded, or the installer halts at the named boundary. No half-success.
const phases = [
  ['preflight', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`Node 20+ required; found ${process.version}`);
  }],
  ['platform', () => {
    if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error(`Unsupported platform: ${process.platform}`);
  }],
  ['workspace', () => {
    if (!existsSync(resolve('apps/local-server/package.json'))) throw new Error('Run from the Agent Room repository root.');
  }],
  ['dependencies', () => run('npm', ['install', '--ignore-scripts'])],
  ['shared-build', () => run('npm', ['-w', 'packages/shared', 'run', 'build'])],
  ['transport-build', () => run('npm', ['-w', 'packages/upstash-client', 'run', 'build'])],
  ['server-build', () => run('npm', ['-w', 'apps/local-server', 'run', 'build'])],
  ['mcp-build', () => run('npm', ['-w', 'apps/mcp', 'run', 'build'])],
  ['data-root', () => mkdirSync(resolve('.agent-room-local'), { recursive: true, mode: 0o700 })],
  ['runtime-config', () => {
    const config = { baseUrl: 'http://127.0.0.1:8787', dataDir: resolve('.agent-room-local'), bind: '127.0.0.1', port: 8787 };
    writeFileSync(resolve('.agent-room-local/config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }],
  ['security-contract', () => {
    const config = JSON.parse(String(requireRead(resolve('.agent-room-local/config.json'))));
    if (config.bind !== '127.0.0.1') throw new Error('Installer refuses non-loopback bind.');
  }],
  ['acceptance', () => run('npm', ['-w', 'apps/local-server', 'test'])],
  ['summary', () => {
    const launcher = resolve('.agent-room-local/start.sh');
    writeFileSync(launcher, '#!/bin/sh\nset -eu\nexport AGENT_ROOM_BASE_URL=http://127.0.0.1:8787\nexport AGENT_ROOM_DATA_DIR="$(pwd)/.agent-room-local"\nexport AGENT_ROOM_PORT=8787\nexec node apps/local-server/dist/index.js\n', { mode: 0o700 });
    chmodSync(launcher, 0o700);
    process.stdout.write(`\nReady. Start with ${launcher}\nMCP base URL: http://127.0.0.1:8787\n`);
  }],
];

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env });
}

function requireRead(path) {
  return execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}))`]);
}

let completed = 0;
for (let i = 0; i < phases.length; i++) {
  const [name, action] = phases[i];
  process.stdout.write(`[${i + 1}/${phases.length}] ${name} ... `);
  try {
    action();
    completed++;
    process.stdout.write('OK\n');
  } catch (error) {
    process.stderr.write(`FAILED\n${error instanceof Error ? error.message : error}\n`);
    process.stderr.write(`Stopped after ${completed}/${phases.length} completed phases.\n`);
    process.exit(1);
  }
}
