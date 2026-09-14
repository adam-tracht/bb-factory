# bb-factory instructions

This repository ships **v0.1.3** of the factory plugin and is preparing the approved **v0.1.4** release, installable via `bb plugin install git:github.com/adam-tracht/bb-factory`. The wire contract is frozen at `v1.2`: the `bbf:v1:<repository>:<operation>:<UUID>` idempotency-key shape and the action/revision/RPC seams in `src/contracts.ts` are immutable, and interface changes return to review before landing (the full Phase 0 contract record was removed post-ship and lives in git history). Phases 1 through 6 are implemented, including guarded actions, the dispatch engine, the quickstart add-repository wizard, protocol scaffolding, and dedicated-worktree provisioning. Open work: the Phase 1 rollout gate (always-on host, remote Connect owner-session route, live `run_detail` path; [docs/hosting-decision.md](docs/hosting-decision.md)) and the marketplace listing (BBF-0007, human-gated). Read [PLAN.md](PLAN.md) and [docs/action-implementation-gates.md](docs/action-implementation-gates.md) before implementation. Keep the build efficient and avoid speculative scaffolding.

## Factory protocol

This repository is both the factory plugin source and a factory-managed target repository: `plans/factory/` carries its own foreman protocol, queue, questions, current state, and run records, and `plans/README.md` is its canonical dashboard. Unattended factory runs: see `plans/factory/foreman.md`. Human-only: setting `status: ready` in `plans/factory/queue.md`. Phase planning and contract history still live in [PLAN.md](PLAN.md) and `docs/`.

For work in a factory-managed repository:

1. Read `plans/factory/foreman.md` first.
2. Read `plans/factory/repo.md` second.
3. Treat `repo.md` as authoritative when it differs from the generic protocol.
4. Work only on `factory`. Never commit to or switch to `main`.
5. Select only human-authorized queue entries with `status: ready`, satisfied dependencies, and no open blocking question.
6. Claim in dependency order, delegate self-contained worker jobs, review worker output for spec compliance and then code quality, and run every required validation command.
7. Make one task commit that includes the required dashboard row and queue update, then push to `origin/factory`.
8. Update the canonical repository dashboard. Do not replace it with a plugin-owned duplicate.
9. Maintain `plans/factory/queue.md`, `current.md`, immutable `runs/<timestamp>-<thread>.md` records, `questions.md`, and the lock file.
10. End the report with the exact line `state: <success|blocked|failed-safe|no-op>`.

Do not merge, deploy, migrate, change dependencies, touch secrets, delete data, or change customer-facing behavior without an `approved:` line on the queue entry. The foreman never waits for an answer. Record questions in `questions.md` with `blocking` or `assumption` classification.

Preserve each repository's custom checks, dashboards, queue authorization, and integration policies. Do not introduce a duplicate task system or automatically change a repository's main-branch policy.

## Plugin scope

The plugin provides purpose-built overview, work, questions, runs, and settings tabs over the existing factory protocol, an aggregate "All" scope that unions the overview, work, questions, and runs tabs across registered repositories (settings stays repository-scoped), plus a repositories landing view and an add-repository wizard. The shell header owns the segmented repository switcher, dispatch chip, pause/resume, and the confirmed run-now control; tab badges come from the pure attention model; views dispatch guarded actions through `ViewContext.onAction`; settings is an editable form backed by the settings-mutation RPCs; file links are environment-scoped; unknown queue statuses render tolerantly. It is a presentation and control surface, not a replacement task tracker; how the surface is composed (aggregate scope, wizard chrome, disclosure, deep links, chips) lives in [docs/control-surface.md](docs/control-surface.md). The current shell sources under `~/.bb/factory/` remain active until an implemented migration supersedes them.

## Delegation and models

Use native `bb thread spawn` for subagents. Run independent tasks in parallel when their interfaces do not depend on one another. Use Luna at xhigh reasoning for most implementation, debugging, and broad technical work. Use Sol at low reasoning for judgment, prioritization, and concise review. Keep prompts self-contained and send each task through the repository protocol.

For implementation work, use Luna Extra High for the worker and separate Sol Medium reviews for compliance followed by code quality. Root coordinates those reviews and freezes the task only after both pass.

Review after each task: check protocol and acceptance criteria first, then check reuse, simplicity, and maintainability. Do not overengineer or add tests that do not protect a stated behavior.

## Local development

The package uses `pnpm` for local development. BB Git installs use `npm`; do not describe pnpm as the BB installation mechanism. Keep `PLAN.md`, lockfiles, and manifests trackable.

Run verification through `pnpm test` / `pnpm typecheck` / `pnpm lint` (pnpm is pinned to Node 20). Invoking `node_modules/.bin/vitest` or `tsc` under the machine-default Node 24 fails on the better-sqlite3 native module; if it was rebuilt for a different Node, `pnpm rebuild better-sqlite3` restores it.

## Permanent repository rules

- Never open pull requests. This is a solo repository; use the approved branch workflow directly.
- Never commit to or switch to `main` during factory work.
- Never make automatic changes to main-branch policy.
- Never bypass a human `approved:` queue authorization for protected operations.
- Never discard or rewrite immutable factory run records.

No temporary restriction on commits is encoded here. Normal implementation work may commit to the approved branch when authorized by the repository workflow.
