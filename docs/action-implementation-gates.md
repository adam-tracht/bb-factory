# P2 action implementation gates

**Status:** Implemented. The guarded executors below are wired and covered by
focused tests (`tests/actions.test.ts`, `tests/dispatch.test.ts`,
`tests/action-router.test.ts`). This document still does not approve a
rollout, waive the human-only `ready` requirement, or claim an authenticated
actor identity. Verified against the installed `@get-bb/plugin-sdk@0.4.47`.

## Current behavior

- `factory_action` is routed by `src/rpc/action-router.ts`: revision-free
  actions go to the read-only executor, repository actions to the repository
  executor, `scaffold-protocol` to the scaffold executor, `provision-checkout`
  to the provision executor, and BB interaction plus run-control actions to
  the interaction executor. A `provision-checkout` request with an explicit
  `hostId` + `repositoryRoot` target is allowed before the repository is
  registered; every other action still requires a configured entry.
  Successful non-preview results publish a repository-changed invalidation.
- The repository executor (`src/actions/repository.ts`) performs the guarded
  sequence below: fresh snapshot, expected-revision check, single-file
  section-preserving Markdown update (`src/actions/markdown.ts`), durable
  intent claim, `expectedSha256` CAS write, post-verify read, and recorded
  result replay. The initial `ready` transition is the one-shot intent path
  (`claimInitialReadyIntent`, 10-minute expiry, native UI entry point only).
- The BB interaction executor (`src/actions/interactions.ts`) implements the
  durable answer state machine below, plus run-now, pause, resume, retry, and
  stop routing through the dispatch engine. It also owns `recommend-question`,
  an advisory action that re-reads the question from the canonical protocol
  snapshot and spawns a permission-`auto` BB chat thread in the repository's
  project and environment with the caller-picked provider and model marked
  explicit; the outcome carries the spawned thread id so the UI can open it.
  It writes nothing to the repository.
- The `pending_action_intents` table stores typed request, target, expected
  revision, single-file change, entry point, one-shot, lifecycle status,
  result, and reconciliation metadata, and all mutating executors consume it. Its
  `action_kind` constraint was widened for `recommend-question`, later for
  `scaffold-protocol`, and again for `provision-checkout` by append-only table
  rebuild migrations.
- The provision executor (`src/actions/provision.ts`) provisions the
  dedicated factory worktree (`<repositoryRoot>-factory` on `factory`) through
  host terminals, creating the `factory` branch from the repo's remote default
  (`origin/HEAD`) when missing and falling back to plain `-b factory` on the
  current HEAD. A `factory` branch already checked out in another worktree
  returns the structured `branch-in-use` outcome with the blocking path so
  the add flow can offer the direct-checkout fallback. Direct mode only
  verifies the root and reports its branch; it never creates or switches
  branches. Guard outcomes and direct mode run before the intent claim; only
  the `worktree add` is claimed and reconciled.
- Host command execution is shared by `src/actions/host-command.ts`
  (`runHostCommand`): command-mode terminal create, `terminals.get` polling,
  base64 output decode, and force-close. A create failure throws
  `HostCommandStartError` (nothing ran); a disconnect or timeout throws
  `HostCommandLostError` (the result is ambiguous and reconciled for
  mutations); a non-zero exit is a normal result the caller interprets.
- The scaffold executor (`src/actions/scaffold.ts`) writes only missing
  protocol files from the bundled `templates/` manifest with create-only
  `expectedSha256: null` CAS (a conflict is a skip, never an overwrite),
  refuses when the checkout is not on `factory`, and runs one
  `git add plans && git commit` on the connected host when any file was
  written. The bundled `foreman.md` digest is recorded in
  `templates/MANIFEST.json`, so a baseline template change is a deliberate
  manifest update rather than drift.
- The dispatch engine (`src/dispatch/`) owns preflight, ownership leases,
  durable run intents, worker start, lifecycle reconciliation, runtime caps,
  cancellation, bounded retry, and startup recovery. The scheduler
  (`src/schedule/`) applies night-window, spacing, provider-alternation, and
  night-stop policy in the shell dispatcher's order.

## Verified SDK constraints

- `bb.sdk.threads.interactions.get`, `list`, and `resolve` are available. The
  resolve call requires both `threadId` and `interactionId`, plus a
  `PendingInteractionResolution`
  (`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:369-405,
  16525-16567`).
- Provider approval resolutions preserve the exact decision and granted
  permissions, with status `interrupted`, `pending`, `resolved`, or
  `resolving` (`...bb-plugin-sdk.d.ts:520-555`). Provider user-question
  resolutions preserve `kind: "user_answer"` and the exact answers record
  (`...bb-plugin-sdk.d.ts:585-600`).
