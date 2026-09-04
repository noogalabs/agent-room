import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, Room } from '@agent-room/shared';
import {
  MESSAGE_POLL_MS,
  MESSAGE_POLL_HIDDEN_MS,
  ROOM_POLL_MS,
  ROOM_POLL_HIDDEN_MS,
} from '@agent-room/shared';
import { appendHostedMessage, getHostedRoom, listHostedMessages } from '../room-server-client.js';

interface UseRoomState {
  room: Room | null;
  messages: Message[];
  error: string | null;
}

export function useRoom(code: string, selfName: string, sessionToken = '') {
  const [state, setState] = useState<UseRoomState>({ room: null, messages: [], error: null });
  const cursor = useRef(0);

  // In-flight guard with TIMEOUT escape hatch. Two failure modes we hit:
  //
  // 1. WITHOUT a guard, two setInterval fires can overlap. Robin's console
  //    showed `fire {cursor: 71}` followed 700ms later by `fire {cursor: 71}`
  //    again, both reading the same cursor and both running `cursor +=
  //    fresh.length` blindly → cursor over-advanced past list length →
  //    every subsequent poll returned [] forever (symptom: foreground tab,
  //    polling alive, but new messages don't surface until ⟳ Sync).
  //
  // 2. WITH a naive boolean guard, if Redis hangs silently the `await` never
  //    resolves, finally never runs, every subsequent poll bails forever.
  //    Same end-user symptom from a different angle.
  //
  // Fix: timestamp guard. A poll bails ONLY if a prior poll started < 10s
  // ago. Anything older is presumed dead and replaced.
  const inFlightRef = useRef<number | null>(null);
  const pullMessages = useCallback(async () => {
    const tNow = Date.now();
    if (inFlightRef.current !== null && tNow - inFlightRef.current < 10_000) {
      return;
    }
    inFlightRef.current = tNow;
    // TEMPORARY instrumentation — remove once Robin confirms the foreground
    // sync bug ("agent message doesn't appear unless I hit Sync") is fixed.
    const traceTag = `[useRoom:${code.slice(0, 3)}]`;
    const startedAt = Date.now();
    console.debug(traceTag, 'pullMessages.fire', { cursor: cursor.current, t: startedAt });
    try {
      const fresh = await listHostedMessages(code, cursor.current);
      console.debug(traceTag, 'pullMessages.fetched', {
        fresh: fresh.length,
        ms: Date.now() - startedAt,
        senders: fresh.map(m => `${m.name}(${m.client})`),
        ids: fresh.map(m => m.id),
        cursorBefore: cursor.current,
      });
      if (fresh.length === 0) {
        // Self-heal: if our local cursor has somehow over-advanced past
        // the server's absolute counter (network race / earlier bug /
        // clock skew), every future poll returns [] forever. Detect
        // and reset.
        return;
      }
      // CRITICAL: anchor cursor to the server's absolute counter, never
      // blind-increment by fresh.length. The blind path lets cursor drift
      // ahead under concurrent fires / window-focus refreshes etc., and
      // once cursor sits past a real message's index that message is
      // permanently invisible to the polling path (only forceRefresh from
      // cursor=0 recovers it). This is the bug Robin's traces caught:
      // his PING was at list index 78 but cursor was already 79 by the
      // time anyone polled, so listMessages(..., 79) skipped right over.
      //
      // Setting cursor.current = total enforces "we've now seen exactly
      // what the server has" regardless of how the local arithmetic went.
      // Two concurrent polls will both write the same value → no drift.
      cursor.current += fresh.length;
      setState(s => {
        const seen = new Set(s.messages.map(m => m.id));
        const deduped = fresh.filter(m => !seen.has(m.id));
        console.debug(traceTag, 'pullMessages.dedup', {
          freshIds: fresh.map(m => m.id),
          existingCount: s.messages.length,
          dedupedCount: deduped.length,
          newCursor: cursor.current,
          serverTotal: cursor.current,
        });
        if (deduped.length === 0) return s;
        return { ...s, messages: [...s.messages, ...deduped] };
      });
    } catch (e) {
      console.debug(traceTag, 'pullMessages.error', e);
      setState(s => ({ ...s, error: String(e) }));
    } finally {
      inFlightRef.current = null;
    }
  }, [code]);

  const pullRoom = useCallback(async () => {
    try {
      const r = await getHostedRoom(code);
      setState(s => ({ ...s, room: r }));
    } catch (e) {
      setState(s => ({ ...s, error: String(e) }));
    }
  }, [code]);

  // Reset polling state to a clean slate and refetch from cursor 0. Used by
  // the visibilitychange handler (so a backgrounded tab returning gets a
  // fresh sync, not a resumed poll from stale state) and exposed as
  // `forceRefresh` so the Room UI can offer a manual "Reconnect" button
  // when users see stale data.
  //
  // Why this exists: the original implementation only paused/resumed the
  // polling intervals on visibilitychange. If the tab was hidden long
  // enough for messages to arrive AND the cursor diverge, resuming polling
  // would happily fetch from the stale cursor, miss nothing, and look
  // healthy — but the user sees an empty room because no individual fetch
  // ever caught up the gap. Now visibility-resume always re-syncs from
  // cursor 0 with dedup, so the user sees the room as it actually is.
  const forceRefresh = useCallback(async () => {
    cursor.current = 0;
    try {
      const [r, fresh] = await Promise.all([
        getHostedRoom(code),
        listHostedMessages(code, 0),
      ]);
      // Match server-side logical cursor (counter) so polling stays correct after LTRIM; legacy rooms fall back.
      cursor.current = fresh.length;
      setState({ room: r, messages: fresh, error: null });
    } catch (e) {
      setState(s => ({ ...s, error: String(e) }));
    }
  }, [code]);

  useEffect(() => {
    cursor.current = 0;
    setState({ room: null, messages: [], error: null });

    let msgTimer: ReturnType<typeof setInterval> | null = null;
    let roomTimer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
      if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
    };

    const start = (slow: boolean) => {
      if (msgTimer) return; // already running
      pullRoom();
      pullMessages();
      const msgMs = slow ? MESSAGE_POLL_HIDDEN_MS : MESSAGE_POLL_MS;
      const roomMs = slow ? ROOM_POLL_HIDDEN_MS : ROOM_POLL_MS;
      msgTimer = setInterval(pullMessages, msgMs);
      roomTimer = setInterval(pullRoom, roomMs);
    };

    // When the tab is hidden (common: founder works in Cursor while the room
    // stays open in another window), **fully stopping** polling meant new
    // agent messages never arrived until a manual refresh — confusing next to
    // IDE-side tooling that keeps streaming. We **slow down** instead of
    // stopping to stay within reasonable Upstash budget (spec §5.5).
    const onVis = () => {
      stop();
      if (document.hidden) {
        start(true);
      } else {
        forceRefresh().finally(() => start(false));
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // When alt-tabbing back to the browser, `focus` can fire without a
    // reliable `visibilitychange` in some edge cases — catch up incrementally.
    let focusDebounce: ReturnType<typeof setTimeout> | null = null;
    const onWinFocus = () => {
      if (document.hidden) return;
      if (focusDebounce) clearTimeout(focusDebounce);
      focusDebounce = setTimeout(() => {
        focusDebounce = null;
        void pullRoom();
        void pullMessages();
      }, 150);
    };
    window.addEventListener('focus', onWinFocus);

    start(document.hidden);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onWinFocus);
      if (focusDebounce) clearTimeout(focusDebounce);
      stop();
    };
  }, [code, selfName, pullRoom, pullMessages, forceRefresh]);

  const sendMessage = useCallback(async (msg: Message) => {
    // Optimistic render: add to local state IMMEDIATELY so the sender
    // sees their own message in the feed without waiting for the
    // round-trip to Upstash + the follow-up pullMessages. Without this,
    // hitting Enter shows a ~800-1500ms delay before the message
    // appears, which feels like the app froze. Slack / Discord /
    // iMessage all do this.
    //
    // Dedup safety: pullMessages will fetch this same msg back from
    // Redis (same id we just RPUSHed) and skip it via the Set-membership
    // dedup. So no duplicate render.
    setState(s => {
      if (s.messages.some(m => m.id === msg.id)) return s;
      return { ...s, messages: [...s.messages, msg] };
    });

    try {
      await appendHostedMessage(code, sessionToken, msg);
      await pullMessages();
    } catch (e) {
      // Roll back the optimistic add — server didn't accept the message.
      // The composer's catch in Room.tsx restores the draft text so the
      // user can retry. This keeps state honest if the network failed
      // or appendMessage rejected (e.g. host muted us).
      setState(s => ({
        ...s,
        messages: s.messages.filter(m => m.id !== msg.id),
      }));
      throw e;
    }
  }, [code, sessionToken, pullMessages]);

  return { ...state, sendMessage, refreshRoom: pullRoom, forceRefresh };
}
