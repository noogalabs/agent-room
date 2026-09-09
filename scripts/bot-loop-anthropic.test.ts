import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../packages/shared/src/types.ts';
import {
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_MODEL,
  generateReplyAnthropic,
} from './bot-loop-anthropic.ts';

function message(name: string, text: string, id: number): Message {
  return {
    id,
    type: 'msg',
    name,
    initials: name.slice(0, 2).toUpperCase(),
    color: '#000000',
    role: 'Tester',
    text,
    client: 'cc',
    time: id,
  };
}

describe('agent-room-mcp-prod bot Anthropic service', () => {
  it('sends the production request with the Sonnet 5 model pin', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '  service reply  ' }],
    }), { status: 200 })) as unknown as typeof fetch;

    const reply = await generateReplyAnthropic(
      'test-key',
      'Integration tester',
      'Model migration',
      [message('David', 'Please verify the service model.', 1)],
      fetchImpl,
    );

    expect(ANTHROPIC_MODEL).toBe('claude-sonnet-5');
    expect(reply).toBe('service reply');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(expect.objectContaining({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }));
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: expect.stringContaining('David: Please verify the service model.'),
      }],
    }));
  });

  it('keeps Anthropic failures distinguishable for the bot fallback path', async () => {
    const fetchImpl = vi.fn(async () => new Response('model unavailable', {
      status: 503,
    })) as unknown as typeof fetch;

    await expect(generateReplyAnthropic(
      'test-key',
      'Integration tester',
      'Model migration',
      [],
      fetchImpl,
    )).rejects.toThrow('Anthropic HTTP 503: model unavailable');
  });
});
