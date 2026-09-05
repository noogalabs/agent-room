import { describe, expect, it } from 'vitest';
import { ROOM_TTL_SECONDS, type Message, type Room, type RoomReport, type TaskBoard } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { RoomRecordServer } from '../src/server.js';
import { RedisRoomPersistence } from '../src/redis.js';
import { TaskLeaseServer, type LeaseActor } from '../src/task-leases.js';
import type { RoomReceipt } from '../src/types.js';
import { proveAtomicRoomReceiptParity, proveImmutableRecordParity } from './parity-contract.js';

class RecordingRedis implements UpstashClient {
  readonly commands: Array<readonly (string | number)[]> = [];
  readonly pipelines: Array<readonly (readonly (string | number)[])[]> = [];
  private readonly values = new Map<string, string>();

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    this.commands.push(command);
    const [name, key, value] = command;
    if (name === 'SET') {
      if (command.includes('NX') && this.values.has(String(key))) return null as T;
      this.values.set(String(key), String(value));
      return 'OK' as T;
    }
    if (name === 'GET') return (this.values.get(String(key)) ?? null) as T;
    if (name === 'LRANGE') return [] as T;
    if (name === 'EVAL') return 1 as T;
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    this.pipelines.push(commands);
    return commands.map((command, index) => {
      if (command[0] === 'INCR') return 1 as T;
      if (command[0] === 'LLEN') return 0 as T;
      if (command[0] === 'GET') return null as T;
      return (index + 1) as T;
    });
  }
}

class ExpiringRedis implements UpstashClient {
  private nowSeconds = 1_700_000_000;
  private readonly values = new Map<string, string>();
  private readonly expiries = new Map<string, number>();

  advance(seconds: number): void { this.nowSeconds += seconds; }

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name, rawKey, rawValue] = command;
    const key = String(rawKey);
    if (name === 'SET') {
      if (command.includes('NX') && this.values.has(key)) return null as T;
      this.values.set(key, String(rawValue));
      const exIndex = command.indexOf('EX');
      if (exIndex >= 0) this.expiries.set(key, this.nowSeconds + Number(command[exIndex + 1]));
      return 'OK' as T;
    }
    if (name === 'GET') {
      if ((this.expiries.get(key) ?? Infinity) <= this.nowSeconds) {
        this.values.delete(key);
        this.expiries.delete(key);
      }
      return (this.values.get(key) ?? null) as T;
    }
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(_commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return [];
  }
}

