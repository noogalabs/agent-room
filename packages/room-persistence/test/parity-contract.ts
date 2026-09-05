import { expect } from 'vitest';
import type { Room, RoomReport } from '@agent-room/shared';
import type { RoomPersistence, RoomReceipt } from '../src/types.js';

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    );
  }
  return value;
}

export async function proveImmutableRecordParity(
  store: RoomPersistence,
  room: Room,
  report: RoomReport,
  receipt: RoomReceipt,
): Promise<void> {
  await store.createRoom(room);
  await expect(store.createRoom({ ...room, topic: 'takeover' })).rejects.toThrow('already exists');
  expect(await store.getRoom(room.code)).toEqual(room);

  await store.putMinutes(room.code, 'parity-minutes', report);
  await store.putMinutes(room.code, 'parity-minutes', report);
  await store.putMinutes(
    room.code,
    'parity-minutes',
    reverseObjectKeys(report) as RoomReport,
  );
  await expect(store.putMinutes(room.code, 'parity-minutes', {
    ...report, summary: 'conflicting minutes',
  })).rejects.toThrow('Minutes id collision');
  expect(await store.getMinutes(room.code, 'parity-minutes')).toEqual(report);

  expect(await store.appendReceipt(receipt)).toBe(true);
  expect(await store.appendReceipt(receipt)).toBe(false);
  expect(await store.appendReceipt(reverseObjectKeys(receipt) as RoomReceipt)).toBe(false);
  await expect(store.appendReceipt({
    ...receipt, payload: { disposition: 'conflicting' },
  })).rejects.toThrow('Receipt id collision');
  expect(await store.listReceipts(room.code)).toEqual([receipt]);
}

export async function proveAtomicRoomReceiptParity(
  store: RoomPersistence,
  initial: Room,
): Promise<void> {
  const receipt = (id: string): RoomReceipt => ({
    id, roomCode: initial.code, kind: 'receipt', createdAt: initial.createdAt + 1,
    payload: { memberName: id },
  });
  const legacy = receipt('legacy-roster');
  const joined = receipt('joined-roster');
  const unrelated = receipt('unrelated-receipt');
  const replacement = receipt('replacement-roster');
  const version2 = { ...initial, version: 2, topic: 'atomic join' };
  const version3 = { ...version2, version: 3, topic: 'atomic removal' };
  const version4 = { ...version3, version: 4, topic: 'atomic receipt set' };

  await store.createRoom(initial);
  expect(await store.appendReceipt(legacy)).toBe(true);
  expect(await store.compareAndSwapRoomAndReplaceReceipt(
    initial.code, initial.version + 1, version2, joined, legacy.id,
  )).toBe(false);
  expect(await store.compareAndSwapRoomAndReplaceReceipt(
    initial.code, initial.version, version2, joined, 'missing-roster',
  )).toBe(false);
  expect(await store.getRoom(initial.code)).toEqual(initial);
  expect(await store.listReceipts(initial.code)).toEqual([legacy]);

  expect(await store.compareAndSwapRoomAndReplaceReceipt(
    initial.code, initial.version, version2, joined, legacy.id,
  )).toBe(true);
  expect(await store.getRoom(initial.code)).toEqual(version2);
  expect(await store.listReceipts(initial.code)).toEqual([joined]);

  expect(await store.compareAndSwapRoomAndDeleteReceipt(
    initial.code, version2.version + 1, version3, joined.id,
  )).toBe(false);
  expect(await store.getRoom(initial.code)).toEqual(version2);
  expect(await store.listReceipts(initial.code)).toEqual([joined]);
  expect(await store.compareAndSwapRoomAndDeleteReceipt(
    initial.code, version2.version, version3, 'missing-roster',
  )).toBe(false);
  expect(await store.getRoom(initial.code)).toEqual(version2);
  expect(await store.listReceipts(initial.code)).toEqual([joined]);
  expect(await store.compareAndSwapRoomAndDeleteReceipt(
    initial.code, version2.version, version3, joined.id,
  )).toBe(true);
  expect(await store.getRoom(initial.code)).toEqual(version3);
  expect(await store.listReceipts(initial.code)).toEqual([]);

  expect(await store.appendReceipt(legacy)).toBe(true);
  expect(await store.appendReceipt(unrelated)).toBe(true);
  expect(await store.compareAndSwapRoomAndReceipts(
    initial.code, version3.version + 1, version4, [legacy.id], [replacement],
  )).toBe(false);
  expect(await store.getRoom(initial.code)).toEqual(version3);
  expect(await store.listReceipts(initial.code)).toEqual([legacy, unrelated]);
  expect(await store.compareAndSwapRoomAndReceipts(
    initial.code, version3.version, version4, [legacy.id], [replacement],
  )).toBe(true);
  expect(await store.getRoom(initial.code)).toEqual(version4);
  expect(await store.listReceipts(initial.code)).toEqual([unrelated, replacement]);
  expect(await store.deleteReceipt(initial.code, unrelated.id)).toBe(true);
  expect(await store.deleteReceipt(initial.code, unrelated.id)).toBe(false);
  expect(await store.listReceipts(initial.code)).toEqual([replacement]);
}
