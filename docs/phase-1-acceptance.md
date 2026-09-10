# Phase 1 runtime acceptance

Status: **LOCAL RUNTIME READ ACCEPTANCE PASS; NATIVE UI ACCEPTANCE PASS; REMOTE ROUTE UNVERIFIED**. This local acceptance checkpoint is complete and records the bounded acceptance retest on 2026-09-10. It does not approve rollout or close the always-on hosting gate. PLAN remains open.

The hosting decision remains pending in [docs/hosting-decision.md](hosting-decision.md); no host was selected or provisioned by this acceptance.

## Reviewed package gates

- Source under test: owner checkpoint `414f40a`, `fix(factory): align product projections and UI [skip-docs]`, present in the six-path corrected working tree. Checkout `HEAD` remained `285737a` during this read-only retest.
- `pnpm run build`: passed. Native bundles generated successfully.
- `pnpm test -- --reporter=dot`: 12 files, 64 tests passed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `bb plugin types --check`: passed with SDK pin `0.4.47` matching the host.
- `git diff --check`: passed.
- Frozen v1.2 fingerprints for `src/contracts.ts`, `src/settings.ts`, `src/rpc.ts`, and `src/ports.ts` matched `docs/phase-0-contract.md`.

## Install and configuration

The local install succeeded with plugin ID **`bb-factory`**. The prepared `factory` ID was not used after BB reported the actual ID. No prior Factory installation or configuration existed.

Observed live state after the corrected build and reload:

- `enabled: true`, `status: running`.
- `dispatchMode: paused`.
- `services: []`, `schedules: []`.
- Registry contains `monorepo` and `diggs-data-platform`, with default `monorepo`.
- No secrets were supplied or exposed.

The configured registry used these verified identifiers:

```json
{"repositories":[{"configuration":{"repositoryKey":"monorepo","repositoryRoot":"/Users/adamtracht/Desktop/Code/monorepo","connectedHostId":"host_mpvbhvugjr","checkoutPath":"/Users/adamtracht/Desktop/Code/monorepo-factory","factoryBranch":"factory","mainRef":"origin/main"},"projectId":"proj_8i22vu2twt","environmentId":"env_9es5j2rnbt"},{"configuration":{"repositoryKey":"diggs-data-platform","repositoryRoot":"/Users/adamtracht/Documents/GitHub/diggs-data-platform","connectedHostId":"host_mpvbhvugjr","checkoutPath":"/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory","factoryBranch":"factory","mainRef":"origin/main"},"projectId":"proj_dr2ff59zau","environmentId":"env_2rv72nh5gm"}],"defaultRepositoryKey":"monorepo"}
```

## Safety evidence

- The 21-file monorepo canonical aggregate fingerprint stayed `38c54c192b76ad86ed31afd1cf0b45823452f34464be1a5f3543056965b59442` before and after the retest. The 19-file data-platform fingerprint stayed `2dd12574276c2c876acc7ddc4f453cf6815535ad0a608b36aa4e1fd45a9a716c`.
- The monorepo project thread set changed from 358 to 361 during the window. The three new IDs were `thr_4738wueraz`, `thr_e5g4trtpr4`, and `thr_esykzafkiw`; each had `originKind: null`, `originPluginId: null`, and `sourceThreadId: null`, under the existing `env_9es5j2rnbt` environment and parent chain. They were not stopped or attributed to the plugin. The data-platform set stayed at 265 with the same aggregate fingerprint.
- After reload and UI reads, the plugin remained enabled and running with `services: []`, `schedules: []`, and handler `errorCount: 7`; no dispatch, worker, scheduler, or action was invoked by this acceptance.
- The two earlier new monorepo threads were independently confirmed as active Codex threads under parent `thr_52dsufq9jw`, with `originPluginId: null`; they were not stopped or attributed to the plugin.

## Read RPC results

