import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import {
  ROOM_CAS_AND_RECEIPT_DELETE_SCRIPT,
  ROOM_CAS_AND_RECEIPT_REPLACE_SCRIPT,
  ROOM_CAS_AND_RECEIPTS_SCRIPT,
  ROOM_CAS_SCRIPT,
} from '../src/redis.js';

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl && (process.env.CI || process.env.GITHUB_ACTIONS)) {
  throw new Error('redis_lua_test_url_required: TEST_REDIS_URL must be set in CI');
}
if (!redisUrl) {
  console.warn('redis_lua_tests_skipped: TEST_REDIS_URL is not set');
}
const redisHost = redisUrl ? new URL(redisUrl).hostname : undefined;
if (redisHost && !['127.0.0.1', 'localhost', '::1'].includes(redisHost)) {
  throw new Error(`TEST_REDIS_URL must target a local disposable Redis instance, received ${redisHost}`);
}
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('Redis production Lua version guards', () => {
  let client: RedisClientType;
  const keyPrefix = `lua-guard:${process.pid}:${randomUUID()}`;
  const roomKey = `${keyPrefix}:room`;
  const receiptsKey = `${keyPrefix}:receipts`;
  const receiptIdsKey = `${keyPrefix}:receipt-ids`;
  const room = JSON.stringify({ code: 'LUA-TST-234', version: 3 });
  const nextRoom = JSON.stringify({ code: 'LUA-TST-234', version: 4 });
  const receipt = JSON.stringify({ id: 'receipt-old', roomCode: 'LUA-TST-234', kind: 'receipt', createdAt: 1, payload: {} });
  const replacement = JSON.stringify({ id: 'receipt-new', roomCode: 'LUA-TST-234', kind: 'receipt', createdAt: 2, payload: {} });

  beforeAll(async () => {
    client = createClient({ url: redisUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.del([roomKey, receiptsKey, receiptIdsKey]);
    await client.set(roomKey, room);
    await client.rPush(receiptsKey, receipt);
    await client.sAdd(receiptIdsKey, 'receipt-old');
  });

  afterAll(async () => {
    await client?.del([roomKey, receiptsKey, receiptIdsKey]);
    await client?.quit();
  });

  async function snapshot() {
    return {
      room: await client.get(roomKey),
      receipts: await client.lRange(receiptsKey, 0, -1),
      receiptIds: (await client.sMembers(receiptIdsKey)).sort(),
    };
  }

  async function evalScript(script: string, keys: string[], args: string[]) {
    return client.sendCommand(['EVAL', script, String(keys.length), ...keys, ...args]);
  }

  it('refuses stale room-only CAS before changing the room', async () => {
    const before = await snapshot();
    expect(await evalScript(ROOM_CAS_SCRIPT, [roomKey], ['2', nextRoom])).toBe(0);
    expect(await snapshot()).toStrictEqual(before);
    expect(await evalScript(ROOM_CAS_SCRIPT, [roomKey], ['3', nextRoom])).toBe(1);
    expect(await snapshot()).toStrictEqual({ ...before, room: nextRoom });
  });

  it('refuses stale delete-receipt CAS before changing room or receipts', async () => {
    const before = await snapshot();
    expect(await evalScript(ROOM_CAS_AND_RECEIPT_DELETE_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey], ['2', nextRoom, 'receipt-old'])).toBe(0);
    expect(await snapshot()).toStrictEqual(before);
    expect(await evalScript(ROOM_CAS_AND_RECEIPT_DELETE_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey], ['3', nextRoom, 'receipt-old'])).toBe(1);
    expect(await snapshot()).toStrictEqual({ room: nextRoom, receipts: [], receiptIds: [] });
  });

  it('refuses stale replace-receipt CAS before changing room or receipts', async () => {
    const before = await snapshot();
    expect(await evalScript(ROOM_CAS_AND_RECEIPT_REPLACE_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey],
      ['2', nextRoom, 'receipt-new', replacement, 'receipt-old', '4102444800'])).toBe(0);
    expect(await snapshot()).toStrictEqual(before);
    expect(await evalScript(ROOM_CAS_AND_RECEIPT_REPLACE_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey],
      ['3', nextRoom, 'receipt-new', replacement, 'receipt-old', '4102444800'])).toBe(1);
    expect(await snapshot()).toStrictEqual({ room: nextRoom, receipts: [replacement], receiptIds: ['receipt-new'] });
  });

  it('refuses stale multi-receipt CAS before changing room or receipts', async () => {
    const before = await snapshot();
    expect(await evalScript(ROOM_CAS_AND_RECEIPTS_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey],
      ['2', nextRoom, JSON.stringify(['receipt-old']), JSON.stringify([JSON.parse(replacement)]), '4102444800'])).toBe(0);
    expect(await snapshot()).toStrictEqual(before);
    expect(await evalScript(ROOM_CAS_AND_RECEIPTS_SCRIPT,
      [roomKey, receiptsKey, receiptIdsKey],
      ['3', nextRoom, JSON.stringify(['receipt-old']), JSON.stringify([JSON.parse(replacement)]), '4102444800'])).toBe(1);
    const after = await snapshot();
    expect(after.room).toBe(nextRoom);
    expect(after.receipts.map(row => JSON.parse(row))).toStrictEqual([JSON.parse(replacement)]);
    expect(after.receiptIds).toStrictEqual(['receipt-new']);
  });
});
