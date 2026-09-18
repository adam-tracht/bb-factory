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

## BBF-0007 Marketplace listing
status: ready
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

## BBF-0047 Agent-drafted queue entries
status: draft
priority: 2
depends_on: none
risk: low
plan: docs/control-surface.md (Work tab, wizard), src/actions/interactions.ts (Recommend pattern), templates/foreman.md
approved: none
acceptance:
- A "Draft tasks" control exists on the Work tab and as the final step of the add-repository wizard (after scaffolding). It takes a free-text goal and an optional plan file path.
- The control spawns an advisory bb thread on the repository's factory checkout, following the Recommend action's spawn pattern in `src/actions/interactions.ts`. The thread reads `plans/factory/repo.md` and the queue format header, then appends entries to `plans/factory/queue.md` with `status: draft`, observable acceptance criteria, and validate commands, and commits them on `factory`.
- The thread never writes any status other than `draft` and never edits existing entries. The human-only initial `ready` gate is unchanged.
- The Work tab surfaces the new drafts in the collapsed Drafts group with the existing Approve control once the file is re-read.
- `templates/foreman.md` and `plans/factory/foreman.md` gain one rule: the foreman may append `draft` entries for follow-up work it notices, and must mention them in the run report.
- `README.md` quickstart step 4 and `docs/control-surface.md` describe the flow.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Motivation: in practice queue entries are never hand-written; an agent drafts them. `draft` status (BBF-0013) already makes agent-authored entries safe, so no new guarded RPC is needed; the thread commits like the foreman does. Keep the spawn advisory and repository-scoped; no All-scope variant.
