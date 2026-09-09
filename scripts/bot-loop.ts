// Bot auto-reply loop. Polls a room every 2s, replies to any new non-Bot message.
//
// Reply strategies, in priority order:
//  1. ANTHROPIC_API_KEY set → call api.anthropic.com directly
//  2. Otherwise            → rule-based templated reply
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... CODE=XXX-XXX-XXX \
//   [ANTHROPIC_API_KEY=sk-ant-...] \
//   npx tsx scripts/bot-loop.ts

import {
  createClient,
  getRoom,
  joinRoom,
  appendMessage,
  listMessages,
} from '../packages/upstash-client/src/index.ts';
import type { Message, Participant } from '../packages/shared/src/types.ts';
import { generateReplyAnthropic } from './bot-loop-anthropic.ts';

const env = {
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
};
const code = process.env.CODE;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!env.url || !env.token || !code) {
  console.error('Set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CODE');
  process.exit(1);
}
const mode = anthropicKey ? 'anthropic-direct' : 'rule-based';

const BOT_NAME = 'Bot';
const BOT_COLOR = '#10B981';
const BOT_INITIALS = 'BO';
const BOT_ROLE = 'Integration tester';

const client = createClient(env);

const TEMPLATES = [
  (name: string, text: string) => `@${name} got it — "${truncate(text)}". acknowledged.`,
  (name: string, text: string) => `interesting take, @${name}. "${truncate(text)}" — i'll note that.`,
  (name: string, text: string) => `@${name} received: "${truncate(text)}" ✓`,
  (name: string, text: string) => `roger that @${name}. reacting to: "${truncate(text)}"`,
  (name: string, text: string) => `@${name} thanks for "${truncate(text)}". back to work.`,
];
let templateIdx = 0;

function truncate(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function generateReplyTemplate(sender: string, text: string): string {
  const tmpl = TEMPLATES[templateIdx % TEMPLATES.length]!;
  templateIdx++;
  return tmpl(sender, text);
}

async function generateReply(topic: string, sender: string, text: string, history: Message[]): Promise<string> {
  if (anthropicKey) {
    try {
      return await generateReplyAnthropic(anthropicKey, BOT_ROLE, topic, history);
    } catch (e) {
      console.error(`[anthropic] ${String(e)} — falling back`);
    }
  }
  return generateReplyTemplate(sender, text);
}

async function main() {
  console.log(`[bot] connecting to room ${code} [mode: ${mode}]`);

  const room = await getRoom(client, code!);
  console.log(`[bot] joined "${room.topic}" hosted by ${room.createdBy}`);

  const botParticipant: Participant = {
    name: BOT_NAME,
    role: BOT_ROLE,
    color: BOT_COLOR,
    initials: BOT_INITIALS,
    client: 'cc',
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  await joinRoom(client, code!, botParticipant);

  // Start cursor at the end of existing messages — we only respond to NEW stuff
  const existing = await listMessages(client, code!, 0);
  let cursor = existing.length;
  console.log(`[bot] starting cursor at index ${cursor} (${existing.length} existing messages)`);
  console.log(`[bot] watching for new messages... (Ctrl+C to stop)`);

  while (true) {
    try {
      const fresh = await listMessages(client, code!, cursor);
      for (const msg of fresh) {
        cursor++;
        if (msg.name === BOT_NAME) continue; // skip our own messages

        const t = new Date(msg.time).toLocaleTimeString();
        console.log(`[${t}] ← ${msg.name}: ${msg.text}`);

        const replyText = await generateReply(room.topic, msg.name, msg.text, existing.concat(fresh));
        const reply: Message = {
          id: Date.now(),
          type: 'msg',
          name: BOT_NAME,
          initials: BOT_INITIALS,
          color: BOT_COLOR,
          role: BOT_ROLE,
          text: replyText,
          client: 'cc',
          time: Date.now(),
        };
        await appendMessage(client, code!, reply);
        cursor++; // account for our own reply we just RPUSHed
        const rt = new Date(reply.time).toLocaleTimeString();
        console.log(`[${rt}] → ${BOT_NAME}: ${replyText}`);
      }
    } catch (e) {
      console.error(`[bot] poll error: ${String(e)}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(e => { console.error(e); process.exit(2); });
