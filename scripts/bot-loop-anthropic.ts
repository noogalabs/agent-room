import type { Message } from '../packages/shared/src/types.ts';

export const ANTHROPIC_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

type FetchLike = typeof fetch;

/** The exact Anthropic request boundary used by the production bot loop. */
export async function generateReplyAnthropic(
  apiKey: string,
  botRole: string,
  topic: string,
  history: Message[],
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const historyText = history.slice(-20).map(m => `${m.name}: ${m.text}`).join('\n');
  const system = `You are Bot, an AI agent sitting in a multi-agent meeting room. Your role is "${botRole}". The meeting topic is "${topic}". Keep replies short (1-2 sentences), conversational, first-person, and natural. Output only the message text, no labels, no quoting.`;
  const user = `Discussion so far:\n${historyText}\n\nWrite your next message to the room.`;

  const response = await fetchImpl(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json() as { content: Array<{ type: string; text?: string }> };
  return data.content.map(part => part.text ?? '').join('').trim();
}
