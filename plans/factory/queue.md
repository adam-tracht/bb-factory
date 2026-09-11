# Factory queue

Tasks the factory may take. The dashboard in `plans/README.md` stays canonical for status; this file adds what an unattended run needs. Only the human makes a task eligible for the first time. The foreman may restore that task to `ready` when releasing or recovering an existing claim under this protocol.

Entry format (copy the block, one per task):

```
## <DASHBOARD-ID> <short title>
status: ready | in-progress (...) | done (...) | blocked-by: Q<n>
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

## BBF-0001 Spawn contract and registry schema
status: done (orchestrated session 2026-09-11)
priority: 1
depends_on: none
risk: low
plan: PLAN.md (Phase 6, deliverable 1)
approved: none
acceptance:
- Registry `environmentId` is optional.
- Dispatch spawns `reuse` when an entry has an environment id and unmanaged host-workspace (path plus existing `factory` branch) otherwise, recording the returned envId on the run.
- Preflight failure for a missing branch names the scaffolder.
validate:
- pnpm typecheck
- pnpm test

## BBF-0002 Protocol scaffolder
status: ready
priority: 2
depends_on: BBF-0001
risk: medium
plan: PLAN.md (Phase 6, deliverable 2)
approved: none
acceptance:
- The bundled template set ships in the package.
- One guarded action writes only missing plans/factory and plans/README.md files inside the configured checkout with compare-and-swap.
- The scaffold commit lands on `factory` and never overwrites existing protocol content.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint

## BBF-0003 Dedicated checkout provisioning
status: ready
priority: 2
depends_on: BBF-0002
risk: medium
plan: PLAN.md (Phase 6, deliverable 3)
approved: none
acceptance:
- The guided path creates a `<root>-factory` worktree via host terminal, creating the `factory` branch when missing.
- A `factory` branch already checked out elsewhere is detected and the flow offers the direct-checkout fallback.
- An advanced toggle registers the repository root itself as the checkout.
validate:
- pnpm test
- pnpm typecheck

## BBF-0004 Quickstart add-repository flow
status: ready
priority: 2
depends_on: BBF-0001, BBF-0003
risk: medium
plan: PLAN.md (Phase 6, deliverable 4)
approved: none
acceptance:
- The repository folder is chosen with the native folder picker.
- repositoryKey, checkoutPath, and mainRef are auto-derived.
- The project is resolved by source-path match or projects.create.
- An existing plans/factory is probed and the scaffold is offered.
- No field asks for environment, host, or project ids.
- Registration ends paused.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint

## BBF-0005 Registry-first discovery gating
status: ready
priority: 3
depends_on: BBF-0004
risk: low
plan: PLAN.md (Phase 6, deliverable 5)
approved: none
acceptance:
- The legacy merge-state.sh discovery only runs when the configured file exists.
- The legacy discovery is never shown to new installs.
validate:
- pnpm test
- pnpm typecheck

## BBF-0006 Release hygiene
status: ready
priority: 3
depends_on: none
risk: low
plan: PLAN.md (Phase 6, deliverable 6)
approved: none
acceptance:
- package.json loses `private` and gains license/repository.
- `files` is trimmed to the runtime set.
- The dist strategy for git-source installs is decided and implemented.
- engines ranges are verified.
- `bb plugin types --check` runs in CI.
- README is rewritten for fresh installs and PLUGIN_OVERVIEW.md exists.
validate:
- pnpm build
- bb plugin types --check .

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