All repository selection checks and read RPCs passed for both repositories. `factory_snapshot` returned HTTP 200 for both repositories, with `lock: null`, canonical dashboard path `plans/README.md`, and repository revisions matching the configured factory worktrees. `factory_settings` returned HTTP 200 for both repositories with a two-entry registry, default `monorepo`, paused dispatch, and `acceptingNewRuns: false`; optional `settings.repositoryKey` was not required. `factory_health`, `factory_interactions`, and `factory_runs` also returned HTTP 200. Both run lists were empty, so `factory_run_detail` had no safe run ID to exercise.

Resolved runtime defects:

1. The absent optional lock was previously surfaced as HTTP 500. Commit `285737a` classifies the raw SDK missing-file error as `file-not-found`; both live snapshots now return `lock: null`.

2. The settings projection previously exposed undefined optional fields to the real SDK serializer. The corrected projection now returns valid JSON for both repositories.

## Native UI acceptance

The local native route `http://127.0.0.1:38886/plugins/bb-factory/factory` rendered successfully in Aside account `u0`, which matched `adam@diggs.pet`. The selector retest passed in read-only navigation:

- `monorepo` was initially selected, then `diggs-data-platform` was visibly selected, showing root `/Users/adamtracht/Documents/GitHub/diggs-data-platform` and revision `3ffc0b3d5691fd3ce9d12a109ce8494df17b3e6d`.
- The selector was switched back to `monorepo`, showing root `/Users/adamtracht/Desktop/Code/monorepo` and revision `6d132677c81e655fc609a243a49706ba0f4fc6d7`.
- Settings showed truthful selected values for both keys. `monorepo` showed its configured root and checkout `/Users/adamtracht/Desktop/Code/monorepo-factory`; `diggs-data-platform` showed its configured root and checkout `/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory`. Both showed host `host_mpvbhvugjr`, valid configuration, paused dispatch, `accepting new runs No`, and `active runs 0`.
- Queue rendered completed entries as `Done` without the misleading `Blocked` prefix. Overview and Settings both displayed the scoped capability copy `This plugin version exposes no dispatch implementation.`
- Existing five-screen evidence remains valid: Overview, Queue, Questions, Runs, and Settings all rendered; Questions showed 0 pending BB interactions and Runs showed `No runs recorded` for the previously selected monorepo state. Canonical links rendered for `plans/factory/current.md`, the immutable run record, `plans/factory/foreman.md`, and `plans/README.md`.

Current product-review screenshots are captured under these exact paths:

1. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-uBkLN10Z3McXsQKh.jpeg` , initial monorepo Overview.
2. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-rapDZv0SToYXjdnQ.jpeg` , data-platform Overview.
3. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-7N0tt5HsyopTHI5N.jpeg` , monorepo after switching back.
4. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-YzXLGkgX38TIHoK8.jpeg` , monorepo Settings.
5. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-0Gfyb5YfRqqcfEIo.jpeg` , data-platform Settings.
6. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_FKBQ3C6OM3NbHboc/tmp/repl-display-eY45HQJzaR0pHDDb.jpeg` , data-platform Queue.
7. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_hYnNhUWgZQOASRZu/tmp/repl-display-nlMZrHh3zb4R5n5X.jpeg` , corrected monorepo Queue with Done statuses.
8. `/Users/adamtracht/.aside/u/0/sessions/2026-09-10_nJKel11vDphzYDDD/tmp/repl-display-AkV2FOkH6CYVlVEo.jpeg` , final monorepo Overview.

The user-facing route `https://adam.getbb.app/plugins/bb-factory/factory` remains unverified. The bounded remote probe returned `bb connect: not your server`; the current Connect diagnosis identifies an owner-session mismatch on `adam/default/live/self`, not a route mismatch. No login or password-manager flow was triggered because the remote response was not a login form.

The plugin remains installed, enabled, running, and paused with no services or schedules. No dispatch, action, legacy automation, worker, repository write, staging, or commit was performed by this acceptance. The remote route remains an independent ownership limitation and was not changed.
