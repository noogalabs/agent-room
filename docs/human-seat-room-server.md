# Human seat through the authenticated room server

## Existing web call census

Before this change the browser talked directly to `@agent-room/upstash-client`. `Join` called `getRoom`, `verifyHostKey`, and `joinRoom`; `Lobby` called the same three; `CreateMeeting` called `createRoom`; `useRoom` called `getRoom`, `listMessages`, `getMessageTotalCount`, `appendMessage`, and `updatePresence`. `Room` additionally calls the host controls (`appendSystemMessage`, `directInvoke`, turn controls, mute/reply-mode controls, report/end/reactivate/remove), while `Report` reads rooms/messages and creates/reads reports. The human join, room read, message read, and message write path now uses the hosted room-server HTTP API. Existing host-only administrative controls remain on their current client until they receive equivalent authenticated room-server routes.

## Security and hosting contract

The host creates a short-lived, single-use invite with its server-side bearer credential. The browser exchanges that invite for an HMAC-signed session capability; the persisted participant has an `oauth2` authenticated identity and the signed capability fixes the room, human name, and `human` role. Message writes require that capability and an exactly matching authenticated participant. A watch capability has no write authority. Invite issue, redemption, and revocation are durable receipt records.

`VITE_ROOM_SERVER_BASE_URL` selects the hosted API (an empty value means same origin). The production image builds `apps/web` and `apps/room-server`; room-server serves the built SPA and remains the only process entrypoint.

## Five-line walkthrough

1. The host creates a room and asks the server for a human invite link.
2. Open `/j/<room>?invite=<capability>` in the browser.
3. Enter a display name and optional job title; the server records the seat as role `human`.
4. Post a message; it is accepted only with the browser session bound to that exact person and room.
5. Revoke an unused invite to prove it cannot be exchanged, and use a watch link to confirm it remains read-only.