class StatefulRedis implements UpstashClient {
  private readonly values = new Map<string, string>();
  private readonly receiptIds = new Set<string>();
  private readonly lists = new Map<string, string[]>();

  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name, rawKey] = command;
    const key = String(rawKey);
    if (name === 'SET') {
      if (command.includes('NX') && this.values.has(key)) return null as T;
      this.values.set(key, String(command[2]));
      return 'OK' as T;
    }
    if (name === 'GET') return (this.values.get(key) ?? null) as T;
    if (name === 'LRANGE') return (this.lists.get(key) ?? []) as T;
    if (name === 'EVAL') {
      const script = String(command[1]);
      if (script.includes('Minutes id collision')) {
        const minutesKey = String(command[3]);
        const payload = String(command[4]);
        const reportId = String(command[5]);
        const existing = this.values.get(minutesKey);
        if (existing === payload) return 0 as T;
        if (existing !== undefined) throw new Error(`Minutes id collision: ${reportId}`);
        this.values.set(minutesKey, payload);
        return 1 as T;
      }
      if (script.includes('Receipt id collision')) {
        const idsKey = String(command[3]);
        const listKey = String(command[4]);
        const id = String(command[5]);
        const payload = String(command[6]);
        const compositeId = `${idsKey}:${id}`;
        if (this.receiptIds.has(compositeId)) {
          const existing = (this.lists.get(listKey) ?? []).find(row => JSON.parse(row).id === id);
          if (existing === payload) return 0 as T;
          throw new Error(`Receipt id collision: ${id}`);
        }
        this.receiptIds.add(compositeId);
        this.lists.set(listKey, [...(this.lists.get(listKey) ?? []), payload]);
        return 1 as T;
      }
      const roomKey = String(command[3]);
      const listKey = String(command[4]);
      const idsKey = String(command[5]);
      const currentRaw = this.values.get(roomKey);
      if (!currentRaw) return 0 as T;
      const current = JSON.parse(currentRaw) as Room;
      const expectedVersion = Number(command[6]);
      if (current.version !== expectedVersion) return 0 as T;
      const rows = this.lists.get(listKey) ?? [];
      const hasReceipt = (id: string) => this.receiptIds.has(`${idsKey}:${id}`);
      const removeReceipt = (id: string) => {
        const index = rows.findIndex(row => (JSON.parse(row) as RoomReceipt).id === id);
        if (index < 0 || !hasReceipt(id)) return false;
        rows.splice(index, 1); this.receiptIds.delete(`${idsKey}:${id}`); return true;
      };
      if (script.includes('receipt_row')) {
        const id = String(command[8]);
        if (!hasReceipt(id)) return 0 as T;
        this.values.set(roomKey, String(command[7])); removeReceipt(id);
        this.lists.set(listKey, rows); return 1 as T;
      }
      if (script.includes('legacy_row')) {
        const appendId = String(command[8]); const payload = String(command[9]);
        const deleteId = String(command[10]);
        if (hasReceipt(appendId) || (deleteId && !hasReceipt(deleteId))) return 0 as T;
        this.values.set(roomKey, String(command[7]));
        if (deleteId) removeReceipt(deleteId);
        this.receiptIds.add(`${idsKey}:${appendId}`); rows.push(payload);
        this.lists.set(listKey, rows); return 1 as T;
      }
      if (script.includes('delete_rows')) {
        const deletes = JSON.parse(String(command[8])) as string[];
        const appends = JSON.parse(String(command[9])) as RoomReceipt[];
        if (deletes.some(id => !hasReceipt(id)) || appends.some(item =>
          !deletes.includes(item.id) && hasReceipt(item.id))) return 0 as T;
        this.values.set(roomKey, String(command[7]));
        deletes.forEach(removeReceipt);
        for (const item of appends) {
          this.receiptIds.add(`${idsKey}:${item.id}`); rows.push(JSON.stringify(item));
        }
        this.lists.set(listKey, rows); return 1 as T;
      }
    }
    throw new Error(`Unsupported fake command ${String(name)}`);
  }

  async pipeline<T>(commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return commands.map(command => {
      if (command[0] === 'LREM') {
        const rows = this.lists.get(String(command[1])) ?? [];
        const index = rows.indexOf(String(command[3]));
        if (index < 0) return 0 as T;
        rows.splice(index, 1); return 1 as T;
      }
      if (command[0] === 'SREM') {
        return Number(this.receiptIds.delete(`${String(command[1])}:${String(command[2])}`)) as T;
      }
      return 0 as T;
    });
  }
}

class LeaseCasRedis implements UpstashClient {
  readonly values = new Map<string, string>();
  removeParticipant(code: string, name: string): void {
    const key = `room:${code}`;
    const current = JSON.parse(this.values.get(key)!) as Room;
    this.values.set(key, JSON.stringify({ ...current, version: current.version + 1,
      participants: current.participants.filter(item => item.name !== name) }));
  }
  async command<T>(command: readonly (string | number)[]): Promise<T> {
    const [name] = command;
    if (name === 'SET') { this.values.set(String(command[1]), String(command[2])); return 'OK' as T; }
    if (name === 'GET') return (this.values.get(String(command[1])) ?? null) as T;
    if (name === 'LRANGE') return [] as T;
    if (name === 'EVAL') {
      const script = String(command[1]);
      if (script.includes('Receipt id collision')) return 1 as T;
      if (!script.includes('lease event id collision')) throw new Error('unexpected script');
      const boardKey = String(command[3]);
      const roomKey = String(command[6]);
      const current = JSON.parse(this.values.get(boardKey)!) as TaskBoard;
      if (current.version !== Number(command[8])) return 0 as T;
      if (script.includes('required_members')) {
        const activeRoom = JSON.parse(this.values.get(roomKey)!) as Room;
        const required = JSON.parse(String(command[13])) as Array<{ memberId: string; name: string; client: string }>;
        if (activeRoom.version !== Number(command[12]) || required.some(member =>
          !activeRoom.participants.some(item => item.authenticatedIdentity?.cardFingerprint === member.memberId &&
            item.name === member.name && item.client === member.client))) return 0 as T;
      }
      this.values.set(boardKey, String(command[9]));
      return 1 as T;
    }
    throw new Error(`Unsupported lease Redis command ${String(name)}`);
  }
  async pipeline<T>(): Promise<T[]> { return []; }
}

