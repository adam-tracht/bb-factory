# bb-factory instructions

This repository began as **planned, not implemented**. Phase 0 bootstrap is now complete and frozen; downstream phases remain unimplemented. Read [PLAN.md](PLAN.md) before implementation. Keep the build efficient and avoid speculative scaffolding.

## Factory protocol

This repository is the factory plugin source, not yet a factory-managed target repository. It has no `plans/factory/` protocol or queue. The managed-repository protocol below applies when operating a target checkout; Phase 0 bootstrap work here uses [PLAN.md](PLAN.md) and must not fabricate queue, lock, current, question, or run records.

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

The planned plugin provides purpose-built overview, queue, questions, runs, and settings views over the existing factory protocol. It is a presentation and control surface, not a replacement task tracker. The current shell sources under `~/.bb/factory/` remain active until an implemented migration supersedes them.

## Delegation and models

Use native `bb thread spawn` for subagents. Run independent tasks in parallel when their interfaces do not depend on one another. Use Luna at xhigh reasoning for most implementation, debugging, and broad technical work. Use Sol at low reasoning for judgment, prioritization, and concise review. Keep prompts self-contained and send each task through the repository protocol.

For the current approved Phase 0 assignment, use Luna Extra High for the implementation worker and separate Sol Medium reviews for compliance followed by code quality. Root coordinates those reviews and freezes the phase only after both pass.

Review after each task: check protocol and acceptance criteria first, then check reuse, simplicity, and maintainability. Do not overengineer or add tests that do not protect a stated behavior.

## Local development

At the documentation-only baseline there was no package or code scaffold. Phase 0 adds the minimal package and uses `pnpm` for local development. BB Git installs currently use `npm`; do not describe pnpm as the BB installation mechanism. Keep `PLAN.md`, lockfiles, manifests, and `.env.example` trackable.

## Permanent repository rules

- Never open pull requests. This is a solo repository; use the approved branch workflow directly.
- Never commit to or switch to `main` during factory work.
- Never make automatic changes to main-branch policy.
- Never bypass a human `approved:` queue authorization for protected operations.
- Never discard or rewrite immutable factory run records.

No temporary restriction on commits is encoded here. Normal implementation work may commit to the approved branch when authorized by the repository workflow.
