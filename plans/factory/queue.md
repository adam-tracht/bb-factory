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
status: done (orchestrated session 2026-09-11)
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
status: done (orchestrated session 2026-09-11)
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
status: done (orchestrated session 2026-09-11)
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
status: done (orchestrated session 2026-09-11)
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
status: done (orchestrated session 2026-09-11)
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

## BBF-0009 Question deep links 404 on encoded hash
status: done (orchestrated session 2026-09-11)
priority: 2
depends_on: none
risk: low
plan: src/ui/routes.ts, src/ui/FactoryView.ts, src/ui/views/work.ts
approved: none
acceptance:
- Clicking a gating-question chip or "Answer Qn" on a Work row opens the Questions tab focused on that question card.
- No `onOpenSection(..., anchor)` caller can produce "No factory view matched": anchors survive navigate.toPluginPanel without the `#` being percent-encoded into the section segment.
- Round-trip coverage for the anchor encoding plus a UI test that exercises a question-chip click.
validate:
- pnpm test
- pnpm typecheck
notes: Root cause: `sectionPath` builds `questions#question-Q3`, but `toPluginPanel` percent-encodes the subPath, so the plugin receives `questions%23question-Q3` and `parseFactoryRoute` (which only splits a literal `#`) matches no section. Reported live on diggs-data-platform DATA-0008.03's Q3 chip. Every anchor caller is affected: work.ts question chips and Answer CTAs, questions.ts gated-item links, runs.ts work links.

## BBF-0010 Refresh glyph renders rotated
status: done (orchestrated session 2026-09-11)
priority: 4
depends_on: none
risk: low
plan: src/ui/shell.ts
approved: none
acceptance:
- The "refreshed Nm ago" indicator shows a correctly oriented refresh icon instead of the raw U+21BB text glyph.
validate:
- pnpm typecheck
- pnpm lint
notes: src/ui/shell.ts appends the literal character `↻`, which renders misrotated in the app font (user screenshot). Replace with a real icon (the shell's existing icon set or an inline SVG) at the correct orientation.

## BBF-0011 Question-gated ready entries show "Ready" and Approve
status: done (orchestrated session 2026-09-11)
priority: 1
depends_on: none
risk: low
plan: src/ui/views/work.ts, src/protocol/reader.ts
approved: none
acceptance:
- A `status: ready` entry with unresolved `blocked-by:` questions no longer displays "Ready" as its state and no longer offers an enabled Approve CTA that the action layer will reject; the row surfaces the question gating and the CTA answers the question.
- Entries whose blocked-by questions are all answered keep Ready/Approve behavior.
- Regression coverage for `status: ready` combined with `blocked-by` fields.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: DATA-0009.01 on diggs-data-platform shows "Ready" plus Approve while its expanded detail lists "Blocked by: Q13 and Q17"; approval is then rejected by the blocked-by-question guard (src/actions/repository.ts). The WorkRow CTA prefers Approve over Answer whenever approval is missing, and the status badge renders the raw parsed status instead of the question-gated state.

## BBF-0012 Approve on an already-ready entry is a dead end
status: draft
priority: 2
depends_on: BBF-0011
risk: low
plan: src/actions/repository.ts, src/protocol/reader.ts, src/ui/views/work.ts
approved: none
acceptance:
- The intended semantics are decided: either `approve-queue` may attach an `approved:` line to a `status: ready` entry that lacks one, or the reader/UI stops offering Approve on ready entries.
- The chosen path is implemented so the UI never offers an approval the action layer will reject.
validate:
- pnpm test
- pnpm typecheck
notes: Found during BBF-0011 review. `approve-queue` on a ready entry returns conflict "already ready with different authorization" (src/actions/repository.ts:90-95) before the blocked-by-question guard runs, while the reader still emits `missing-authorization` for ready entries without an `approved:` line, so the UI offers an Approve that always fails.

## BBF-0013 First-class draft queue status
status: done (orchestrated session 2026-09-11)
priority: 3
depends_on: none
risk: low
plan: src/protocol/markdown.ts, src/ui/views/work.ts
approved: none
acceptance:
- `status: draft` parses to its own kind instead of falling through to unknown.
- Draft entries render a neutral Draft badge in a collapsed Drafts group, are never eligible, and get no Approve or Answer CTAs; malformed statuses keep the loud Unrecognized treatment.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: a draft entry rendered as an "Unrecognized status" danger badge inside the Blocked group. The shipped template and this queue's format header now list `draft` in the status set.

## BBF-0014 Blocked-by badge drops the question id when a detail exists
status: done (orchestrated session 2026-09-11)
priority: 3
depends_on: none
risk: low
plan: src/ui/primitives.ts
approved: none
acceptance:
- A `blocked-by` status with a detail renders the question id plus the detail (e.g. "Blocked by Q6: property id now known"), never the detail alone.
- The row still offers a way to reach the referenced question.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live on diggs-data-platform DATA-0007.04: `blocked-by: Q6 (property id now known; ...)` rendered as "Blocked: (property id now known; ...)", which reads like an error and hides the question reference. queueStatusLabel at src/ui/primitives.ts:500 prefers detail over questionId.

## BBF-0015 Stale question gates strand blocked entries
status: done (orchestrated session 2026-09-11)
priority: 2
depends_on: none
risk: low
plan: src/protocol/reader.ts, src/contracts.ts, src/ui/views/work.ts, src/ui/attention.ts, src/ui/primitives.ts, templates/foreman.md
approved: none
acceptance:
- A `blocked-by` status whose question is answered or missing produces a `stale-question-gate` eligibility reason and a `staleBlockingQuestionIds` field instead of silently clearing the gate.
- Stale-gated entries land in Needs you with a Review Q<n> CTA that opens the referenced question, and the detail keeps the reference reachable.
- The attention model surfaces stale-gated items as an action item on the Work tab.
- The shipped foreman protocol tells foremen to re-file remaining human work as a new question instead of leaving an entry gated on a question they just answered.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live on diggs-data-platform DATA-0007.04: Q6 was half-answered by observation (property resolved, BigQuery pipe still human), so the protocol counted the gate resolved while human work remained, and the entry sat in Blocked with no action. Data fix landed in diggs-data-platform-factory acc6097 (Q18 re-filed, entry re-pointed).