class FleetTrustRedis implements UpstashClient {
  private readonly values = new Map<string, string>();
  private readonly ids = new Set<string>();
  async command<T>(command: readonly (string | number)[]): Promise<T> {
    if (command[0] === 'SMEMBERS') return [...this.ids] as T;
    if (command[0] === 'MGET') return command.slice(1).map(key => this.values.get(String(key)) ?? null) as T;
    throw new Error(`Unsupported fleet trust command ${String(command[0])}`);
  }
  async pipeline<T>(commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return commands.map(command => {
      if (command[0] === 'SET') { this.values.set(String(command[1]), String(command[2])); return 'OK' as T; }
      if (command[0] === 'SADD') { const size = this.ids.size; this.ids.add(String(command[2])); return Number(this.ids.size !== size) as T; }
      if (command[0] === 'DEL') { const removed = this.values.delete(String(command[1])); return Number(removed) as T; }
      if (command[0] === 'SREM') { const removed = this.ids.delete(String(command[2])); return Number(removed) as T; }
      throw new Error(`Unsupported fleet trust pipeline ${String(command[0])}`);
    });
  }
}

const leaseAlice: LeaseActor = { memberId: 'redis-alice', name: 'Alice', client: 'cc' };
const leaseBob: LeaseActor = { memberId: 'redis-bob', name: 'Bob', client: 'cc' };

function leaseRoom(): Room {
  const participant = (actor: LeaseActor) => ({
    name: actor.name, role: 'builder', color: '#123', initials: actor.name.slice(0, 2), client: actor.client,
    joinedAt: 1, lastSeenAt: 1, authenticatedIdentity: { cardFingerprint: actor.memberId,
      fleetId: 'fleet', cardName: actor.name, scheme: 'oauth2' as const, keyId: 'key', verifiedAt: 1 },
  });
  return { ...room(), version: 1, participants: [participant(leaseAlice), participant(leaseBob)] };
}

function leaseBoard(): TaskBoard {
  return { code: room().code, version: 1, tasks: [{ id: 'T-REDIS', title: 'Redis race',
    state: 'in_progress', createdBy: 'Host', createdAt: 1, updatedAt: 1 }] };
}

function room(): Room {
  return {
    code: 'ABC-DEF-GHJ', topic: 'Synthetic room', createdAt: 1_700_000_000_000,
    createdBy: 'Host', status: 'active', version: 1, participants: [],
  };
}

function message(): Message {
  return {
    id: 1_700_000_000_100, type: 'msg', name: 'Agent', initials: 'AG', color: '#000',
    role: 'builder', text: 'synthetic message', client: 'cc', time: 1_700_000_000_100,
  };
}

function report(): RoomReport {
  return {
    code: room().code, topic: room().topic, createdAt: room().createdAt,
    exportedAt: 1_700_000_000_300, participants: [], messageCount: 0,
    summary: 'Synthetic minutes', highlights: [], decisions: [], actionItems: [], artifacts: [], transcript: [],
  };
}

function receipt(): RoomReceipt {
  return {
    id: 'receipt-1', roomCode: room().code, kind: 'receipt',
    createdAt: 1_700_000_000_400, payload: { disposition: 'accepted' },
  };
}

