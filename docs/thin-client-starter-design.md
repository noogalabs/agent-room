# Thin-client starter — implementation contract

Status: first build increment, 2026-09-01  
Base: `648d76e6527f4aa35d24877db40eddc85d223030`

## Repository and product boundary

The starter belongs in this Agent Room monorepo as `apps/starter`. It is an
outbound-only room participant and local bootstrap launcher. It is not a
cortextOS daemon feature and it adds no server endpoint: the existing room API
already provides authenticated join, listen, send, and task traffic.

The starter may launch only this repository's pinned
`scripts/bootstrap-local.mjs`, after verifying the fetched artifact and after
the machine owner approves locally. Room text is data, never executable input.

## User flow

1. Preflight Node 20+, npm, platform, network, and a writable private state dir.
2. Read the room URL, room-access token, participant token, and room code without
   echoing secrets.
3. Join through the existing room API and post a non-secret machine preflight.
4. Poll for a typed bootstrap offer containing an immutable repository revision
   and SHA-256 digest. Reject every other execution request.
5. Display the exact revision, digest, destination, and command locally; require
   an explicit local `y/N` approval.
6. Fetch into a new private directory, verify the digest before execution, and
   run `node scripts/bootstrap-local.mjs` with inherited stdio.
7. Post only a typed, non-secret phase receipt: approved/declined, exit status,
   completed phase count, and elapsed time.

## Security invariants

- No arbitrary remote execution, shell interpolation, `eval`, or room-supplied
  command strings.
- Approval is local and defaults to deny on empty input, EOF, timeout, or error.
- Access and participant tokens are never logged, posted, placed in argv, or
  embedded in attachment URLs.
- State and credential files are mode `0600`; directories are mode `0700`.
- The client listens on no port. Bootstrap runtime remains loopback-only.
- No self-update. A version change is a newly pinned artifact through the same
  verification and approval flow.
- Receipts contain schema-approved fields only; no environment, file bodies, or
  captured stdout/stderr are sent to the room.

## Initial module seams

- `config.ts`: secret-safe input and validation.
- `room.ts`: the existing authenticated room transport behind a narrow adapter.
- `offer.ts`: producer-carried typed bootstrap offer validation.
- `artifact.ts`: immutable fetch plus SHA-256 verification.
- `approval.ts`: fail-closed local consent.
- `runner.ts`: fixed executable and argument vector only.
- `receipt.ts`: allowlisted, non-secret result schema.
- `index.ts`: ordered orchestration; no policy decisions of its own.

## Acceptance casualties

The first releasable slice is not complete until tests prove these can fail:

1. A room message carrying an arbitrary command is rejected and never spawned.
2. A digest mismatch halts before approval and execution.
3. Empty input, EOF, timeout, and `n` all deny; only explicit `y` approves.
4. Tokens are absent from argv, logs, errors, receipts, and child environment.
5. A successful bootstrap receipt includes no stdout, stderr, env, or file data.
6. Any non-loopback runtime proposal is rejected.
7. A second offer cannot replace the running client's own code.
8. Removing digest verification or changing default approval to allow makes a
   named casualty red.

## Deferred, explicitly outside slice 1

- Node installation automation.
- Anthropic/Claude account creation and product credential provisioning.
- General remote task execution.
- Self-update or background service installation.
- A new server-side protocol beyond the smallest typed bootstrap-offer fields
  proven necessary during transport integration.

