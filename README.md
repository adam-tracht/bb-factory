# bb-factory

**Status: Phase 0 bootstrap complete and frozen at contract `v1.2`; Phase 1 local read acceptance is complete; Phase 2 guarded actions and the Phase 3 dispatch engine are implemented locally with dispatch paused; rollout gates remain open.** See the [implementation plan](PLAN.md), [Phase 1 acceptance](docs/phase-1-acceptance.md), and [Phase 0 contract](docs/phase-0-contract.md).

`bb-factory` is intended to replace the current nightly factory dispatcher with a purpose-built BB plugin. The plugin UI provides overview, work, questions, runs, and settings tabs, a repositories landing view, and an add-repository wizard, with guarded action controls (pause/resume and confirmed run-now in the shell header, item actions via `ViewContext.onAction`), an editable settings form, confirm dialogs, and environment-scoped file links. It must preserve the operating contracts that already work in the repository factory repos.

Until migration is complete, the active system is the shell tooling under `~/.bb/factory/`:

- `dispatch.sh` starts and supervises one unattended foreman per repository during the night window.
- `redeploy.sh` updates the BB automations while carrying their environment configuration.
- `merge-state.sh` reports what is ready to merge.
- `templates/foreman.md` supplies the generic foreman protocol.

## Operating contract

- Each repository has at most one unattended foreman during the night window.
- The foreman works on the `factory` branch only. It does not merge or switch to `main`.
- The initial queue is human-authorized. A queue entry is eligible only when a human has marked it ready, its dependencies are satisfied, and no blocking question is open.
- Repository-specific protocols, checks, dashboards, and integration policies remain authoritative. The generic factory protocol never replaces those customizations.
- The plugin must not create a second task system. The existing repository queue and canonical dashboards remain the source of truth.
- The plugin must not automatically change a repository's main-branch policy.

## Dispatcher configuration

The dispatcher receives these values from the BB automation environment:

- `REPO_PATH`: the repository worktree.
- `REPO_KEY`: the stable repository key used for state and reporting.
- `WINDOW_END_HOUR`: the local hour at which new work stops.
- `PREFER`: the preferred provider, or the configured alternation behavior.
- `BB_PROJECT_ID`: the BB project containing the factory threads.
- `STATE_DIR`: the directory containing dispatcher state.

## Dispatcher state

State is kept per repository and records the active thread and provider, start times, provider limits, the last foreman state, failure and no-op counts, and the current night key. The plugin should expose this state without changing its meaning.

Safety behavior includes:

- A runtime cap that defaults to `10,800` seconds.
- A one-hour minimum gap between foreman starts.
- Provider retry limits and failover to the other provider when the preferred provider is limited.
- `jq` as a dispatcher dependency.
- Safe stopping after blocked or repeated failed-safe/no-op outcomes, according to the current dispatcher protocol.

The current `redeploy.sh` pins both existing automations to Codex with `MAX_RUN_SECONDS=10800`; the dispatcher default remains `alternate`. `merge-state.sh` is Bash 3.2 compatible and currently hard-codes the monorepo and diggs-data-platform factory paths. The dispatcher header says it exits 0 in all cases, but missing `REPO_KEY` or `jq` currently exits 1. `noopCount` resets when the night key changes, not after a successful run.

Foreman outcomes are exactly:

- `success`
- `blocked`
- `failed-safe`
- `no-op`

## Merge reporting

Merge reporting compares `factory` with `origin/main`, identifies the task commits that are not yet merged, excludes claim, release, and run-record commits, and reports whether the result can be fast-forwarded safely. The plugin may present this report, but must preserve the canonical repository dashboard and its existing merge policy.

## Factory files and human workflow

Each managed repository keeps its authoritative protocol and state under `plans/factory/`:

- `foreman.md` and `repo.md` define the generic and repository-specific rules.
- `queue.md` contains human-authorized work.
- `current.md` contains the latest run state.
- `runs/` contains immutable run records.
- `questions.md` contains blocking questions and assumptions.
- `lock` coordinates unattended work.

A human adds acceptance criteria and validation commands to a queue entry, marks it ready, reviews the current report and questions in the morning, checks `factory` against `main`, and decides whether to merge. Repository integration policies remain in `repo.md` and are not inferred or rewritten by the plugin.

## Development status

The documentation-only baseline has been augmented with the Phase 0 package, typed contracts, settings boundary, RPC/error/idempotency/revision/invalidation contracts, startup/disposal skeleton, reviewed Phase 1 protocol, storage, health, interaction, RPC, and native UI surfaces, and the Phase 2 guarded executors plus Phase 3 dispatch engine, scheduler, and lifecycle service. Local acceptance is recorded in [docs/phase-1-acceptance.md](docs/phase-1-acceptance.md); the remote Connect and always-on hosting gates remain open. Dispatch stays `paused`: no live dispatch, cutover, or legacy dispatcher change is active. The implemented P2 action constraints are in [docs/action-implementation-gates.md](docs/action-implementation-gates.md). Use `pnpm` for local development; current BB Git installs use `npm`. Revisit whether `dist/` should remain ignored when npm distribution is designed.
