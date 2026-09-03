import { expect } from 'vitest';
import type { Room, RoomReport } from '@agent-room/shared';
import type { RoomPersistence, RoomReceipt } from '../src/types.js';

export async function proveImmutableRecordParity(
  store: RoomPersistence,
  room: Room,
  report: RoomReport,
  receipt: RoomReceipt,
): Promise<void> {
  await store.createRoom(room);

  await store.putMinutes(room.code, 'parity-minutes', report);
  await store.putMinutes(room.code, 'parity-minutes', report);
  await expect(store.putMinutes(room.code, 'parity-minutes', {
    ...report, summary: 'conflicting minutes',
  })).rejects.toThrow('Minutes id collision');
  expect(await store.getMinutes(room.code, 'parity-minutes')).toEqual(report);

  expect(await store.appendReceipt(receipt)).toBe(true);
  expect(await store.appendReceipt(receipt)).toBe(false);
  await expect(store.appendReceipt({
    ...receipt, payload: { disposition: 'conflicting' },
  })).rejects.toThrow('Receipt id collision');
  expect(await store.listReceipts(room.code)).toEqual([receipt]);
}
