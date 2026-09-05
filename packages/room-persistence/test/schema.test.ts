import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTGRES_SCHEMA_SQL } from '../src/schema.js';

describe('migration custody', () => {
  it('keeps the shipped migration byte-equivalent to the schema applied by the adapter', () => {
    const first = fileURLToPath(new URL('../migrations/001_durable_room_record.sql', import.meta.url));
    const second = fileURLToPath(new URL('../migrations/002_persisted_fleet_trust.sql', import.meta.url));
    const third = fileURLToPath(new URL('../migrations/003_receipt_insertion_sequence.sql', import.meta.url));
    expect([first, second, third].map(path => readFileSync(path, 'utf8').trim()).join('\n\n'))
      .toBe(POSTGRES_SCHEMA_SQL.trim());
  });
});
