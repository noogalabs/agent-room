import { PersistenceConfigurationError } from './types.js';

export interface DatabaseEnvironment {
  AGENT_ROOM_DATABASE_URL?: string;
  AGENT_ROOM_ALLOW_REMOTE_DB?: string;
  TEST_POSTGRES_URL?: string;
}

export interface MigrationTarget {
  connectionString: string;
  allowRemote: boolean;
}

export function postgresTargetFromEnvironment(env: DatabaseEnvironment): MigrationTarget {
  const connectionString = env.TEST_POSTGRES_URL?.trim() || env.AGENT_ROOM_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new PersistenceConfigurationError(
      'TEST_POSTGRES_URL or AGENT_ROOM_DATABASE_URL is required for agent-room Postgres',
    );
  }
  return { connectionString, allowRemote: env.AGENT_ROOM_ALLOW_REMOTE_DB === '1' };
}

export function migrationTarget(
  args: readonly string[],
  env: DatabaseEnvironment,
): MigrationTarget {
  const equals = args.find(value => value.startsWith('--url='));
  const index = args.indexOf('--url');
  const explicit = equals?.slice('--url='.length) || (index >= 0 ? args[index + 1] : undefined);
  const inherited = explicit?.trim() ? null : postgresTargetFromEnvironment(env);
  return {
    connectionString: explicit?.trim() || inherited!.connectionString,
    allowRemote: args.includes('--allow-remote') || env.AGENT_ROOM_ALLOW_REMOTE_DB === '1',
  };
}

export function assertPostgresTargetAllowed(connectionString: string, allowRemote: boolean): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new PersistenceConfigurationError('Agent-room Postgres URL is malformed.');
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (!local && !allowRemote) {
    throw new PersistenceConfigurationError(
      `Remote agent-room Postgres host ${host} refused; pass --allow-remote or set AGENT_ROOM_ALLOW_REMOTE_DB=1.`,
    );
  }
}
