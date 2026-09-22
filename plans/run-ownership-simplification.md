# Run ownership simplification

Simplifies how dispatch decides a repository is occupied. Part of BBF-0049.

## Incident that motivates this

`run-dd57c52f` (monorepo, manual trigger, 2026-09-22) spawned ambiguously. The
generation went stale, the late worker thread was detected and stopped, and the
run finalized `no-op` with `never-dispatched`. Its ownership lease was left in
`reconciliation-required` with `workerThreadId: null`.

No release path covered that state:

- `reconcileQuarantinedLease` returns early when the lease has no worker id.
- `releaseQuarantinedOwnership` requires a failed-safe run, paused repository,
  and an elapsed abandonment deadline.
- `stopRun` reports "already settled" and does nothing.

Result: the lease held forever, `acquireOwnership` rejected every new run, and
monorepo dispatch was fully blocked (manual and scheduled) until the row was
repaired by hand. This is the same failure class as the incident that motivated
the migration: one stuck record starving a repository.

## Principle

Every non-released ownership state has a self-driving exit: a grace window, a
poll of the worker, a local settlement write, or a hard deadline. No state may
wait on an operator, and no lease may outlive the possibility that a worker
exists.

## The gate

A repository counts as occupied (blocks dispatch, counts toward concurrency)
while either is true:

1. A dispatch intent is inside its spawn grace window with no worker recorded
   yet. The claim is required or two ticks in the same minute double-spawn; it
   is bounded by `PENDING_RUN_GRACE_MS`.
2. The recorded worker thread is observed non-terminal.

Anything else frees the slot. A dead worker never holds ownership; its lease
lives only long enough for settlement to run.

A terminal-worker observation is durable settlement metadata and frees capacity
immediately while settlement continues.

## States and their single exits

- `held`, no worker yet (spawn in flight). Exits: spawn resolves with a thread
  id, or the grace window expires and the run settles as a failed start.
- `held`, worker recorded. Exits: worker observed terminal (moves to settling),
  or lease expiry.
- `settling`: worker terminal, settlement pending. Exit: the settlement write
  completes. Settlement is local and fast; a failure retries on the next
  reconcile pass, it cannot wedge.
- `quarantined`: a worker may exist whose identity is unknown (ambiguous
  spawn), or a recorded worker's state cannot be verified. Exits: the worker is
  observed stopped or terminal (then settling, then released), or the
  abandonment deadline passes (released, surfaced to the operator).
- `released`: terminal.

## Root cause of the live failures

`ownsPendingSpawnGeneration` compares `run.canonicalRecords` (stored through
`stableJson`, which deep-sorts object keys) against `generation.canonicalRecords`
(the live literal, whose `repositoryRevision.fileDigests` keeps reader insertion
order) using `sameJson`, a raw `JSON.stringify` compare. The nested key orders
always differ, so every spawn with a non-empty eligible set lands instantly
stale, and the freshly created worker thread is killed by the stale-spawn path.
Introduced in `10f04c7`; empty `eligible` hides it (`[] === []`), which is why
the test suite never saw it: every seeded queue item is ineligible. This same
compare inside `quarantineLateSpawn` also blocks the quarantine attach, which is
how the original lease ended up quarantined with no worker recorded.

## Required changes

0. `sameCanonicalRecords` must compare semantically (relativePath, recordType,
   recordId, `sameRevision`) in both modes. The `sameJson` fast path cannot
   survive a `stableJson` round trip. Audit every `sameJson` call in the
   dispatch fence paths for the same trap; arrays of scalars are safe, anything
   containing an object is not unless both sides went through identical
   normalization.
1. `reconcileQuarantinedLease` must converge for terminal runs whose lease has
   no worker id (`null`, `never-dispatched`, `spawn-ambiguous`,
   `unknown-thread`): settle, then release. The current silent early return is
   the wedge.
2. The stale-spawn handler already stops the late thread; it must also record
   that thread id on the lease so ordinary re-observation releases it.
3. `releaseQuarantinedOwnership` and the stop action accept terminal runs
   generally when no worker can exist, not only `failed-safe`.
4. Concurrency and the dispatch gate derive from the gate above rather than
   from lease status alone.

## What does not change

- Settlement classification is untouched: terminal thread, expected git
  revision change, generation match, and protocol record are still required
  before an outcome is recorded. This change is about liveness, not verdicts.
- Durable intents, attempts, and leases remain as the audit trail; only the
  gating derivation and the convergence guarantees change.
- Wire contract, idempotency keys, and the UI are frozen.
- Applies to both modes; the ownership machinery is shared, not flag-gated.

## Tests (minimum)

- Dispatch with a non-empty eligible set: spawn resolves, generation matches,
  run reaches `started`. This is the regression the whole suite missed; it must
  exist.
- Reproduce the incident: terminal `no-op` run, quarantined lease, null worker
  → reconcile releases the lease.
- Spawn in flight inside the grace window still blocks a second dispatch.
- A live worker still blocks.
- Ambiguous-spawn quarantine releases through the abandonment deadline.
