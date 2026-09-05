import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const migration = (name: string) => readFileSync(fileURLToPath(
  new URL(`../migrations/${name}`, import.meta.url),
), 'utf8');

describePostgres('Postgres migration upgrades', () => {
  it('backfills legacy receipt order deterministically, then preserves append order', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `receipt_order_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const receiptJson = (id: string, createdAt: number) => JSON.stringify({
      id, roomCode: 'MIGRATE-ORDER', kind: 'receipt', createdAt, payload: { id },
    });
    const insert = async (id: string, createdAt: number) => isolated.query(`
      INSERT INTO agent_room_receipts
        (room_code, receipt_id, receipt_kind, receipt_json, created_at)
      VALUES ('MIGRATE-ORDER', $1, 'receipt', $2::jsonb, $3)
    `, [id, receiptJson(id, createdAt), createdAt]);
    const ids = async (where = '') => (await isolated.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM agent_room_receipts ${where} ORDER BY insertion_sequence`,
    )).rows.map(row => row.receipt_id);
    try {
      await isolated.query(migration('001_durable_room_record.sql'));
      await isolated.query(migration('002_persisted_fleet_trust.sql'));
      await isolated.query(`INSERT INTO agent_room_rooms
        (code, topic, created_at, created_by, status, version, room_json, updated_at)
        VALUES ('MIGRATE-ORDER', 'Migration ordering', 1000, 'Host', 'active', 1,
          '{"code":"MIGRATE-ORDER"}'::jsonb, 1000)`);

      // Heap order B,A is deliberately opposite to deterministic legacy order A,B.
      await insert('receipt-b', 2_000);
      await insert('receipt-a', 1_000);
      // Equal timestamps deliberately use insertion order z,a, opposite to the legacy ID tie-break.
      await insert('tie-z', 3_000);
      await insert('tie-a', 3_000);

      await isolated.query(migration('003_receipt_insertion_sequence.sql'));
      expect(await ids()).toEqual(['receipt-a', 'receipt-b', 'tie-a', 'tie-z']);
      expect(await ids('WHERE created_at = 3000')).toEqual(['tie-a', 'tie-z']);

      await insert('post-z', 1_000);
      await insert('post-a', 1_000);
      expect(await ids()).toEqual([
        'receipt-a', 'receipt-b', 'tie-a', 'tie-z', 'post-z', 'post-a',
      ]);
      await isolated.query(migration('003_receipt_insertion_sequence.sql'));
    } finally {
      await isolated.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
