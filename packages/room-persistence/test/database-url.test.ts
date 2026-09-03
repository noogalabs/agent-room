import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { applyPostgresMigrations, PostgresRoomPersistence } from '../src/postgres.js';
import { migrationTarget, postgresTargetFromEnvironment } from '../src/database-url.js';

const local = 'postgresql://agent_room:test@127.0.0.1:5432/agent_room';
const testLocal = 'postgresql://agent_room:test@localhost:5432/agent_room_test';
const remote = 'postgresql://agent_room:test@production.example.invalid:5432/agent_room';

describe('agent-room database URL custody', () => {
  it('never reads ambient DATABASE_URL and gives explicit test or CLI targets priority', () => {
    const contaminated = {
      DATABASE_URL: remote,
      AGENT_ROOM_DATABASE_URL: local,
      TEST_POSTGRES_URL: testLocal,
    } as unknown as Parameters<typeof postgresTargetFromEnvironment>[0];
    expect(postgresTargetFromEnvironment(contaminated).connectionString).toBe(testLocal);
    expect(migrationTarget(['--url', local], contaminated).connectionString).toBe(local);

    const sources = ['../src/migrate.ts', '../src/factory.ts']
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
    expect(sources).not.toContain('process.env.DATABASE_URL');
  });

  it('refuses a remote migration target before attempting any database connection', async () => {
    const poolFactory = vi.fn(() => ({}) as Pool);
    await expect(applyPostgresMigrations({ connectionString: remote }, { poolFactory }))
      .rejects.toThrow('Remote agent-room Postgres host production.example.invalid refused');
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it('refuses a remote host-object migration target before the pool factory', async () => {
    const poolFactory = vi.fn(() => ({}) as Pool);
    await expect(applyPostgresMigrations(
      { host: 'production.example.invalid', database: 'agent_room' },
      { poolFactory },
    )).rejects.toThrow('Remote agent-room Postgres host production.example.invalid refused');
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it('refuses a remote host-object persistence target before the pool factory', async () => {
    const poolFactory = vi.fn(() => ({}) as Pool);
    await expect(PostgresRoomPersistence.connect(
      { host: 'production.example.invalid', database: 'agent_room' },
      { poolFactory },
    )).rejects.toThrow('Remote agent-room Postgres host production.example.invalid refused');
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it('permits a remote migration only through the explicit escape hatch', () => {
    expect(migrationTarget(['--url', remote, '--allow-remote'], {}).allowRemote).toBe(true);
    expect(postgresTargetFromEnvironment({
      AGENT_ROOM_DATABASE_URL: remote,
      AGENT_ROOM_ALLOW_REMOTE_DB: '1',
    }).allowRemote).toBe(true);
  });
});
