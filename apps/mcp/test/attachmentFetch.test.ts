import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentAuthHeaders, fetchAttachmentBytes, readAttachmentText, resolveAttachmentUrl } from '../src/tools.js';

afterEach(() => { delete process.env.AGENT_ROOM_BASE_URL; vi.unstubAllGlobals(); });

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

describe('room capability never leaves the room origin', () => {
  it('sends the access header to the room origin only, never to a third-party attachment host', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const auth = { accessToken: 'a'.repeat(43) };
    expect(attachmentAuthHeaders('https://room.example/attachments/x.txt', auth)).toEqual({ 'x-agent-room-access': auth.accessToken });
    expect(attachmentAuthHeaders('https://cdn.example/x.txt', auth)).toEqual({});
    expect(attachmentAuthHeaders('https://room.example.evil.test/x.txt', auth)).toEqual({});
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAttachmentBytes('https://cdn.example/public.txt', 1024, auth, fetchFn);
    await fetchAttachmentBytes('/attachments/ABC-x.txt', 1024, auth, fetchFn);
    expect(seen).toEqual([
      { url: 'https://cdn.example/public.txt', headers: {} },
      { url: 'https://room.example/attachments/ABC-x.txt', headers: { 'x-agent-room-access': auth.accessToken } },
    ]);
  });
});

describe('self-hosted image attachments', () => {
  it('returns the image bytes through the authenticated reader instead of a url the caller cannot open', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    }));
    const read = await readAttachmentText(
      { id: 'i1', type: 'image', url: '/attachments/ABC-pic.png', storageKey: 'k', name: 'pic.png', size: 4, mime: 'image/png', uploadedAt: 1 },
      1000,
      { accessToken: 'a'.repeat(43) },
    );
    expect(read.source).toBe('fetched_image');
    expect(read.mime).toBe('image/png');
    expect(Buffer.from(read.image ?? '', 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(read.warning).toBeUndefined();
    expect(seen).toEqual([{ url: 'https://room.example/attachments/ABC-pic.png', headers: { 'x-agent-room-access': 'a'.repeat(43) } }]);
  });
});
