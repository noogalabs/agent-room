# Human seat through the authenticated room server

## Existing web call census

Before this change the browser talked directly to `@agent-room/upstash-client`. `Join` called `getRoom`, `verifyHostKey`, and `joinRoom`; `Lobby` called the same three; `CreateMeeting` called `createRoom`; `useRoom` called `getRoom`, `listMessages`, `getMessageTotalCount`, `appendMessage`, and `updatePresence`. `Room` additionally called the host controls (`appendSystemMessage`, `directInvoke`, turn controls, mute/reply-mode controls, report/end/reactivate/remove), while `Report` read rooms/messages and created/read reports. All browser room storage calls now go through `room-server-client`; no screen or hook imports the storage client, and no Redis credential is bundled into Vite. Durable host actions are authenticated room-server routes. The legacy turn queue has an explicit server seam that currently returns no active turn rather than letting the browser bypass persistence.

## Security and hosting contract

The host creates a short-lived, single-use invite with its server-side bearer credential. The browser exchanges that invite for an HMAC-signed session capability; the persisted participant has an `oauth2` authenticated identity and the signed capability fixes the room, human name, and `human` role. Message writes require that capability and an exactly matching authenticated participant. A watch capability has no write authority. Invite issue, redemption, and revocation are durable receipt records.

`VITE_ROOM_SERVER_BASE_URL` selects the hosted API (an empty value means same origin). The production image builds `apps/web` and `apps/room-server`; room-server serves the built SPA and remains the only process entrypoint.

## Five-line walkthrough

1. David opens New Meeting; room-server creates his signed human host seat.
2. The lobby issues and copies `/j/<room>?invite=<capability>` through room-server.
3. Enter a display name and optional job title; the server records the seat as role `human`.
4. Post a message; it is accepted only with the browser session bound to that exact person and room.
5. Revoke the invite to invalidate its established session, and use an expired watch link to confirm it remains read-only.

## Guard-removal kill record

The production-entry test `binds human invite, session, join and post identity while watch tokens stay read-only` is the mutation casualty for the HTTP boundary. Removing the bearer verification makes its unauthenticated-post assertion RED; accepting a signed watch capability makes its `watch_session_expired` assertion RED; removing the message/session name-and-client comparison makes its agent/other-human impersonation assertion RED; removing the durable participant identity check makes its persisted-identity assertion RED; and removing the redeemed/revoked receipt checks makes its reuse and established-session-revocation assertions RED. The focused capability test `refuses expired and tampered human sessions by name` turns RED when signature comparison or session expiry is removed. `refuses a revoked human invite before participant mutation` turns RED when the pre-join revocation lookup is removed. `browser host creates a signed seat and issues a capability-bearing lobby invite` turns RED if the hosted lobby path loses the invite capability. The consumer census enumerates every browser screen and hook; any storage-client import or Vite Redis token turns it RED, as does removing the combined web/server image entry.
