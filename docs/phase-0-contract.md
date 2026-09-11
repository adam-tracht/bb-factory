# Phase 0 contract and bootstrap

*Frozen record, dated 2026-09-10. Status lines, phase-open claims, "no
`plans/factory/` protocol" statements, and the SHA-256 fingerprint tables
describe the tree at freeze time and no longer match current source; the
v1.2 contract terms and review provenance remain authoritative.*

Status: Phase 0 bootstrap complete and frozen at contract `v1.2`. Phase 1 storage and read-only UI components are reviewed complete; overall Phase 1 remains open awaiting the protocol parser, BB interaction reader, read integration, and product acceptance. Phases 2 through 5 remain open.

## Frozen handoff

Frozen contract version: `v1`, encoded by the idempotency-key shape `bbf:v1:<repository>:<operation>:<UUID>`.

Implementation thread `thr_za7y2tw5vq` passed separate Sol Medium compliance review `thr_xrnpijf4nt` and code-quality review `thr_84bhqsym63`. Full validation on the final schema version passed typecheck, 10 tests, lint, SDK freshness, build, and diff checks. Interface-only health separation was rechecked with typecheck, lint, build, and diff.

The approved v1.1 interaction amendment passed compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`. The amended schemas are now frozen for Phase 1 consumers.

Prior frozen v1.1 source fingerprints, SHA-256, verified 2026-09-10:

| Path | SHA-256 |
| --- | --- |
| `src/contracts.ts` | `c27125525d60e2cfd071de6cf98f8fa11dc4271992458e7ffab05b617d9a1dd2` |
| `src/settings.ts` | `e1cd6f9a57129836c31c588f6b5ff423da4c6e71c8db8730b589ba84126c7af6` |
| `src/rpc.ts` | `f05fb373f81ddafc9b7ce014a54ba41b23e889f6c390a8c3d9f0ab09a9124e25` |
| `src/ports.ts` | `690676ae621e8428a0d5cba608dc91399bcce1fc3e058d67436a33493d2e6923` |

For provenance, the pre-amendment v1 `src/contracts.ts` fingerprint was `e8be6828f31797c7bf85fa9e39d9875e21b1e7540561acda8f593ab56e7b3e80`.

The approved v1.2 settings registry amendment passed compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`. It is now frozen for P1 integration. The v1.1 interaction provenance and fingerprints remain recorded above.

Frozen v1.2 source fingerprints, SHA-256, verified 2026-09-10:

| Path | SHA-256 |
| --- | --- |
| `src/contracts.ts` | `1c9a013f2addfb2323151b3b25ce697d8c6acf11628f9f26fd6ec7e6ab2d2114` |
| `src/settings.ts` | `1953623c8df0d04b597291661e70b3b7c330b8503dc4765e8d253099f5a016bb` |
| `src/rpc.ts` | `f05fb373f81ddafc9b7ce014a54ba41b23e889f6c390a8c3d9f0ab09a9124e25` |
| `src/ports.ts` | `690676ae621e8428a0d5cba608dc91399bcce1fc3e058d67436a33493d2e6923` |

No queue, lock, current report, question, run record, or protocol approval record was created in this source repository. Phase 1 storage passed compliance review `thr_xb9qqm6u9f` and code-quality review `thr_q2mvicbwdb`; Phase 1 read-only UI passed compliance review `thr_939nn9nneh` and code-quality review `thr_t7zf4u47hr`. The protocol parser, BB interaction reader, read integration, and product acceptance remain open before Phase 1 composition is accepted.

The hosting gate remains pending as recorded in [docs/hosting-decision.md](hosting-decision.md): no always-on non-personal host is verified, dispatch remains disabled, and no host is selected or provisioned. Data-platform work requiring Mac-local Aside/browser or dbt Studio remains gated.

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

## Interaction contract, v1.1

