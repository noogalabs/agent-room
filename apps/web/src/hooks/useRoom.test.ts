import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-room/shared';
import { reconcileCanonicalMessage } from './useRoom.js';

describe('hosted message reconciliation', () => {
  it('replaces the optimistic typed role with the server canonical message', () => {
    const optimistic: Message = {
      id: 1, type: 'msg', name: 'Sam', role: 'host', initials: 'SA', color: '#123',
      client: 'web', text: 'Hello', time: 1,
    };
    const canonical = { ...optimistic, role: 'human' };
    const unrelated = { ...optimistic, id: 2, text: 'Earlier' };

    expect(reconcileCanonicalMessage([unrelated, optimistic], canonical))
      .toEqual([unrelated, canonical]);
  });

  it('uses the canonical POST response in the production send path', () => {
    const source = readFileSync(fileURLToPath(new URL('./useRoom.ts', import.meta.url)), 'utf8');
    expect(source).toContain('const canonical = await appendHostedMessage(');
    expect(source).toContain('reconcileCanonicalMessage(s.messages, canonical)');
  });
});
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
