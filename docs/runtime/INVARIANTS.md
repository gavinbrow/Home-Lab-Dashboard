# Durable runtime invariants

The worker owns execution lifetime. HTTP submission returns a persisted ID and SSE only replays committed history. No browser connection owns a process or dispatch.

- Submission keys are scoped to the actor and canonical request digest. Conflicting reuse returns HTTP 409.
- Claim transactions use PostgreSQL row locks and commit before network I/O. Lease generations fence stale workers; a lease is not proof that a host process ended.
- Every tool step has one stable operation ID, request digest and transactional dispatch outbox record. Recovery first inspects that operation's ledger. It never creates a replacement command because an acknowledgement was lost.
- Workspace writer reservations have no automatic lease expiry. Unknown outcomes retain them. Only durable proof of termination/completion permits normal release.
- Cancelling means a request was recorded. Cancelled requires confirmed termination or proof nothing launched. Offline cancellation remains pending.
- Ordered events are committed before SSE delivery. Reconnection has no execution side effect. Expired cursors produce a current snapshot and explicit history gap.
- Restored state starts with dispatch disabled and requires a new dispatch epoch after host reconciliation.
- No local shell fallback exists in the orchestrator. Unsupported containment, policy, protocol or transport disables dispatch explicitly.

## Evidence boundary

Unit and database integration checks validate components only. Browser survival, descendant termination, Windows restricted identity, native Linux containment, launch ambiguity and persistent outputs require the actual machine/provider scenarios in the planning pack. No live credentials or enrolled machines were supplied with the initial repository.