Approved and frozen contract delta: `v1.1`. Compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian` passed. The prior v1 boundary and provenance remain recorded above.

The installed public SDK declarations for `@get-bb/plugin-sdk@0.4.47` define these interaction shapes:

- User-question payloads contain `id`, `prompt`, optional `shortLabel`, `allowFreeText`, `multiSelect`, and optional options containing `label`, `value`, and optional `description`.
- Native user answers use `kind: "user_answer"` and an `answers` record keyed by question ID. Each answer has `selected: string[]` and optional `freeText`.
- Native approval decisions are exactly `allow_once`, `allow_for_session`, and `deny`.
- Provider-custom payloads use a namespaced kind such as `vendor/request`, a title, and arbitrary data. The factory DTO normalizes these to `kind: "plugin"` with the display title and omits the data.

The frozen v1.1 DTO delta adds required correlated discriminated branches for `PendingInteraction.kind` and `PendingInteraction.metadata.kind` while retaining the display fields and stable `interactionId`, `threadId`, and `turnId`. The schema accepts only `approval` with `approval`, `user-question` with `user_question`, or `plugin` with `plugin`:

- `approval`: `availableDecisions` with only the three SDK decision tokens.
- `user_question`: every SDK question and option field listed above, including IDs and option values. Labels remain display text; answer submissions use values.
- `plugin`: no provider-custom payload data, grants, or secrets.

The BB interaction answer action changes from arbitrary `value` JSON to typed `resolution` metadata. It supports the bounded native forms `user_answer` and `approval`, preserving multiple question IDs, multiple selected values, optional free text, and exact approval decisions. The action continues to carry `interactionId` and resolves the identified interaction in Phase 2; opening the native thread remains a navigation affordance, not the answer implementation. Opaque provider-custom `request_answer` values are not exposed by this contract. If a later provider needs an answer for that surface, it requires a separately reviewed bounded schema rather than an arbitrary JSON escape hatch.

Required downstream adaptation for v1.1:

- The P1 reader copies the SDK question and approval metadata, normalizes namespaced provider kinds to `plugin`, preserves IDs and values, and omits raw `data`, grants, and secrets.
- The UI renders labels and descriptions but submits question IDs and option values. It enables free-text and multi-select controls from the metadata and offers only the advertised approval decisions.
- The P2 action adapter validates each answer against the pending metadata, including question ID, option value, `allowFreeText`, and `multiSelect`, then maps the typed resolution to the SDK interaction resolver. It does not fall back to an opaque value or to opening the thread.

No change was made to `src/ports.ts` or `src/rpc.ts`; their existing typed projections and action request flow consume the frozen schemas. The v1.1 amendment is limited to `src/contracts.ts`, `tests/contracts.test.ts`, and these contract documents. Phase 1 consumers may now adapt against this frozen boundary.

## Settings registry amendment, v1.2, approved and frozen

The v1.2 settings amendment is approved and frozen for P1 integration after compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`. It preserves the frozen v1.1 interaction, action, guard, and RPC contracts. The v1.2 fingerprints above are now current.

The installed `@get-bb/plugin-sdk@0.4.47` settings descriptors store only strings, numbers, booleans, and select values. The registry therefore uses one multiline string setting, `repositoryRegistry`, whose synchronous Standard Schema validator parses bounded JSON and rejects unknown fields. It is not a raw JSON escape hatch, secret, path discovery mechanism, or live configuration write.

The approved interfaces are:

- `RepositoryRegistryEntry` contains one existing `RepositoryConfiguration`, plus required `projectId` and `environmentId`. Host, repository root, checkout path, branch, and main ref remain inside the existing configuration and are validated unchanged.
- `RepositoryRegistry` contains `repositories` and `defaultRepositoryKey`. Keys are lowercase, stable, unique, and must identify an entry. An empty registry must use `defaultRepositoryKey: null`.
- `FactorySettings.repositoryKey` remains the current UI selection override. When a registry is configured, it must identify one registry entry; resolution chooses this override, otherwise `defaultRepositoryKey`.
- `RepositoryRegistryResolution` is the typed settings-derived seam. It returns `configured` with all entries and the selected key, or `disabled` with an empty list and one of `not-configured`, `legacy-incomplete`, or `explicitly-empty`.

Compatibility is explicit. The registry descriptor has no stored default, so an absent `repositoryRegistry` value leaves legacy settings eligible for migration. A complete prior single-repository setting, now supplemented with required `projectId` and `environmentId`, migrates deterministically to one registry entry with `factory` and `origin/main`. A prior setting missing any repository, host, project, or environment value remains preserved but resolves to `disabled` with `legacy-incomplete`; no identifier or path is invented. An explicitly supplied empty registry takes precedence over legacy fields and resolves to `disabled` with `explicitly-empty`. No registry and no legacy fields resolve to `disabled` with `not-configured`. The default remains paused and provider preference remains unset.

P1 integration should parse the typed settings, call `resolveRepositoryRegistry`, pass each entry's `configuration` to the protocol repository registry/sibling resolver, and use its project/environment pair for BB thread and interaction scope. It must not fall back to legacy discovery when the configured registry is present. The UI can continue sending its existing `repositoryKey` selection. This amendment does not enable dispatch or change provider pins.

Focused evidence for the amendment: 18 contract tests passed, including two repositories, duplicate keys, invalid defaults and selection overrides, strict registry fields, effective descriptor defaults merged with legacy settings, explicit-empty disable precedence, complete and incomplete legacy migration, and paused disabled defaults. Typecheck and lint passed. Full-suite reader validation remains outside this amendment because the reader owner is adapting separately.

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
