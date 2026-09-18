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

