# Factory dependency and ownership map

This map is the Phase 0 handoff contract. Each task has exactly one implementation worker. Root coordinates reviews and integration. Every task receives a separate Sol Medium compliance review first, the worker fixes concrete findings, then a separate Sol Medium code-quality review. A task is not an integration dependency until both reviews pass.

The current approved implementation assignment is Luna Extra High. The current approved review assignment is Sol Medium. This is the current model assignment for downstream task work and does not authorize downstream work.

## Current checkpoint

- Phase 0 is complete and frozen at contract `v1.2`. The approved interaction amendment and settings registry amendment passed compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`.
- Phase 1 operational storage is reviewed complete: compliance `thr_xb9qqm6u9f`, code quality `thr_q2mvicbwdb`, and focused evidence of 5 storage tests passing.
- Phase 1 read-only UI is reviewed complete: compliance `thr_939nn9nneh`, code quality `thr_t7zf4u47hr`, and focused evidence of 8 UI tests passing.
- Phase 1 protocol adapter passed compliance `thr_8cqgbbbyrz` and quality `thr_ubqkmmuven`; the BB interaction reader passed compliance `thr_c8zj6b48mk` and quality `thr_xu24zbyexn`.
- Phase 1 read integration passed compliance `thr_svi2xp58ik` and quality `thr_u33f6jdjdi`; final product review `thr_pu2xm632jc` passed against checkpoint `414f40a`.
- Phase 1 local read acceptance is complete. [docs/phase-1-acceptance.md](phase-1-acceptance.md) records both repository reads, reload, all five UI surfaces, repository switching, settings, Done status, capability wording, canonical links, and the enabled, paused, no-service, no-schedule state.
- The separate Phase 1 rollout gate remains open for the pending always-on hosting decision, the remote Connect owner-session mismatch, and a live `run_detail` path. Both run lists were empty during local acceptance, so run detail was not exercised live; unit coverage passed. Phases 2 through 5 remain open.
- The hosting gate in [docs/hosting-decision.md](hosting-decision.md) remains pending. No always-on non-personal host is verified, dispatch remains disabled, and no host is selected or provisioned. Data-platform work requiring Mac-local Aside/browser or dbt Studio remains gated.
- Phases 2 and 3 are implemented locally: guarded repository and BB interaction executors consume `pending_action_intents`, the dispatch engine (`src/dispatch/`), scheduler (`src/schedule/`), and lifecycle service (`src/lifecycle/`) are wired through `src/rpc/action-router.ts` and `src/services/action-composition.ts`, and the UI exposes the guarded action entry points in `src/ui/action-entry.ts`. Focused evidence: 115 tests passing across `tests/actions.test.ts`, `tests/dispatch.test.ts`, `tests/action-router.test.ts`, `tests/ui.test.ts`, and the existing suites, plus typecheck, lint, and build. Dispatch stays `paused` until the hosting gate closes; Phases 4 and 5 remain open.

## Phase 0 interaction amendment, v1.1, approved and frozen

The compliance finding in `thr_c8zj6b48mk` identified a response-critical loss in the v1 BB interaction DTO: question IDs, free-text and multi-select flags, option values, and exact approval decision tokens were discarded. The approved v1.1 amendment passed compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`. The v1.1 schemas and fingerprint are now frozen; Phase 1 consumers may adapt in parallel against this boundary.

The bounded change is:

- `src/contracts.ts` adds correlated top-level pending-interaction branches: `approval` with `approval` metadata, `user-question` with `user_question` metadata, and `plugin` with `plugin` metadata. It preserves display text separately from question IDs and option values, and exposes no provider-custom data, grants, or secrets.
- The BB answer action replaces arbitrary `value` JSON with typed `resolution` metadata for SDK-shaped `user_answer` and approval decisions. The action remains keyed by `interactionId` and resolves the identified interaction; opening a thread is not a substitute.
- `tests/contracts.test.ts` covers SDK-shaped question and approval fixtures, non-equivalent labels and values, missing response-critical fields, namespaced custom requests, raw-data rejection, exact decision-token validation, and all six mismatched top-level/metadata kind pairs.
- `src/ports.ts` and `src/rpc.ts` require no edits because their existing ports and RPC methods use the shared schemas.

Affected owners adapt as follows:

