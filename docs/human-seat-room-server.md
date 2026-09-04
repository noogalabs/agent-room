# Human seat through the authenticated room server

## Existing web call census

Before this change the browser talked directly to `@agent-room/upstash-client`. `Join` called `getRoom`, `verifyHostKey`, and `joinRoom`; `Lobby` called the same three; `CreateMeeting` called `createRoom`; `useRoom` called `getRoom`, `listMessages`, `getMessageTotalCount`, `appendMessage`, and `updatePresence`. `Room` additionally called the host controls (`appendSystemMessage`, `directInvoke`, turn controls, mute/reply-mode controls, report/end/reactivate/remove), while `Report` read rooms/messages and created/read reports. All browser room storage calls now go through `room-server-client`; no screen or hook imports the storage client, and no Redis credential is bundled into Vite. Durable host actions are authenticated room-server routes. The legacy turn queue has an explicit server seam that currently returns no active turn rather than letting the browser bypass persistence.

## Security and hosting contract

The host creates a short-lived, single-use invite with its signed browser session or server-side bearer credential. The browser exchanges that invite for an HMAC-signed session capability; the persisted participant has an `oauth2` authenticated identity and the signed capability fixes the room, human name, and `human` role. Message writes require that capability and an exactly matching authenticated participant. The server, never the request body, supplies message kind, role, initials, color, client, and identity metadata. Watch capabilities authorize reads only while valid and never authorize writes. Invite issue, redemption, and revocation are durable receipt records; name and historical-roster conflicts are checked before redemption, and established sessions remain bound to a non-revoked invite.

The hosted server also owns the agent transport at `POST /api/room`. A signed-card join returns an agent session capability, and subsequent reads and posts use that capability against the same durable room record. This keeps the browser and orchestrator seats on one hosted process without restoring direct storage access.

The production MCP client loads the public Agent Card from `AGENT_ROOM_AGENT_CARD` and the Ed25519 private JWK from the mode-0600 path in `AGENT_ROOM_FLEET_PRIVATE_KEY`; `AGENT_ROOM_FLEET_KEY_ID` selects the matching trust-store key. It signs create and join locally. Missing, unreadable, over-permissive, or mismatched identity material refuses before the request. A fresh join posts the signed join first and reads only after the returned participant capability is installed.

`VITE_ROOM_SERVER_BASE_URL` selects the hosted API (an empty value means same origin). The production image builds `apps/web` and `apps/room-server`; room-server serves the built SPA and remains the only process entrypoint.

## Five-line walkthrough

1. David opens New Meeting; room-server creates his signed human host seat.
2. The lobby issues and copies `/j/<room>?invite=<capability>` through room-server.
3. Enter a display name and optional job title; the server records the seat as role `human`.
4. Post a message; it is accepted only with the browser session bound to that exact person and room.
5. Revoke the invite to invalidate its established session, and use an expired watch link to confirm it remains read-only.

## Guard-removal kill record

The production-entry test `binds human invite, session, join and post identity while watch tokens stay read-only` is the mutation casualty for the HTTP boundary. Removing bearer verification makes its unauthenticated-post assertion RED; accepting a valid watch capability for POST makes `watch_session_read_only` RED; accepting an expired watch capability for GET or POST makes `watch_session_expired` RED; removing message/session matching or accepting caller-owned identity fields makes the impersonation/forged-message assertions RED; removing the durable participant check makes its persisted-identity assertion RED; and removing redeemed/revoked receipt checks makes reuse and established-session revocation RED. `refuses expired and tampered human sessions by name` turns RED when signature, expiry, required invite binding, or revocation validation is removed. `refuses a revoked human invite before participant mutation` turns RED when the pre-join revocation lookup is removed. `checks human name and historical agent roster before burning an invite` turns RED if the current-name check happens after redemption or if the durable agent roster is ignored. `browser host creates a signed seat and issues a capability-bearing lobby invite` turns RED if the hosted lobby path loses the invite capability. `requires signed cards before any participant write` exercises the hosted `/api/room` agent read/post route after a signed-card join; removing that route or its member capability check makes the test RED. The consumer census enumerates every browser screen and hook; any storage-client import or Vite Redis token turns it RED, as does removing the combined web/server image entry.

`drives room_create and fresh room_join with signed cards and no pre-join read` invokes the real MCP tool handler against the hosted HTTP server. It turns RED if hosted create is unsupported, either production payload omits its signed card or scheme, a fresh join performs `get` before `join`, the returned participant capability is not installed, or the hosted agent read/post path is absent.
