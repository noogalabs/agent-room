import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

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

async function runColdBoot(label, arrange) {
  await reset();
  await arrange();
  const port = String(41000 + Math.floor(Math.random() * 1000));
  const child = spawn('sh', ['scripts/start-room-server.sh'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_ROOM_PERSISTENCE: 'postgres',
      AGENT_ROOM_DATABASE_URL: databaseUrl,
      AGENT_ROOM_TRUST_STORE: resolve(root, 'trust-store.example.json'),
      AGENT_ROOM_HUMAN_SESSION_SECRET: 'cold-boot-human-session-secret-000000000000',
      AGENT_ROOM_HOST_TOKEN: 'cold-boot-host-token-0000000000000000000000',
      AGENT_ROOM_ADMIN_TOKEN: 'cold-boot-admin-token-00000000000000000000',
      AGENT_ROOM_MEMBER_AUTH: 'required',
      PORT: port,
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
    if (health.ready !== true || health.trustKeyCount !== 0 || health.persistence !== 'postgres') {
      throw new Error(`${label} returned unexpected health: ${JSON.stringify(health)}`);
    }
    const schema = await pool.query('SELECT MAX(version)::int AS version FROM agent_room_schema_migrations');
    if (schema.rows[0]?.version !== 2) throw new Error(`${label} did not migrate to schema v2`);
    if (!output.includes('agent_room_trust_store_empty')) {
      throw new Error(`${label} omitted the loud zero-trust startup log`);
    }
    process.stdout.write(`${label}: healthy at schema v2 with zero trusted fleets\n`);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
  }
}

try {
  await runColdBoot('empty database', async () => {});
  await runColdBoot('previous schema', async () => { await pool.query(v1); });
} finally {
  await reset();
  await pool.end();
}
