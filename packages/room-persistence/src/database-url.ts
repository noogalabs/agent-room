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

export interface PostgresTargetConfig {
  connectionString?: string;
  host?: string;
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

export function postgresTargetHost(
  config: PostgresTargetConfig,
  env: Partial<Pick<NodeJS.ProcessEnv, 'PGHOST'>> = process.env,
): string {
  if (config.connectionString?.trim()) {
    try {
      return new URL(config.connectionString).hostname;
    } catch {
      throw new PersistenceConfigurationError('Agent-room Postgres URL is malformed.');
    }
  }
  return config.host?.trim() || env.PGHOST?.trim() || 'localhost';
}

export function assertPostgresTargetAllowed(
  config: PostgresTargetConfig,
  allowRemote: boolean,
  env: Partial<Pick<NodeJS.ProcessEnv, 'PGHOST'>> = process.env,
): void {
  const host = postgresTargetHost(config, env);
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    || host.startsWith('/');
  if (!local && !allowRemote) {
    throw new PersistenceConfigurationError(
      `Remote agent-room Postgres host ${host} refused; pass --allow-remote or set AGENT_ROOM_ALLOW_REMOTE_DB=1.`,
    );
  }
}
