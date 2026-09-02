import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachmentBytes, resolveAttachmentUrl } from '../src/tools.js';

afterEach(() => { delete process.env.AGENT_ROOM_BASE_URL; });

describe('attachment reader against a self-hosted room', () => {
  it('resolves a relative attachment url against the room base and presents the access header', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    expect(resolveAttachmentUrl('/attachments/ABC-file.txt')).toBe('https://room.example/attachments/ABC-file.txt');
    expect(resolveAttachmentUrl('https://cdn.example/x.txt')).toBe('https://cdn.example/x.txt');
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const bytes = await fetchAttachmentBytes('/attachments/ABC-file.txt', 1024, { accessToken: 'a'.repeat(43) }, fetchFn);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ url: 'https://room.example/attachments/ABC-file.txt', headers: { 'x-agent-room-access': 'a'.repeat(43) } }]);
  });
});