| Owner | Required adaptation |
| --- | --- |
| P1 BB interaction reader, `src/interactions/read.ts` | Copy the question and approval metadata into the DTO; normalize namespaced provider kinds to `plugin`; preserve stable interaction, thread, and turn IDs; omit raw custom data, grants, and secrets. |
| P1 UI, `src/ui/` | Render display labels and descriptions, but submit question IDs and option values. Use `allowFreeText`, `multiSelect`, and `availableDecisions` to constrain controls. Keep thread opening as navigation only. |
| P2 BB interaction actions, `src/actions/interactions.ts` | Accept typed resolution metadata, validate it against the pending interaction, and map it to the current SDK native resolver. Do not reintroduce arbitrary JSON or answer by merely opening a native thread. |
| P2 action integration, `src/rpc/action-router.ts`, `src/services/action-composition.ts`, `src/ui/action-entry.tsx` | Route the amended action unchanged through the existing source-discriminated request flow and preserve exactly-once behavior by `interactionId` and idempotency key. |

Provider-custom `request_answer` values remain intentionally outside this bounded public schema because the SDK defines them as arbitrary JSON. Supporting one later requires a provider-specific contract review, not a raw `data` or `value` passthrough. Root owns that decision if a later provider requires it.

## Settings registry amendment, v1.2, approved and frozen

