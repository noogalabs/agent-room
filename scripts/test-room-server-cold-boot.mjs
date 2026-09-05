import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { signAgentCard } from '../packages/room-persistence/dist/index.js';

const databaseUrl = process.env.TEST_POSTGRES_URL;
if (!databaseUrl) throw new Error('TEST_POSTGRES_URL is required');
const target = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) {
  throw new Error(`cold-boot casualty refuses non-local Postgres host: ${target.hostname}`);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const root = resolve(import.meta.dirname, '..');
const v1 = await readFile(resolve(root, 'packages/room-persistence/migrations/001_durable_room_record.sql'), 'utf8');

async function reset() {
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'agent_room_%'",
  );
  for (const { tablename } of tables.rows) {
    await pool.query(`DROP TABLE IF EXISTS ${JSON.stringify(tablename)} CASCADE`);
  }
}

async function materializedTrustStore(runtime) {
  const entries = await readdir(runtime, { withFileTypes: true });
  const seedDirectory = entries.find(entry => entry.isDirectory() && entry.name.startsWith('agent-room-trust-store.'));
  if (!seedDirectory) throw new Error('materialized trust seed private directory was not created');
  const directory = resolve(runtime, seedDirectory.name);
  if ((await stat(directory)).mode & 0o077) throw new Error('materialized trust seed directory was not mode 0700');
  return resolve(directory, 'trust-store.json');
}

async function runColdBoot(label, arrange, expectedTrustKeyCount, seedEnv = {}, verify = async () => {}) {
  await reset();
  await arrange();
  const runtime = await mkdtemp(resolve(tmpdir(), 'agent-room-cold-boot-'));
  const port = String(41000 + Math.floor(Math.random() * 1000));
  const child = spawn('sh', ['scripts/start-room-server.sh'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_ROOM_PERSISTENCE: 'postgres',
      AGENT_ROOM_DATABASE_URL: databaseUrl,
      AGENT_ROOM_HUMAN_SESSION_SECRET: 'cold-boot-human-session-secret-000000000000',
      AGENT_ROOM_HOST_TOKEN: 'cold-boot-host-token-0000000000000000000000',
      AGENT_ROOM_ADMIN_TOKEN: 'cold-boot-admin-token-00000000000000000000',
      AGENT_ROOM_MEMBER_AUTH: 'required',
      PORT: port,
      TMPDIR: runtime,
      ...seedEnv,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`${label} exited before health:\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    if (!health) throw new Error(`${label} never became healthy:\n${output}`);
    if (health.ready !== true || health.trustKeyCount !== expectedTrustKeyCount || health.persistence !== 'postgres') {
      throw new Error(`${label} returned unexpected health: ${JSON.stringify(health)}`);
    }
    const schema = await pool.query('SELECT MAX(version)::int AS version FROM agent_room_schema_migrations');
    if (schema.rows[0]?.version !== 2) throw new Error(`${label} did not migrate to schema v2`);
    if (expectedTrustKeyCount === 0 && !output.includes('agent_room_trust_store_empty')) {
      throw new Error(`${label} omitted the loud zero-trust startup log`);
    }
    if (seedEnv.AGENT_ROOM_TRUST_STORE_B64 || seedEnv.AGENT_ROOM_TRUST_STORE_JSON) {
      const materialized = await materializedTrustStore(runtime);
      if ((await stat(materialized)).mode & 0o077) {
        throw new Error(`${label} materialized trust seed with group/other permissions`);
      }
    }
    await verify(`http://127.0.0.1:${port}`);
    process.stdout.write(`${label}: healthy at schema v2 with ${expectedTrustKeyCount} trusted fleet key(s)\n`);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    await rm(runtime, { recursive: true, force: true });
  }
}

async function rejectConflictingSources() {
  const collisions = [
    ['AGENT_ROOM_TRUST_STORE_B64', 'AGENT_ROOM_TRUST_STORE_JSON', 'trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_B64 and AGENT_ROOM_TRUST_STORE_JSON are mutually exclusive\n'],
    ['AGENT_ROOM_TRUST_STORE_B64', 'AGENT_ROOM_TRUST_STORE', 'trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_B64 and AGENT_ROOM_TRUST_STORE are mutually exclusive\n'],
    ['AGENT_ROOM_TRUST_STORE_JSON', 'AGENT_ROOM_TRUST_STORE', 'trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_JSON and AGENT_ROOM_TRUST_STORE are mutually exclusive\n'],
  ];
  for (const [left, right, expectedOutput] of collisions) {
    const runtime = await mkdtemp(resolve(tmpdir(), 'agent-room-conflicting-seeds-'));
    const child = spawn('sh', ['scripts/start-room-server.sh'], {
      cwd: root,
      env: { ...process.env, TMPDIR: runtime, [left]: 'configured', [right]: 'configured' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    try {
      const code = await new Promise((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          rejectExit(new Error(`conflicting sources ${left}/${right} did not fail promptly`));
        }, 10000);
        child.once('close', value => { clearTimeout(timer); resolveExit(value); });
      });
      if (code === 0 || output !== expectedOutput) {
        throw new Error(`conflicting sources ${left}/${right} returned code ${code}; expected ${JSON.stringify(expectedOutput)}, received ${JSON.stringify(output)}`);
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await rm(runtime, { recursive: true, force: true });
    }
  }
  process.stdout.write('conflicting seed sources: all three pairs refused by name\n');
}

async function rejectMalformedSeed() {
  await reset();
  const runtime = await mkdtemp(resolve(tmpdir(), 'agent-room-bad-seed-'));
  const child = spawn('sh', ['scripts/start-room-server.sh'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_ROOM_PERSISTENCE: 'postgres',
      AGENT_ROOM_DATABASE_URL: databaseUrl,
      AGENT_ROOM_TRUST_STORE_JSON: '{',
      AGENT_ROOM_HUMAN_SESSION_SECRET: 'cold-boot-human-session-secret-000000000000',
      AGENT_ROOM_HOST_TOKEN: 'cold-boot-host-token-0000000000000000000000',
      AGENT_ROOM_ADMIN_TOKEN: 'cold-boot-admin-token-00000000000000000000',
      AGENT_ROOM_MEMBER_AUTH: 'required',
      PORT: '41999',
      TMPDIR: runtime,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectExit(new Error('malformed seed did not fail promptly'));
    }, 10000);
    child.once('close', value => { clearTimeout(timer); resolveExit(value); });
  });
  try {
    if (code === 0 || !output.includes('trust_store_invalid')) {
      throw new Error(`malformed supplied seed returned code ${code} without trust_store_invalid:\n${output}`);
    }
    const materialized = await materializedTrustStore(runtime);
    if ((await stat(materialized)).mode & 0o077) {
      throw new Error('malformed supplied seed was not materialized with mode 0600');
    }
    process.stdout.write('malformed supplied seed: refused loudly before listen\n');
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
}

async function rejectMalformedBase64Seed() {
  const runtime = await mkdtemp(resolve(tmpdir(), 'agent-room-bad-base64-seed-'));
  const child = spawn('sh', ['scripts/start-room-server.sh'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_ROOM_TRUST_STORE_B64: '%%%not-base64%%%',
      TMPDIR: runtime,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectExit(new Error('malformed base64 seed did not fail promptly'));
    }, 10000);
    child.once('close', value => { clearTimeout(timer); resolveExit(value); });
  });
  try {
    if (code === 0 || !/base64.*(?:invalid|error decoding)/is.test(output) || output.includes('trust_store_invalid')) {
      throw new Error(`malformed base64 seed did not fail in the decoder (code ${code}):\n${output}`);
    }
    process.stdout.write('malformed base64 seed: decoder failure stopped startup before validation\n');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(runtime, { recursive: true, force: true });
  }
}

