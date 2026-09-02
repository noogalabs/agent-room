import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomApiClient } from '../src/roomApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_ROOM_STATE_FILE;
  delete process.env.AGENT_ROOM_STATE_DIR;
  delete process.env.CODEX_RUN_ID;
});

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify({ result: { cursor: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

describe('room credential rehydration after restart', () => {
  it('a fresh client sends the persisted capabilities on its first authenticated call', async () => {
    const calls = captureFetch();
    const client = createRoomApiClient({
      loadCredentials: async (code) => (code === 'ABC-DEF-GHJ' ? { accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } : undefined),
    });
    await client.post({ action: 'send', code: 'ABC-DEF-GHJ', message: { text: 'hi' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-agent-room-access']).toBe('a'.repeat(43));
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
    client.setCredentials('ABC-DEF-GHJ', { accessToken: 'b'.repeat(43) });
    await client.post({ action: 'messages', code: 'ABC-DEF-GHJ', cursor: 0 });
    expect(calls[1]!.headers['x-agent-room-access']).toBe('b'.repeat(43));
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  });

  it('the state-file loader returns the capabilities an earlier join persisted', async () => {
    // STATE_FILE is bound when the state module loads, so point the env at a
    // temp file and load the loader fresh.
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-'));
    process.env.AGENT_ROOM_STATE_FILE = join(dir, 'state.json');
    vi.resetModules();
    const { toolCredentialLoader: stateCredentialLoader } = await import('../src/credentials.js');
    await writeFile(process.env.AGENT_ROOM_STATE_FILE, JSON.stringify({
      version: 1,
      rooms: { 'ABC-DEF-GHJ': { code: 'ABC-DEF-GHJ', name: 'Me', role: 'Dev', cursor: 0, joinedAt: 1, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    expect(await stateCredentialLoader('ABC-DEF-GHJ')).toEqual({ accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) });
    expect(await stateCredentialLoader('NOP-QRS-TUV')).toBeUndefined();
  });

  it('finds a room in merged scoped state when the harness snapshot holds another room', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-room-cred-merged-'));
    delete process.env.AGENT_ROOM_STATE_FILE;
    process.env.AGENT_ROOM_STATE_DIR = dir;
    process.env.CODEX_RUN_ID = 'test-run';
    await writeFile(join(dir, 'state-harness-codex.json'), JSON.stringify({
      version: 1, rooms: { 'HAR-NES-SON': { name: 'Other', cursor: 0, joinedAt: 2, accessToken: 'h'.repeat(43) } },
    }));
    await writeFile(join(dir, 'state-111.json'), JSON.stringify({
      version: 1, rooms: { 'SCO-PED-ONE': { name: 'Me', cursor: 0, joinedAt: 3, accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) } },
    }));
    vi.resetModules();
    const { toolCredentialLoader } = await import('../src/credentials.js');
    expect(await toolCredentialLoader('SCO-PED-ONE')).toEqual({ accessToken: 'a'.repeat(43), participantToken: 'p'.repeat(43) });
  });
});