The v1.2 settings registry is approved and frozen for P1 integration after compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`. It is an additive amendment to the v1.1 boundary; the prior v1.1 interaction provenance and fingerprints remain recorded above.

Current v1.2 source fingerprints, SHA-256, verified 2026-09-10:

| Path | SHA-256 |
| --- | --- |
| `src/contracts.ts` | `1c9a013f2addfb2323151b3b25ce697d8c6acf11628f9f26fd6ec7e6ab2d2114` |
| `src/settings.ts` | `1953623c8df0d04b597291661e70b3b7c330b8503dc4765e8d253099f5a016bb` |
| `src/rpc.ts` | `f05fb373f81ddafc9b7ce014a54ba41b23e889f6c390a8c3d9f0ab09a9124e25` |
| `src/ports.ts` | `690676ae621e8428a0d5cba608dc91399bcce1fc3e058d67436a33493d2e6923` |

The SDK settings descriptor surface accepts only primitive stored values. `src/settings.ts` therefore defines `repositoryRegistry` as a multiline string with a bounded JSON Standard Schema validator. `src/contracts.ts` parses the same value into these exact typed shapes:

- `RepositoryRegistryEntry`: `{ configuration: RepositoryConfiguration, projectId, environmentId }`, with all three associated BB/project/environment values required and the existing host/root/checkout validation retained inside `configuration`.
- `RepositoryRegistry`: `{ repositories, defaultRepositoryKey }`, with unique stable repository keys. A nonempty registry must select one of its keys; an empty registry selects `null`.
- `RepositoryRegistryResolution`: either `configured` with all entries and `selectedRepositoryKey`, or `disabled` with an empty list and an explicit `not-configured`, `legacy-incomplete`, or `explicitly-empty` reason.

Selection is compatible with the current UI: `FactorySettings.repositoryKey` remains the selected-key override. The resolver uses that override when present, otherwise the registry default. A selected override not present in the registry is rejected. The registry is typed settings-derived data, not a second discovery system; P1 can adapt each `configuration` to the existing `ProtocolRepositoryRegistry` and use each entry's project/environment pair for the existing BB scope lookup.

Migration is deterministic and non-destructive. The registry descriptor has no stored default, so absent `repositoryRegistry` leaves legacy settings eligible for migration. A complete legacy single-repository setting, including the newly required project and environment values, becomes one registry entry with `factory` and `origin/main`. Legacy values missing any required field resolve to disabled `legacy-incomplete`, without synthesized paths or IDs. An explicitly supplied empty registry takes precedence over legacy fields and resolves to disabled `explicitly-empty`. No legacy fields resolve to disabled `not-configured`. The default remains paused, provider preference remains unset, provider pins are unchanged, and no dispatch or live write is enabled.

The focused contract evidence is 18 passing tests, typecheck, and lint. Tests cover two repositories, duplicate keys, invalid default and selected keys, strict-field rejection, effective descriptor defaults merged with legacy settings, explicit-empty disable precedence, complete and incomplete legacy migration, and disabled defaults. The frozen v1.2 amendment changes only `src/contracts.ts`, `src/settings.ts`, `tests/contracts.test.ts`, and the two contract documents; `src/ports.ts`, `src/rpc.ts`, reader/UI files, runtime workers, and package files remain untouched.

| Task | One worker | Owned paths | Consumes | Predecessor review | Integration owner |
| --- | --- | --- | --- | --- | --- |
| P0 contract/bootstrap | Luna Extra High, current phase owner | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `server.ts`, `src/contracts.ts`, `src/settings.ts`, `src/rpc.ts`, `src/ports.ts`, `tests/contracts.test.ts`, `docs/phase-0-contract.md`, this map | Current `@get-bb/plugin-sdk` declarations, shell migration inputs, PLAN boundaries | None; v1 compliance `thr_xrnpijf4nt`, v1 quality `thr_84bhqsym63`, v1.1 compliance `thr_vme9e859th`, v1.1 quality `thr_5ei85kmian`, v1.2 compliance `thr_vme9e859th`, and v1.2 quality `thr_5ei85kmian` passed | Root thread |
| P1 protocol adapter | Luna Extra High | `src/protocol/`, protocol-focused tests | Implements reviewed `ProtocolReader.loadSnapshot`, plus `RepositoryConfiguration`, `ProtocolSnapshot`, `QueueEntry`, `Question`, `DashboardSummary`, `ForemanTemplateSource`, `RepositoryRevision` | P0 quality review | Named Phase 1 protocol task owner |
| P1 operational state | Luna Extra High | `src/storage/`, storage-focused tests | Implements reviewed `OperationalStateReader.listRuns` and `getRun`, including required BB project/environment linkage, plus `RunIntent`, `DispatchAttempt`, `OwnershipLease`, `RepositoryRevision`, idempotency result shape | P0 quality review | Named Phase 1 state task owner |
| P1 live health adapter | Luna Extra High, Phase 1 read integration owner | `src/services/live-health.ts`, health-focused tests | Implements reviewed `FactoryHealthReader.listProviderStatus` and `getHostPreflight` from live BB and host state | P0 quality review | P1 read integration and UI wiring owner |
| P1 BB interaction reader | Luna Extra High | `src/interactions/read.ts`, pending-interaction tests | Implements reviewed `PendingInteractionReader` from current BB thread interaction reads; preserves stable interaction, thread, and turn IDs | P0 quality review | P1 read integration and UI wiring owner |
| P1 read integration and UI wiring | Luna Extra High, Phase 1 integration owner | `server.ts`, `src/rpc/read-router.ts`, `src/services/read-composition.ts`, `src/services/read-action-composition.ts`, `src/ui/index.ts`, `package.json` `bb.app` registration, read/UI tests | Consumes `ProtocolReader`, `OperationalStateReader`, `FactoryHealthReader`, `PendingInteractionReader`, `ReadOnlyActionExecutor`, `FactoryRpcContract`, repository selection/settings/health/pending-interaction/run projections, `InvalidationEvent` | Reviewed P1 protocol, operational-state, live-health, BB-interaction, and read-only UI outputs, each after its own compliance and quality reviews; composition starts only after those outputs are reviewed | Root coordinates composition and manifest integration |
| P1 read-only UI | Luna Extra High | `src/ui/`, UI-focused tests excluding the entry and manifest paths owned above | `ProtocolSnapshot`, `ProviderStatus`, `HostPreflight`, pending BB interaction projection, `InvalidationEvent`, validated read RPC outputs | P0 quality review | P1 read integration and UI wiring owner |
| P2 repository actions | Luna Extra High | `src/actions/repository.ts`, repository-action tests | Implements reviewed `RepositoryActionExecutor` and `RepositoryActionRequest`; handles only `repository-question` answers and repository queue writes with `FactoryActionResult`, `FactoryError`, `RepositoryRevision`, authorization, and eligibility fields | P1 protocol compliance and quality reviews | Named Phase 2 repository-action task owner |
| P2 BB interaction actions | Luna Extra High | `src/actions/interactions.ts`, interaction-action tests | Implements reviewed `BbInteractionActionExecutor` and `BbInteractionActionRequest`; handles only `bb-interaction` answers by stable `interactionId`, exactly once under idempotency, plus run-control actions and `InvalidationEvent` | P1 UI and state quality reviews | Named Phase 2 interaction-action task owner |
| P2 action integration | Luna Extra High, Phase 2 integration owner | `src/rpc/action-router.ts`, `src/services/action-composition.ts`, `src/ui/action-entry.tsx`, action integration tests | Routes source-discriminated answers to the correct executor, consumes both guarded executor ports and the shared request/result/error convention, and calls validated RPC only. Revision-free reads remain owned by P1 composition. | P1 compliance and quality reviews, plus P2 worker reviews | Root coordinates action composition |
| P3 ownership and dispatch | Luna Extra High | `src/dispatch/ownership.ts`, `src/dispatch/preflight.ts`, `src/dispatch/start.ts`, dispatch tests | `OwnershipLease`, `RunIntent`, `DispatchAttempt`, `HostPreflight`, `ProviderStatus` | P2 action compliance and quality reviews | Phase 3 integration owner |
| P3 worker lifecycle and recovery | Luna Extra High | `src/dispatch/lifecycle.ts`, `src/dispatch/recovery.ts`, `src/dispatch/cancel.ts`, `src/dispatch/retry.ts`, recovery tests | `DispatchAttempt`, `OwnershipLease`, `ForemanOutcome`, `FactoryError`, BB thread links | P3 ownership compliance and quality reviews | Phase 3 integration owner |
| P3 scheduler | Luna Extra High | `src/schedule/`, scheduler tests | `FactorySettings`, `RunIntent`, `OwnershipLease`, `InvalidationEvent` | P3 ownership compliance and quality reviews | Phase 3 integration owner |
| P3 lifecycle integration | Luna Extra High | `src/lifecycle/`, lifecycle tests | `OwnershipLease`, `DispatchAttempt`, `ProviderStatus`, `HostPreflight`, SDK `onDispose` contract | P3 state, dispatch, and recovery quality reviews | Phase 3 integration owner |
| P4 controlled cutover | Luna Extra High | `docs/cutover.md`, cutover smoke tests, no legacy source paths | All Phase 3 contracts plus verified shell state and repository revisions | Phase 3 integrated compliance and quality reviews | Root thread |
| P5 legacy removal | Luna Extra High | migration/rollback documentation and explicitly approved legacy archive paths | Cutover acceptance evidence and rollback contract | Phase 4 acceptance review | Root thread |

## Phase 0 to Phase 2 surface audit

Every named Phase 0 to Phase 2 behavior has a reviewed input, output, and owner path:

| Surface | Reviewed input and output | Owner paths |
| --- | --- | --- |
| Phase 0 settings and wire boundary | Settings descriptors, `FactoryRpcContract`, typed errors, idempotency, revisions, and invalidation events | `src/settings.ts`, `src/contracts.ts`, `src/rpc.ts`, `src/ports.ts` |
| P1 repository protocol read | `ProtocolReader.loadSnapshot(RepositoryConfiguration)` to `ProtocolSnapshot` | `src/protocol/`, protocol tests |
| P1 operational run read | `OperationalStateReader.listRuns/getRun` to run list/detail projections with BB project/environment linkage | `src/storage/`, storage tests |
| P1 live health read | `FactoryHealthReader.listProviderStatus/getHostPreflight` to the health projection | `src/services/live-health.ts`, health-focused tests |
| P1 BB interaction read | `PendingInteractionReader.listPendingInteractions(repositoryKey)` to pending interactions with stable `interactionId` | `src/interactions/read.ts`, pending-interaction tests |
| P1 read composition and UI | Validated repository, settings, health, interaction, run, snapshot, and revision-free action RPC inputs/outputs | `server.ts`, `src/rpc/read-router.ts`, `src/services/read-composition.ts`, `src/services/read-action-composition.ts`, `src/ui/index.ts`, `package.json` `bb.app` block |
| P2 repository action | Source `repository-question` answer and queue action subsets to `FactoryActionResult` | `src/actions/repository.ts`, repository-action tests |
| P2 BB interaction action | Source `bb-interaction` answer with stable `interactionId`, exactly-once idempotency, plus Run now, Retry, Pause, and Stop to `FactoryActionResult` | `src/actions/interactions.ts`, interaction-action tests |
| P2 action composition | Source-discriminated routing to the correct guarded executor; Approve queue composes through the repository executor | `src/rpc/action-router.ts`, `src/services/action-composition.ts`, `src/ui/action-entry.tsx`, action integration tests |

## Interface change rule

An interface change returns to P0. The owning worker must stop at the boundary, record the requested change, and wait for root to rerun compliance and quality review. No task edits another task's owned path to work around a contract mismatch.
