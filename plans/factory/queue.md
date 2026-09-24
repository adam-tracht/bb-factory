# Factory queue

Tasks the factory may take. The dashboard in `plans/README.md` stays canonical for status; this file adds what an unattended run needs. Only the human makes a task eligible for the first time. The foreman may restore that task to `ready` when releasing or recovering an existing claim under this protocol.

This file holds open work only. When a task reaches `done (run <timestamp>)`, the foreman moves its whole entry to `plans/factory/done.md` in the same commit; the plugin reads both files, so nothing disappears from the UI.

Entry format (copy the block, one per task):

```
## <DASHBOARD-ID> <short title>
status: <exactly one of: draft | ready | in-progress (thread <id>, <timestamp>) | done (run <timestamp>) | blocked-by: Q<n>>
priority: 1 (highest) to 5
depends_on: <IDs, or none>
risk: low | medium | high
plan: <relative path to the canonical plan file and section>
approved: <none, or the explicit list of gated actions the human allows: dependency add, migration, ...>
acceptance:
- <observable criterion 1>
- <observable criterion 2>
validate:
- <exact command 1>
- <exact command 2>
notes: <anything the foreman should know>
```

Rules:
- `status:` accepts only the five forms above, spelled exactly. There is no status for waiting on a human (approval, review, decision): that is always a question in `questions.md` plus `blocked-by: Q<n>`. Any other value renders as "Unrecognized status" and the entry is skipped by every run.
- An entry with `status: done` does not stay here; it moves to `done.md`. Dependencies on tasks already in `done.md` are satisfied.
- Extra notes about an entry (`failed:`, `recovered:`) go on their own line under `status:`; a bare line of text under `status:` is read as part of the status and breaks it.
- Acceptance criteria are things a script or a reviewer can check, not intentions.
- Validation commands must run to completion inside this worktree without a human.
- `risk: high` entries need at least one `approved:` item or they will be skipped.

## BBF-0049 Native Tasks core rebuild
status: blocked-by: Q7
recovered: 2026-09-22T16:17Z released the stale claim from thread thr_wswppd4ja4 after that thread died mid-review, per the claim-recovery rule in this file's header.
priority: 1
depends_on: none
risk: high
plan: plans/native-tasks-migration.md
approved: none
acceptance:
- Phase 0 spike records delegate, environment, authorship, and failure behavior against the plan's kill criteria.
- Tasks adapter and safety ledger land behind a flag with the direct-spawn path still default.
- Delegation runs through a durable intent with ambiguous outcomes quarantined, never blind-retried.
- Settlement requires terminal thread state plus expected repo revision change plus current generation.
- A stuck run quarantines only its own repository's dispatch.
- queue.md and questions.md leave the correctness path; Tasks is the queue.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Human authorized the plan and implementation in thread thr_wswppd4ja4. Work lands on branch factory-tasks in worktree /Users/adamtracht/Desktop/Code/bb-factory-tasks so the installed stable checkout is untouched. Phases 0 through 3 are implemented and reviewed on factory-tasks across commits 2e5e7cc, ce2bce7, 8253791, and 47c4b9f; three independent reviews returned PASS with no blocking findings, and 660 tests plus typecheck, lint, build, SDK freshness, and whitespace pass at 47c4b9f. Remaining work is the Go-live and cutover section of plans/native-tasks-migration.md only. Go-live, per-repo cutover, dependency changes, and any protected operations still need an explicit approved: line before a run may do them.

## BBF-0007 Marketplace listing
status: blocked-by: Q8
priority: 4
depends_on: BBF-0004, BBF-0006
risk: high
plan: PLAN.md (Phase 6, deliverable 7)
approved: none
acceptance:
- A public git repo carries a vX.Y.Z tag.
- An entries/bb-factory.json v2 entry exists in the get-bb/marketplace fork with icon, screenshots, and overview.
- Submission goes through PR or the intake form per the registry README at submit time.
validate:
- marketplace repo CI validation
notes: Publishing, tagging, and opening the marketplace PR are protected and need an `approved:` line before a run may do them.

## BBF-0050 Validate protocol writes before settlement
status: draft
priority: 2
depends_on: none
risk: medium
plan: plans/factory/queue.md (this entry)
approved: none
acceptance:
- Before a run's protocol commit is accepted, settlement parses plans/factory/queue.md, done.md, questions.md, current.md, and the dashboard with the same readers the plugin uses to load a repository.
- A malformed write (a dashboard row with the wrong column count, an unknown current.md state such as idle, an unrecognized queue status) fails the run as failed-safe with the parse error, and the repository still loads from its last good state.
- Only mechanically safe repairs are automatic (for example escaping a literal pipe inside a table cell); every repair is recorded in the run record, and anything else fails the write.
- The foreman protocol text tells workers to escape pipes in table cells and lists the exact valid current.md states.
- Tests cover the three malformed writes seen in the monorepo: a pipe inside an evidence cell, a pipe used as a sentence separator, and state idle in current.md.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- git diff --check
notes: Three consecutive monorepo runs did real work and then failed-safe because the worker's own protocol writes were malformed; each bad write took the whole repository's load down until repaired by hand (monorepo commits 1f6dfea and 87a829f). Found in thread thr_wswppd4ja4.

## BBF-0051 Show the parse diagnostic on failed-safe runs
status: draft
priority: 2
depends_on: BBF-0050
risk: low
plan: plans/factory/queue.md (this entry)
approved: none
acceptance:
- A run that fails-safe on a protocol parse error stores the file, line, and broken rule in its run state.
- The run detail and the repository load-error banner show that file, line, and rule, with a file link, in place of the generic banner.
- A repository that fails to load for a parse error outside a run shows the same diagnostic.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- git diff --check
notes: Today the UI shows only a generic banner, so finding the broken line took manual digging each time. Reuse the diagnostic produced by BBF-0050.
