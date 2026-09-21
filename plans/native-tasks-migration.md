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
- Worker execution stays on `sdk.threads.spawn` into the provisioned checkout, with the worker self-attaching to its task card via `bb tasks attach`. Phase 0 proved `delegate` cannot target a fixed checkout (it always provisions a managed worktree); self-attach delivers the same task↔thread linkage and live_status tracking without surrendering environment control.
- Factory remains the sole authority for approvals, dependency edges, dispatch intents, attempt generations, leases, and settlement. `delegate()` has no idempotency or compare-and-swap, so every delegation goes through a durable outbox.
- Settlement never trusts task status alone: terminal thread state plus expected git change plus current generation. Task status is a signal, never proof.
- `runs/*.md` stays as committed audit artifacts, never parsed for correctness.
- Per-repo fault containment is a hard invariant: one stuck or malformed run quarantines its repository only and cannot starve global dispatch.
- Tasks' local database is not an audit store; git remains the portable record.

## Phase 0: Feasibility spike (priority/impact/effort: high/high/S)

- ✅ **Exercise the Tasks contract end to end** — done 2026-09-21 in thr_e8xpts5gkx on scratch project proj_c4x98kskky (tracker SPIKE/SPISO). Verified: project CRUD/linking, task CRUD, labels, comments, presets, dispatch, thread attach, `task_threads.live_status` (working→idle tracked, including on a self-attached thread thr_7gm29ww6c5). Findings that shape the design:
  - `delegate`/preset environment kinds do NOT cover the provisioned-checkout flow: `project-default` provisions a managed worktree even when the linked bb project has an unmanaged env for the checkout path. **Fallback taken per kill criteria: factory keeps `sdk.threads.spawn` for execution; the worker self-attaches via `bb tasks attach <key>`.** Self-attached threads get identical live_status tracking.
  - Comment authorship is forgeable from any threadless context: plugin-RPC `createComment` hard-codes `kind="user"`, `threadId=null`, `authorName="You"`; the CLI rejects caller-supplied kind. Consequences: (a) approvals are never inferred from task comments, they are factory-ledger records only (already the design); (b) factory-posted comments display as "You", so projections use labels/status and comments are rare and prefixed.
  - No double-dispatch guard (two task_threads rows attach freely) — moot under self-attach; our own outbox fences spawn.
  - `updateTask --status done` has no git-settlement guard — confirms status is a signal, never proof.
  - Error shapes recorded: `command_failed` (unlinked project), `preset_not_found`, HTTP 404 unknown method, HTTP 400 input validation. These feed the availability-degradation classifier.
- ✅ **Record the contract we depend on** — exercised via `bb plugin rpc call tasks <method> --input-file`: `createTask`, `getTaskByKey`, `updateTask`, `listTasks`, `createComment`, `listComments`, `listTaskThreads`, `createLabel`, `updateLabel`, `listLabels`, `createProject`, `listProjects`, `listBbProjects`, `listPresets`. Object inputs require a JSON body; null-input methods accept none. Drift strategy: passthrough-tolerant zod schemas plus a classified error surface (`tasks_unavailable` / `tasks_contract_incompatible` / `tasks_rpc_failed`), the Work plugin pattern in `bb-plugin-work/integrations/tasks.ts`.

## Phase 1: Adapter and safety ledger (high/high/M)

- ✅ **Tasks adapter behind a setting** — narrow port in the contract layer; the current direct-spawn path stays default; the tasks implementation uses validated cross-plugin RPC. Lands in: src/contracts.ts, new src/tasks adapter.
  Implementation note: Added the disabled-by-default `tasksIntegration` setting and tolerant, injected `TasksClient` in `src/tasks/index.ts`; frozen v1.2 factory contracts remain unchanged.
- ✅ **Immutable approval records**: approvals keyed to task id plus operation class plus content revision; a material task edit invalidates the grant. Card moves and plain human comments do not initiate grants; Factory records them. Replaces `approved:` syntax. Lands in: src/storage, src/actions.
  Implementation note: Added repository-scoped approval records with SQL append-only triggers plus guarded `approve-task` wiring; the adapter hashes title, description, dueDate, label ids, and parentTaskId, while status and comments remain outside the fence.
- ✅ **Dependency and blocker edges** — explicit task-id edges in factory storage; Tasks labels and parent/child are display only. Lands in: src/storage.
  Implementation note: Added repository-scoped dependency edges with recursive cycle rejection and typed blocker records with answer/resolution timestamps in `src/storage/index.ts`.
- ✅ **Availability degradation** — tasks disabled, unavailable, or contract-incompatible produces a visible health state and pauses dispatch rather than failing silently. Lands in: src/lifecycle, health surfaces.
  Implementation note: Added Tasks probing to live health, settings attention, and the dispatch start gate; enabled-mode failures pause dispatch while disabled mode makes no Tasks calls.

## Phase 2: Execution substrate (high/high/M)

- ⬜ **Attach through the outbox** — durable dispatch intent, existing fenced `threads.spawn` into the provisioned checkout, then the worker self-attaches via `bb tasks attach <key>`; attachment plus `task_threads.live_status` are recorded on the attempt. Ambiguous spawns keep the current quarantine path. Lands in: src/dispatch/start.ts, worker prompt/templates.
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
