import { mkdtempSync, writeFileSync } from 'node:fs';
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
