# Phase 0 contract and bootstrap

Status: Phase 0 bootstrap complete and frozen. Downstream phases remain open.

## Frozen handoff

Frozen contract version: `v1`, encoded by the idempotency-key shape `bbf:v1:<repository>:<operation>:<UUID>`.

Implementation thread `thr_za7y2tw5vq` passed separate Sol Medium compliance review `thr_xrnpijf4nt` and code-quality review `thr_84bhqsym63`. Full validation on the final schema version passed typecheck, 10 tests, lint, SDK freshness, build, and diff checks. Interface-only health separation was rechecked with typecheck, lint, build, and diff.

Frozen source fingerprints, SHA-256, verified 2026-09-10:

| Path | SHA-256 |
| --- | --- |
| `src/contracts.ts` | `e8be6828f31797c7bf85fa9e39d9875e21b1e7540561acda8f593ab56e7b3e80` |
| `src/settings.ts` | `e1cd6f9a57129836c31c588f6b5ff423da4c6e71c8db8730b589ba84126c7af6` |
| `src/rpc.ts` | `f05fb373f81ddafc9b7ce014a54ba41b23e889f6c390a8c3d9f0ab09a9124e25` |
| `src/ports.ts` | `690676ae621e8428a0d5cba608dc91399bcce1fc3e058d67436a33493d2e6923` |

No queue, lock, current report, question, run record, or protocol approval record was created in this source repository. Phase 1 may start from this frozen boundary, but each P1 component output must pass its own compliance and code-quality reviews before P1 composition begins.

## Scope

This phase owns the typed boundary, declarative settings, wire contracts, package scaffold, and startup/disposal skeleton. It does not implement repository parsing, storage, scheduler behavior, workers, live RPC handlers, cutover, legacy changes, or queue records.

The repository is the factory plugin source, not a factory-managed target repository. It has no `plans/factory/` protocol, queue, lock, current report, or run record. No human queue approval record is created here.

## Current SDK contract

The scaffold is pinned to the current public SDK observed on 2026-09-10:

- Package: `@get-bb/plugin-sdk@0.4.47`.
- Backend entry: `export default async function plugin(bb: BbPluginApi)`.
- Settings: `bb.settings.define(...)`, with Standard Schema validation.
- RPC contract helper: `defineRpcContract(...)`; validated contracts cover repository selection, settings/status, health, run list/detail, snapshot, and action methods. Handlers are not registered in Phase 0.
- Lifecycle: `bb.onDispose(...)`; no timer, socket, worker, scheduler, or database handle is opened.
- Build: `bb plugin build .`; SDK refresh check: `bb plugin types --check`.

The source of truth for these names is the installed SDK declaration package and the generated scaffold from `bb plugin new`, not a generic repository convention.

## Canonical foreman template rule

The authoritative foreman protocol is always the connected repository's `plans/factory/foreman.md`, read together with that repository's `plans/factory/repo.md`. The plugin exposes the content digest and repository revision in `ForemanTemplateSource`; it does not silently embed or rewrite the protocol.

The current shell template at `~/.bb/factory/templates/foreman.md` is a migration baseline only. Its observed SHA-256 on 2026-09-10 is `7e65120a82d0211da726d2f315cb24bd6c311453b1a7ac82e28410eb68404651`. A future migration may compare that baseline with a repository protocol, but may not create a second authoritative version. Any protocol change must land in the managed repository, carry a changed content digest and repository revision, and return to contract review before downstream consumers change.

## Frozen boundary

- Repository configuration identifies the stable repository key, root, connected host, checkout, `factory` branch, and `origin/main` comparison ref.
- Settings cover repository key/root, connected host, checkout path, schedule and server-local night-window end hour, 10,800-second runtime cap, provider preference or alternation, 3,600-second minimum start gap, concurrency limit, and enabled/paused dispatch. The default is paused, and provider preference remains unset until migration explicitly chooses the active Codex pin or alternate behavior.
- Protocol snapshots preserve repository-backed queue entries, item-level eligibility reasons, explicit approval provenance, questions, canonical dashboard summary, current run outcome, and revision digests. They do not become a second task system.
- `RunIntent`, `DispatchAttempt`, `OwnershipLease`, `ProviderStatus`, and `HostPreflight` describe operational metadata and do not replace repository state or BB core state.
- The action contract binds the repository and action segments of a versioned idempotency key to the enclosing request. Guarded actions require an expected revision; only the explicitly revision-free `preview` and `integration-report` actions omit it. Repeating the same key with the same request returns the prior result; reusing it for a different request is an `idempotency-conflict`.
- Stale writes return the typed `stale-revision` variant with required expected and actual revisions. Other error variants cannot carry revision evidence. The plugin never implicitly merges or overwrites unrelated Markdown.
- Queue status detail remains optional where the live protocol omits it, including bare `done`; `blocked-by` preserves both its question ID and any supplied detail. A question's optional `recommended` field remains absent when the source omits it. No placeholder text is invented.
- The configurable minimum start gap is bounded at 3,600 seconds, preserving the rolling-hour safety guard in the plan.
- Realtime messages are invalidation signals only. They carry `durableReloadRequired: true`; clients reload durable state after a signal or reconnect.

