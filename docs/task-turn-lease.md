# Task turn lease

## Source contract

This ports the lease mechanics from Bothread commit `cf2d8f8a9647636d438223fbbda51233752eea9a`, specifically [`packages/shared/src/index.ts`](https://github.com/AdamACE9/bothread/blob/cf2d8f8a9647636d438223fbbda51233752eea9a/packages/shared/src/index.ts#L48-L61) for the 15-minute default and lease shape, and [`packages/server/src/engine/engine.ts`](https://github.com/AdamACE9/bothread/blob/cf2d8f8a9647636d438223fbbda51233752eea9a/packages/server/src/engine/engine.ts#L1129-L1341) for sweep-before-claim, atomic conflict-check plus grant, holder-only renew/release, TTL expiry, and routed handoff behavior. Agent Room applies those semantics to one board task rather than a file glob and makes the lease a server-enforced write guard, not an advisory prompt.

## Record and actors

An optional `lease` on a task contains `id`, `holderId`, `holderName`, `holderClient`, `status`, `grantedAt`, `expiresAt`, and optional renewal/release and pending-handoff fields. `holderId` is the authenticated Agent Card fingerprint from PR5. Only an active authenticated room participant may claim or receive a lease. Existing unleased task behavior remains unchanged; a legacy participant may use unleased tasks but cannot create an identity-bearing lease.

The default TTL is 15 minutes, matching Bothread, with a positive caller override capped at 24 hours. Time comparisons are server-side. Every mutating entry first sweeps an active lease whose `expiresAt <= now` to `expired` and records that transition before evaluating the requested action.

## Atomic state and ledger

The task board is the current-state authority and PR4's receipt ledger is the immutable history. The persistence seam gains one compare-and-swap operation that updates the task board and appends its lease events in the same Redis script or Postgres transaction. A failed compare-and-swap appends no receipt; a retry uses deterministic receipt IDs so it cannot duplicate history.

Two concurrent claims read the same board version, but only one compare-and-swap may commit. The loser reloads and receives `task_lease_held`; it never overwrites the winner. Grant, renew, release, expiry, and handoff request each append the corresponding PR4 `lease_event` (`granted`, `renewed`, `released`, `expired`, `handoff_requested`) with room, task, lease, actor, holder, sequence time, and transfer context.

## Commands and push guard

- `claim`: grants an unleased or expired task to the authenticated caller.
- `renew`: holder-only; replaces `expiresAt` with `now + ttl`, rather than extending stale time.
- `release`: holder-only; closes the lease and makes the task claimable.
- `requestHandoff`: a non-holder records one pending request addressed to the current holder. It does not steal or release the lease.
- `grantHandoff`: holder-only; atomically replaces the holder with the named authenticated requester, clears the request, resets the TTL, and records the new `granted` event with transfer context.
- `submit`: if a task has an active lease, the production task submission entry compares the caller's authenticated fingerprint to `holderId`. A mismatch fails by name as `task_lease_holder_required` before evidence or board state can change. Expiry is swept first, so an expired lease no longer authorizes its former holder.

## Proof and scope

Five production-entry casualties bind the contract: two authenticated participants race and exactly one claim commits; a non-holder submission is refused with the board unchanged; renew extends while release frees; expiry frees and emits `expired`; a handoff reaches the holder and holder grant transfers atomically. The combined receipt assertion requires every emitted event in exact ledger order, including all five event kinds. Each restored defect must turn its named casualty red, then green at the frozen head. The ordered eight-workspace build, full rollup, and real-Postgres CI leg are required.

Out of scope: file-glob overlap, git branch automation, cross-fleet `@` addressing, decision pins and signed handoff receipts (build 4), deployment, and secrets.