try {
  await runColdBoot('empty database', async () => {}, 0);
  await runColdBoot('previous schema', async () => { await pool.query(v1); }, 0, {
    AGENT_ROOM_TRUST_STORE_B64: Buffer.from('[]').toString('base64'),
  });
  const syntheticKeys = generateKeyPairSync('ed25519');
  const syntheticTrust = [{
    fleetId: 'cold-boot-fleet',
    keyId: 'cold-boot-key',
    publicKey: syntheticKeys.publicKey.export({ format: 'jwk' }),
  }];
  await runColdBoot('populated base64 seed', async () => {}, 1, {
    AGENT_ROOM_TRUST_STORE_B64: Buffer.from(JSON.stringify(syntheticTrust)).toString('base64'),
  }, async base => {
    const room = {
      code: 'COLD01', topic: 'cold boot', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
      participants: [], acceptedMemberAuthSchemes: ['oauth2'],
    };
    const created = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: 'Bearer cold-boot-host-token-0000000000000000000000', 'content-type': 'application/json' },
      body: JSON.stringify(room),
    });
    if (created.status !== 201) throw new Error(`populated seed could not create room: ${created.status} ${await created.text()}`);
    const card = {
      protocolVersion: '0.3', fleetId: 'cold-boot-fleet', name: 'Cold Boot Agent',
      url: 'https://cold-boot.invalid/agent', version: '1', securitySchemes: { oauth2: {} }, security: ['oauth2'],
    };
    const joined = await fetch(`${base}/api/rooms/COLD01/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        participant: { name: card.name, role: '', color: '#000000', initials: 'CB', client: 'cc' },
        signedCard: signAgentCard(card, 'cold-boot-key', syntheticKeys.privateKey), scheme: 'oauth2',
      }),
    });
    if (joined.status !== 200) throw new Error(`matching synthetic signed card did not join: ${joined.status} ${await joined.text()}`);
  });
  await rejectConflictingSources();
  await rejectMalformedSeed();
  await rejectMalformedBase64Seed();
} finally {
  await reset();
  await pool.end();
}
