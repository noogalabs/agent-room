export interface StoredHumanSeat { name: string; role: string; token: string }

const key = (code: string) => `room:${code}:self`;

export function persistHumanSeat(code: string, seat: StoredHumanSeat, storage: Storage = sessionStorage): void {
  storage.setItem(key(code), JSON.stringify(seat));
}

export function loadHumanSeat(code: string, storage: Storage = sessionStorage): StoredHumanSeat | null {
  const value = storage.getItem(key(code));
  if (!value) return null;
  try { return JSON.parse(value) as StoredHumanSeat; }
  catch { return null; }
}

export function clearHumanSeat(code: string, storage: Storage = sessionStorage): void {
  storage.removeItem(key(code));
}