## Callable integration seams

The DTOs are paired with these minimal internal ports so downstream workers consume reviewed signatures rather than inventing adapters:

- `ProtocolReader.loadSnapshot(configuration: RepositoryConfiguration): Promise<ProtocolSnapshot>` is the read boundary for repository-backed canonical files.
- `OperationalStateReader.listRuns(input)` and `getRun(input)` return operational run list/detail projections. A dispatched run requires stable `projectId` and `environmentId`; only an explicitly pre-dispatch `pending` run may leave either nullable.
- `FactoryHealthReader.listProviderStatus(repositoryKey): Promise<ProviderStatus[]>` and `getHostPreflight(repositoryKey): Promise<HostPreflight>` provide the health projection from live BB and host state.
- `PendingInteractionReader.listPendingInteractions(repositoryKey)` returns pending BB interactions with the stable `interactionId`, thread, turn, source, and normalized prompt metadata.
- `ReadOnlyActionExecutor.execute(request: RevisionFreeActionRequest): Promise<FactoryActionResult>` owns the revision-free `preview` and `integration-report` composition seam.
- `RepositoryActionExecutor.execute(request: RepositoryActionRequest): Promise<FactoryActionResult>` owns repository-backed question and queue writes. A repository answer is source-discriminated as `repository-question` and carries `questionId`.
- `BbInteractionActionExecutor.execute(request: BbInteractionActionRequest): Promise<FactoryActionResult>` owns BB interaction and run-control actions. A BB answer is source-discriminated as `bb-interaction`, carries `interactionId`, and is resolved exactly once under the explicit idempotency key. All executors use the same validated request, result, and typed-error convention.
- Answer results use the same source discriminator as their requests. BB answers require a nonempty `interactionId` and reject `questionId`; repository answers require a nonempty `questionId` and reject `interactionId`. Non-answer results carry neither identifier.

The validated read RPC methods are `factory_repositories`, `factory_settings`, `factory_health`, `factory_interactions`, `factory_runs`, and `factory_run_detail`. `factory_snapshot` and `factory_action` remain unchanged. Run summaries carry canonical file links and stable BB project, environment, thread, provider, and repository revision identifiers. Phase 1 read composition, pending-interaction reads, and UI wiring, plus Phase 2 source-discriminated action routing, are owned explicitly in the dependency map.

## Migration inputs verified read-only

- Legacy defaults: `alternate` provider preference, `WINDOW_END_HOUR=6`, `MAX_RUN_SECONDS=10800`, and `MIN_GAP_SECONDS=3600`.
- Current `redeploy.sh` pins both existing automations to `PREFER=codex` while the comment says to restore `alternate` after the temporary Claude limit. The dispatcher maps Codex to `gpt-5.6-sol` with `high` reasoning and Claude Code to `claude-opus-5[1m]` with `high` reasoning.
- Both legacy automations are currently enabled. The rollout audit found no active factory workers or locks. Only the Mac host is connected; durable host availability is unproven and remains a later preflight gate.
- Dispatcher outcomes remain exactly `success`, `blocked`, `failed-safe`, and `no-op`; `noopCount` resets on a night-key change, not after success.
- The shell header claims exit zero for every tick, but missing `REPO_KEY` or `jq` exits one. This is recorded migration input, not silently corrected in Phase 0.
- The two current state files contain no active thread or provider and both report the last state as `no-op`; no state was changed.

## Review gates

The Phase 0 compliance and code-quality gates are complete. The frozen boundary above is the source of truth for downstream work. Any interface change returns to Phase 0 for review; no later phase is marked complete here.
