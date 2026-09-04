import { applyPostgresMigrations } from './postgres.js';
import { migrationTarget } from './database-url.js';

const target = migrationTarget(process.argv.slice(2), process.env);
await applyPostgresMigrations({ connectionString: target.connectionString }, { allowRemote: target.allowRemote });
process.stdout.write('agent-room Postgres schema migrated to version 2\n');