describe('RedisRoomPersistence compatibility', () => {
  it('keeps Redis as the production default and the existing hard room TTL', async () => {
    const redis = new RecordingRedis();
    const server = await RoomRecordServer.fromEnvironment({}, { redisClient: redis });

    expect(server.persistence.kind).toBe('redis');
    await server.createRoom(room());

    expect(redis.commands[0]).toEqual([
      'SET', 'room:ABC-DEF-GHJ', JSON.stringify(room()), 'EX', ROOM_TTL_SECONDS, 'NX',
    ]);
    await expect(server.createRoom(room())).rejects.toThrow('already exists');
  });

  it('expires a production-entry Redis room after a 25-hour clock skip', async () => {
    const redis = new ExpiringRedis();
    const server = await RoomRecordServer.fromEnvironment({}, { redisClient: redis });
    await server.createRoom(room());
    expect(await server.getRoom(room().code)).toEqual(room());

    redis.advance(25 * 60 * 60);

    expect(await server.getRoom(room().code)).toBeNull();
  });

  it('deletes a just-created Redis room only at its expected version', async () => {
    const redis = new RecordingRedis();
    const store = new RedisRoomPersistence(redis);
    await expect(store.deleteRoomIfVersion(room().code, 1)).resolves.toBe(true);
    expect(redis.commands[0]).toEqual([
      'EVAL', expect.stringContaining('tonumber(ARGV[1])'), '6',
      'room:ABC-DEF-GHJ', 'room-msgs:ABC-DEF-GHJ', 'room-msg-count:ABC-DEF-GHJ',
      'task-board:ABC-DEF-GHJ', 'room-receipts:ABC-DEF-GHJ', 'room-receipt-ids:ABC-DEF-GHJ', '1',
    ]);
  });

  it('uses the existing message keys, trim cap, count, and creation-anchored expiry', async () => {
    const redis = new RecordingRedis();
    const store = new RedisRoomPersistence(redis);
    await store.createRoom(room());
    await store.appendMessage(room().code, message());

    expect(redis.pipelines[0]).toEqual([
      ['RPUSH', 'room-msgs:ABC-DEF-GHJ', JSON.stringify(message())],
      ['INCR', 'room-msg-count:ABC-DEF-GHJ'],
      ['LTRIM', 'room-msgs:ABC-DEF-GHJ', -500, -1],
      ['EXPIREAT', 'room-msgs:ABC-DEF-GHJ', Math.floor(room().createdAt / 1000) + ROOM_TTL_SECONDS],
      ['EXPIREAT', 'room-msg-count:ABC-DEF-GHJ', Math.floor(room().createdAt / 1000) + ROOM_TTL_SECONDS],
    ]);
  });

  it('fails closed on an unknown adapter instead of silently changing storage', async () => {
    await expect(RoomRecordServer.fromEnvironment(
      { AGENT_ROOM_PERSISTENCE: 'mystery' },
      { redisClient: new RecordingRedis() },
    )).rejects.toThrow(/must be redis or postgres/);
  });

  it('matches the durable adapter collision contract for minutes and receipts', async () => {
    const store = new RedisRoomPersistence(new StatefulRedis());
    await proveImmutableRecordParity(store, room(), report(), receipt());
  });

  it('matches the durable adapter contract for atomic room and receipt mutations', async () => {
    await proveAtomicRoomReceiptParity(
      new RedisRoomPersistence(new StatefulRedis()),
      { ...room(), code: 'RED-ATM-PTY' },
    );
  });

  it('persists and selectively revokes fleet trust keys without a room TTL', async () => {
    const store = new RedisRoomPersistence(new FleetTrustRedis());
    const first = { fleetId: 'fleet-one', keyId: 'key-one', publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'one' } };
    const second = { fleetId: 'fleet-two', keyId: 'key-two', publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'two' } };
    await store.putFleetTrustKey(first); await store.putFleetTrustKey(second);
    expect(await store.listFleetTrustKeys()).toEqual([first, second]);
    expect(await store.deleteFleetTrustKey('fleet-one', 'key-one')).toBe(true);
    expect(await store.listFleetTrustKeys()).toEqual([second]);
  });

  it('sends the board transition and lease receipts through one Redis script', async () => {
    const redis = new RecordingRedis();
    const store = new RedisRoomPersistence(redis);
    const next = { code: room().code, version: 2, tasks: [] };
    expect(await store.compareAndSwapTaskBoardWithLeaseEvents(room().code, 1, next, [{
      id: 'lease-event-1', roomCode: room().code, event: 'granted', actor: 'fingerprint',
      leaseId: 'task-lease-1', at: 10, details: { taskId: 'T-01' },
    }])).toBe(true);

    const command = redis.commands.at(-1)!;
    expect(command.slice(0, 7)).toEqual([
      'EVAL', expect.any(String), '4', `task-board:${room().code}`,
      `room-receipt-ids:${room().code}`, `room-receipts:${room().code}`, `room:${room().code}`,
    ]);
    expect(command.join(' ')).toContain('lease-event-1');
    expect(command.join(' ')).toContain('"leaseEvent":"granted"');
  });

  it.each([
    ['claim', leaseAlice.name],
    ['handoff grant', leaseBob.name],
  ] as const)('keeps Redis %s membership atomic when the member leaves at commit', async (_label, leaving) => {
    const redis = new LeaseCasRedis();
    const store = new RedisRoomPersistence(redis);
    await store.createRoom(leaseRoom());
    redis.values.set(`task-board:${room().code}`, JSON.stringify(leaseBoard()));
    const original = store.compareAndSwapTaskBoardWithLeaseEvents.bind(store);
    let armed = _label === 'claim';
    store.compareAndSwapTaskBoardWithLeaseEvents = async (...args) => {
      if (armed) { armed = false; redis.removeParticipant(room().code, leaving); }
      return original(...args);
    };
    const leases = new TaskLeaseServer(new RoomRecordServer(store), () => 100, () => 'id');
    if (_label === 'handoff grant') {
      await leases.claim(room().code, 'T-REDIS', leaseAlice);
      await leases.requestHandoff(room().code, 'T-REDIS', leaseBob);
      armed = true;
    }
    await expect(_label === 'claim'
      ? leases.claim(room().code, 'T-REDIS', leaseAlice)
      : leases.grantHandoff(room().code, 'T-REDIS', leaseAlice))
      .rejects.toMatchObject({ name: 'task_lease_authenticated_member_required' });
    expect((await store.getTaskBoard(room().code))?.tasks[0]?.lease?.holderId)
      .not.toBe(leaving === leaseAlice.name ? leaseAlice.memberId : leaseBob.memberId);
  });
});
