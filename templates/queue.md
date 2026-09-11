# Factory queue

Tasks the factory may take. The dashboard in `plans/README.md` stays canonical for status; this file adds what an unattended run needs. Only the human makes a task eligible for the first time. The foreman may restore that task to `ready` when releasing or recovering an existing claim under this protocol.

Entry format (copy the block, one per task):

```
## <DASHBOARD-ID> <short title>
status: draft | ready | in-progress (...) | done (...) | blocked-by: Q<n>
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
- Acceptance criteria are things a script or a reviewer can check, not intentions.
- Validation commands must run to completion inside this worktree without a human.
- `risk: high` entries need at least one `approved:` item or they will be skipped.

