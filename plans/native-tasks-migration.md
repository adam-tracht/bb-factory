# Core rebuild on native Tasks

**Goal:** Rebuild the dispatch core on BB's native Tasks plugin so the work queue, worker delegation, and run discussion live in validated structured records instead of markdown the plugin must parse for correctness. Factory keeps a narrow fenced safety ledger (approvals, dependencies, intents, leases, settlement); each repo keeps worker instructions and git audit artifacts.
**Source:** Lifecycle incident postmortem + five-persona council deliberation, 2026-09-21 (thread thr_wswppd4ja4)
**Status:** In progress

## Status key

- ✅ Done
- 🔲 Partial
- ⬜ Not started

## Decisions (council outcome, 2026-09-21)

- Tasks is the authoritative work record (queue card, discussion, worker attachment), not a mirror. Mirror-only was rejected: it keeps dual truth plus sync drift while preserving the markdown failure class.
- Factory remains the sole authority for approvals, dependency edges, dispatch intents, attempt generations, leases, and settlement. `delegate()` has no idempotency or compare-and-swap, so every delegation goes through a durable outbox.
- Settlement never trusts task status alone: terminal thread state plus expected git change plus current generation. Task status is a signal, never proof.
- `runs/*.md` stays as committed audit artifacts, never parsed for correctness.
- Per-repo fault containment is a hard invariant: one stuck or malformed run quarantines its repository only and cannot starve global dispatch.
- Tasks' local database is not an audit store; git remains the portable record.

## Phase 0: Feasibility spike (priority/impact/effort: high/high/S)

- ⬜ **Exercise the Tasks contract end to end** — enable the builtin tasks plugin, then drive createTask, delegate, listTaskThreads, and comments on a scratch repo. Confirm preset environment kinds (`project-default`, `new-worktree`) cover the provisioned-checkout flow; observe double-delegate and ambiguous-failure behavior; confirm comment authorship (user vs agent) cannot be forged by a worker. Confidence: high this is the right gate before any build. Effort: S. Kill criteria: unusable environment targeting or forgeable authorship falls back to factory spawn plus worker self-attach via `bb tasks attach`.
- ⬜ **Record the contract we depend on** — pin the exact RPC surface and the drift strategy (passthrough schemas plus compatibility error surface, the Work plugin pattern).

## Phase 1: Adapter and safety ledger (high/high/M)

- ⬜ **Tasks adapter behind a setting** — narrow port in the contract layer; the current direct-spawn path stays default; the tasks implementation uses validated cross-plugin RPC. Lands in: src/contracts.ts, new src/tasks adapter.
- ⬜ **Immutable approval records** — approvals keyed to task id plus operation class plus content revision; a material task edit invalidates the grant. A card move or plain human comment initiates; factory records the grant. Replaces `approved:` syntax. Lands in: src/storage, src/actions.
- ⬜ **Dependency and blocker edges** — explicit task-id edges in factory storage; Tasks labels and parent/child are display only. Lands in: src/storage.
- ⬜ **Availability degradation** — tasks disabled, unavailable, or contract-incompatible produces a visible health state and pauses dispatch rather than failing silently. Lands in: src/lifecycle, health surfaces.

## Phase 2: Execution substrate (high/high/M)

- ⬜ **Delegate through the outbox** — durable dispatch intent, then the delegate call, then immediate thread-id capture; ambiguous outcomes quarantine for reconciliation instead of retrying blind. Lands in: src/dispatch/start.ts.
- ⬜ **Settlement on structured signals** — terminal thread state plus expected repository revision change plus current generation; `task_threads.live_status` is the liveness oracle. Lands in: src/dispatch/lifecycle.ts.
- ⬜ **Simplified worker protocol** — foreman instructions report progress and outcomes via `bb tasks comment` / `bb tasks update`; the run record file is still written as the audit artifact but nothing parses it. Lands in: templates/foreman.md, plans/factory/foreman.md.
- ⬜ **Per-repo fault containment** — a stuck run quarantines only its repository's dispatch; add a regression test for the verified global-capacity starvation path. Lands in: src/dispatch, src/schedule.

## Phase 3: Queue migration (med/high/M)

- ⬜ **Queue items become task cards** — one Tasks project per managed repository, linked to its bb project; existing queue and done entries are imported. queue.md leaves the protocol. Lands in: src/protocol (removal path), a one-shot import action.
- ⬜ **Blocking questions and current state** — questions become labeled cards plus comments backed by factory blocker records; current.md and the repo lock file leave the correctness path entirely.
- ⬜ **UI deferral** — work, questions, and runs surfaces defer to the Tasks board; the factory UI keeps health, settings, and dispatch controls.

## Go-live / cutover (sequence last)

- ⬜ **Dependency declaration** — install and startup check for tasks and offer to enable it, never silently, matching the Command Center pattern.
- ⬜ **Per-repo cutover** — bb-factory itself first, then managed repositories one at a time; the direct-spawn fallback survives one release, then legacy dispatch and markdown-protocol code are deleted.

## Deferred / future

- ⬜ **DEFERRED: Workflows as the durable execution layer** — the workflows plugin cannot start runs via plugin RPC today (read and stop only). Revisit if that surface opens; it could subsume recovery machinery.
- ⬜ **DEFERRED: Git-portable queue history** — periodic snapshot of each Tasks project into its repo if queue history portability becomes necessary.
- ⬜ **DEFERRED: Content-addressed run artifacts** — stronger audit binding than filename plus commit; unvalidated need.