- Plugin-owned persisted interactions expose only
  `{ kind: "plugin_submitted" }`; their submitted JSON is the result of the
  waiting `bb.ui.requestInput` promise, not a value in the persisted public
  interaction shape (`...bb-plugin-sdk.d.ts:635-662`, `17341-17356`,
  `18048-18052`). The frozen factory contract therefore supports only the
  typed provider approval and user-question forms, not arbitrary provider
  `request_answer` JSON (`src/contracts.ts:576-649`).
- `bb.sdk.files.write` accepts one target path and optional
  `expectedSha256` (`...bb-plugin-sdk.d.ts:15476-15485`). Its declared result
  is either `written` with the new SHA-256 or `conflict` with the current
  SHA-256 (`...bb-plugin-sdk.d.ts:7067-7086`). No multi-file transaction or
  atomic Git-plus-protocol revision operation is declared.
- Plugin RPC handler types receive validated input only
  (`...bb-plugin-sdk.d.ts:13208-13216`). The RPC registration docs describe
  local auth semantics (`...bb-plugin-sdk.d.ts:17285-17295`), but the current
  public handler contract exposes no actor identity or human attestation.
  Provenance must therefore record the supported native-UI entry point without
  claiming an identity. This SDK limitation is not a plan requirement for
  hostile-writer protection.

## Implementable P2 guard design

### Repository actions

Apply this sequence to each repository-backed action:

1. Validate the source-discriminated action, idempotency-key binding, expected
   `RepositoryRevision`, target identity, repository authorization provenance,
   dependencies, blocking questions, and the repository's `repo.md` policy.
   Derive the target path from the parsed protocol record; do not accept an
   arbitrary client path.
2. Read a fresh full snapshot and reject if `expectedRevision` does not match.
   An action must write exactly one authoritative file. Reject or return
   `unsupported` for an action that needs a multi-file atomic change.
3. Persist the complete durable write intent before the external write. The
   intent must bind the idempotency key, repository, action, target, expected
   full revision, expected target-file SHA-256, and the validated write
   payload. The existing write table is not sufficient to reconstruct this
   intent from its fingerprint alone.
4. Call `bb.sdk.files.write` with the confined target and its expected
   target-file SHA-256. Treat `conflict` as a stale-write result with no
   overwrite. Do not retry with a newly read SHA for the same intent.
5. Read the target again and verify the returned content and SHA-256. Reload
   the full snapshot and return the resulting revision. If the target contains
   the intended change, the write was not an overwrite of a changed target.
   Surface any non-target or Git revision change for reconciliation when it
   affects the action's policy, but do not claim a global atomic write.

### Per-file CAS is not full-revision atomicity

The full revision check rejects a stale starting view. The file CAS protects
the final target from being overwritten after that check. A non-target file or
Git commit can still change between full preflight and target write, and the
SDK can accept the target write if that target's SHA is unchanged. Post-write
verification records the actual target and revision and can route a
policy-relevant non-target race to reconciliation. Full-revision preflight,
target SHA CAS, and postverify satisfy the plan's “changed file is never
overwritten” check. They do not claim multi-file or global atomicity, and the
plan does not require hostile local-writer protection.

### BB interaction answers

Use the stable interaction and thread IDs from the pending-interaction read,
not a caller-supplied thread relationship. Validate the typed resolution
against the pending metadata, then use this state machine:

1. In one SQLite transaction, claim the idempotency key and persist the exact
   resolution intent.
2. Fetch the interaction. If it is `resolved` and its persisted resolution
   deeply equals the intent, complete locally as `accepted` or
   `already-applied`.
3. If it is `pending`, call `threads.interactions.resolve`, then fetch or
   inspect the returned interaction and verify the resolution.
4. If the call fails ambiguously, fetch again. A `resolving` row or interaction
   must be reconciled before another resolve call. A different resolved value
   or `interrupted` state becomes `reconciliation-required`; never submit a
   different second answer.
5. Complete the durable row in a second SQLite transaction and replay the
   stored result for a repeated identical idempotency key. A different request
   under that key remains `idempotency-conflict`.

SQLite and BB are separate services. The SQLite transaction ends before the BB
call, and the completion transaction starts after it. This is durable intent
plus matching resolved-state reconciliation, not a cross-service atomic
transaction. It provides one-shot request binding and result replay when the
resolved state can be verified; it does not claim a distributed atomic commit.

## Required storage amendment

For durable BB answer intents, append a migration to
`question_answer_submissions`, or create a reviewed replacement intent table,
with these exact fields from the audit:

- `request_json TEXT NOT NULL`: canonical validated BB resolution only, never
  question text or a copied interaction payload.
- `status TEXT NOT NULL CHECK (status IN ('pending','resolving','completed','reconciliation-required'))`.
- Nullable operational fields: `last_attempt_at TEXT`, `completed_at TEXT`,
  `result_json TEXT`, and `last_error TEXT`.
- Preserve the existing primary key on `idempotency_key`, request-fingerprint
  equality check, repository/source/target binding, and result replay.

