import type { Message } from '@agent-room/shared';
import { HOSTED_IDENTITY, makeMessage, planReplies } from './agent.js';

export interface PollState {
  cursor: number;
}

export interface PollIo {
  /** Read messages from a positional cursor (room action "messages"). */
  read: (cursor: number) => Promise<Message[]>;
  /** Post one message under the hosted identity (room action "send"). */
  send: (message: Message) => Promise<void>;
  now?: () => number;
}

/**
 * One poll cycle: read from the cursor, reply, then advance the cursor ONLY to
 * the end of what was actually read. The room is an append-only array and a
 * peer's message can land between our read and our sends, occupying the
 * position a reply "should" have taken; inferring reply positions would skip
 * that message forever. Our own replies are re-read on the next cycle and
 * dropped by the self filter in planReplies, which costs nothing.
 */
export async function pollOnce(state: PollState, io: PollIo): Promise<string[]> {
  const messages = await io.read(state.cursor);
  const plan = planReplies(messages, state.cursor, HOSTED_IDENTITY.name, io.now ?? Date.now);
  for (const text of plan.replies) {
    await io.send(makeMessage(text, (io.now ?? Date.now)()));
  }
  state.cursor = plan.cursor;
  return plan.replies;
}
