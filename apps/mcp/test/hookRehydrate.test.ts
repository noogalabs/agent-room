import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_ROOM_STATE_DIR; delete process.env.CODEX_RUN_ID; delete process.env.AGENT_ROOM_STATE_FILE;
});

describe('hook credential rehydration across process scopes', () => {
  it('a room known only to the harness-scoped state file is listed with both capabilities from that same snapshot', async () => {
    // Codex harness: the hook reads state-harness-codex.json; this hook process's
    // own PPID-scoped file does not exist, so a PPID-scoped loader would miss.
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-hook-'));
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'run-1';
    delete process.env.AGENT_ROOM_STATE_FILE;
    writeFileSync(join(dir, 'state-harness-codex.json'), JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': { name: 'Me', cursor: 0, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: { ...(init.headers as Record<string, string>) }, body: String(init.body) });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    vi.resetModules();
    const { fetchPending } = await import('../src/hook.js');
    await fetchPending('harness');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.body).toContain('"code":"ABC-DEF-GHJ"');
    expect(calls[0]!.headers['x-agent-room-access']).toBe('a'.repeat(43));
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  });
});

describe('Stop cleanup keeps live rooms through outages', () => {
  async function arrange(responder: () => Promise<Response>) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-prune-'));
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'run-1';
    delete process.env.AGENT_ROOM_STATE_FILE;
    const file = join(dir, 'state-harness-codex.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': { name: 'Me', cursor: 3, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    vi.stubGlobal('fetch', vi.fn(responder));
    vi.resetModules();
    const { pruneRooms } = await import('../src/hook.js');
    const active = await pruneRooms('harness');
    const rooms = Object.keys(JSON.parse(readFileSync(file, 'utf8')).rooms);
    return { active, rooms };
  }

  it('retains the room when the room API is unreachable', async () => {
    const { active, rooms } = await arrange(async () => { throw new Error('getaddrinfo ENOTFOUND room.example'); });
    expect(rooms).toEqual(['ABC-DEF-GHJ']);
    expect(active).toEqual([]);
  });

  it('retains the room on an auth failure', async () => {
    const { rooms } = await arrange(async () => new Response(JSON.stringify({ error: 'room_access_required', message: 'Room access token required.' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    expect(rooms).toEqual(['ABC-DEF-GHJ']);
  });

  it('removes a stale room when both owned capabilities receive 403', async () => {
    const { rooms } = await arrange(async () => new Response(JSON.stringify({ error: 'room_access_denied', message: 'Room access denied.' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    expect(rooms).toEqual([]);
  });

  it('marks retained transport failures so the same Stop skips long polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-prune-failure-'));
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'run-1';
    writeFileSync(join(dir, 'state-harness-codex.json'), JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': { name: 'Me', cursor: 3, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND room.example'); }));
    vi.resetModules();
    const { pruneRoomsForStop, shouldLongPollAfterPrune } = await import('../src/hook.js');
    const result = await pruneRoomsForStop('harness');
    expect(result).toEqual({ activeRooms: [], hadRetainedFailure: true });
    expect(shouldLongPollAfterPrune(result)).toBe(false);
  });

  it('removes the room only on a definitive not-found answer', async () => {
    const { rooms } = await arrange(async () => new Response(JSON.stringify({ error: 'RoomNotFoundError', message: 'Room not found: ABC-DEF-GHJ' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(rooms).toEqual([]);
  });
});