The claim transaction persists the complete intent. BB resolution occurs
outside SQLite. Completion occurs in a second transaction. Any pending or
resolving row is reconciled through `interactions.get` before another resolve
call. The reviewed replacement table is implemented: `pending_action_intents`
persists the complete intent, enforces atomic pending-to-resolving
consumption and one-shot expiry, and records observed BB state for
reconciliation. Both guarded executors consume it.

## Normative plan basis

- `PLAN.md:33`: “For each selected queue item: human authorization for its
  initial transition to `ready`, satisfied dependencies, and no open blocking
  question on that item before work can start.”
- `PLAN.md:116`: “unauthorized or ambiguous `ready` transitions are rejected;
  agents cannot perform the first transition to `ready`.”
- `PLAN.md:197`: “each item needs human-only initial authorization” and
  “authorization provenance is visible.”
- `CLAUDE.md:15`: “Select only human-authorized queue entries with
  `status: ready`.”
- `CLAUDE.md:49`: “Never bypass a human `approved:` queue authorization for
  protected operations.”

## Human-only initial `ready` policy

PLAN.md and CLAUDE.md require human authorization for the initial transition to
`ready`, and prohibit agents from making that first transition. Implement that
requirement as a supported-entry-point policy:

- Only a deliberate native UI action may create and consume the initial-ready
  approval request. Scheduler, worker, retry, background-reconciliation, and
  agent-tool paths must not initiate or consume it.
- Persist one durable, one-shot request bound to repository, queue item,
  expected repository revision, exact intended change, and request/expiry time.
  Record provenance as native-UI approval request completion. Do not claim an
  authenticated actor identity or human attestation.
- `approvedText`, when required, must match the freshly read authoritative
  queue record and is recorded as repository authorization provenance. Its
  caller-supplied value is not proof of humanity. Do not accept it as a
  self-attestation.
- Reject missing, reused, stale, mismatched, or ambiguous requests. Do not
  retry an ambiguous initial-ready side effect under the same request.

This is a supported-entry-point policy boundary, not a cryptographic actor
proof or hostile-writer defense. Trusted local agents already have repository
write access, so the plan does not require the plugin to secure against hostile
local writers. The human-only requirement remains in force, and this document
neither waives nor approves it.

## Acceptance gates

The implementation gates are now met by the current code and focused tests:

- Native UI is the only supported initial-ready entry point. The queue
  approval path (the Work view approve control in `src/ui/views/work.ts`,
  dispatched through `ViewContext.onAction`) uses `claimInitialReadyIntent`, a durable one-shot intent
  bound to repository, queue item, expected revision, and exact intended
  change with a 10-minute expiry. Reused, expired, mismatched, and ambiguous
  intents are rejected; `tests/actions.test.ts` covers matching and
  mismatched authorization on explicit entries, and the UI test covers the
  guarded submit path.
- Focused tests cover the intent lifecycle: ambiguous write failure marks the
  intent `reconciliation-required` and blocks retry; CAS conflicts between
  read and write return a conflict without overwrite; identical retries
  replay the recorded result; different payloads under the same key return
  `idempotency-conflict`.
- Per-action mapping to one authoritative file is tested with unrelated
  Markdown preservation, target postverification, and the stale-revision
  pre-check. Full-revision preflight plus target SHA CAS demonstrates a
  changed target is never overwritten; global atomicity is not claimed.
- BB interaction tests cover pending resolution, already-resolved replay and
  mismatch reconciliation, `interrupted` and `resolving` states, option
  validation against interaction metadata, and run-control routing.
- Rollout remains gated separately: dispatch stays `paused` until an approved
  always-on host exists, per `docs/hosting-decision.md` and the Phase 4
  cutover order in `PLAN.md`.

## Source pointers

- Plan boundary and P2 acceptance checks: `PLAN.md:108-116`.
- Human-only initial-ready and authorization rules: `PLAN.md:33,116,197` and
  `CLAUDE.md:15,49`.
- Frozen action, revision, error, provenance, and RPC seams: contract `v1.2`
  (freeze note in `CLAUDE.md`; the Phase 0 contract record was removed
  post-ship and lives in git history) and `src/contracts.ts:398-429,
  492-740`.
- Current storage implementation: `src/storage/index.ts:49-122,
  150-213, 656-755`.
- Audit supplied for this bounded task:
  `/Users/adamtracht/.bb/thread-storage/thr_5hvd5qe69d/p2-guard-audit.md:3-56`.

## Audit correction

The SDK facts in the supplied audit remain verified. Its requirement for a
core-issued non-forgeable authenticated-human receipt and anti-minting server
enforcement is stronger than PLAN.md and is not a P2 acceptance gate. Its
hostile global-CAS framing is also stronger than the plan. The implementable
boundary is native-UI entry-point policy for initial `ready`, accurate
non-identity provenance, durable one-shot request binding, and full-revision
preflight plus target SHA CAS plus postverify for changed-file protection.
