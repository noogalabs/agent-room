import { describe, expect, it, vi } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { reconcileCanonicalMessage, sendHostedOptimistically } from './useRoom.js';

const optimistic: Message = {
  id: 1, type: 'msg', name: 'Sam', role: 'host', initials: 'SA', color: '#123',
  client: 'web', text: 'Hello', time: 1,
};
const canonical = { ...optimistic, role: 'human' };

describe('hosted message reconciliation', () => {
  it('replaces the optimistic typed role with the server canonical message', () => {
    const unrelated = { ...optimistic, id: 2, text: 'Earlier' };
    expect(reconcileCanonicalMessage([unrelated, optimistic], canonical))
      .toEqual([unrelated, canonical]);
  });

  it('puts the canonical POST response into state through the production send path', async () => {
    let state: { room: Room | null; messages: Message[]; error: string | null } = {
      room: null, messages: [], error: null,
    };
    const update = (change: (current: typeof state) => typeof state) => { state = change(state); };
    const append = vi.fn(async () => canonical);
    const pull = vi.fn(async () => {});

    await sendHostedOptimistically(optimistic, update, append, pull);

    expect(append).toHaveBeenCalledWith(optimistic);
    expect(pull).toHaveBeenCalledOnce();
    expect(state.messages).toEqual([canonical]);
  });

  it('removes only the optimistic message when the hosted append fails', async () => {
    const unrelated = { ...optimistic, id: 2, text: 'Earlier' };
    let state: { room: Room | null; messages: Message[]; error: string | null } = {
      room: null, messages: [unrelated], error: null,
    };
    const update = (change: (current: typeof state) => typeof state) => { state = change(state); };
    const append = vi.fn(async () => { throw new Error('synthetic append failure'); });
    const pull = vi.fn(async () => {});

    await expect(sendHostedOptimistically(optimistic, update, append, pull))
      .rejects.toThrow('synthetic append failure');

    expect(append).toHaveBeenCalledWith(optimistic);
    expect(pull).not.toHaveBeenCalled();
    expect(state.messages).toEqual([unrelated]);
  });

  it('does not duplicate an optimistic id already present in state', async () => {
    let state: { room: Room | null; messages: Message[]; error: string | null } = {
      room: null, messages: [optimistic], error: null,
    };
    const update = (change: (current: typeof state) => typeof state) => { state = change(state); };
    const append = vi.fn(async () => canonical);
    const pull = vi.fn(async () => {});

    await sendHostedOptimistically(optimistic, update, append, pull);

    expect(append).toHaveBeenCalledWith(optimistic);
    expect(pull).toHaveBeenCalledOnce();
    expect(state.messages).toEqual([canonical]);
  });
});
