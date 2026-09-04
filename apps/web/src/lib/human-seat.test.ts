import { describe, expect, it } from 'vitest';
import { clearHumanSeat, loadHumanSeat, persistHumanSeat } from './human-seat.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('human seat browser lifecycle', () => {
  it('restores the room-scoped session after reload and explicit leave frees it', () => {
    const storage = memoryStorage();
    const seat = { name: 'Sam', role: 'human', token: 'signed-session' };
    persistHumanSeat('ROOM1', seat, storage);
    expect(loadHumanSeat('ROOM1', storage)).toEqual(seat);
    expect(loadHumanSeat('ROOM2', storage)).toBeNull();
    clearHumanSeat('ROOM1', storage);
    expect(loadHumanSeat('ROOM1', storage)).toBeNull();
  });
});
