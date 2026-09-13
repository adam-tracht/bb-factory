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
status: done (orchestrated session 2026-09-12)
priority: 2
depends_on: BBF-0011
risk: low
plan: src/actions/repository.ts, src/protocol/reader.ts, src/ui/views/work.ts
approved: user direction 2026-09-12 (queued and orchestrated on instruction)
acceptance:
- The intended semantics are decided: either `approve-queue` may attach an `approved:` line to a `status: ready` entry that lacks one, or the reader/UI stops offering Approve on ready entries.
- The chosen path is implemented so the UI never offers an approval the action layer will reject.
validate:
- pnpm test
- pnpm typecheck
notes: Found during BBF-0011 review. `approve-queue` on a ready entry returns conflict "already ready with different authorization" (src/actions/repository.ts:90-95) before the blocked-by-question guard runs, while the reader still emits `missing-authorization` for ready entries without an `approved:` line, so the UI offers an Approve that always fails. Decision: `approve-queue` attaches the `approved:` line to a ready entry that lacks one (the only state the UI flags for approval), keeping the blocked-by-question guard; matching text stays idempotent already-applied and different text still conflicts.

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
- Superseded 2026-09-13 by the mobile layout pass: the badge is now `Blocked by Q<n>` only and the detail renders as a muted line under the row, so the id still never drops.
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

## BBF-0016 "All" repository switcher pill never shows active state
status: done (orchestrated session 2026-09-11)
priority: 3
depends_on: none
risk: low
plan: src/ui/shell.ts, src/ui/FactoryView.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- When the repositories landing route is showing, the "All" control renders the same active treatment a selected repository pill gets, and no repository pill renders active.
- In the >4-repository select fallback the "All" control also reflects the active repositories view.
- Selecting a repository pill still marks it active on non-landing routes.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: on the repositories landing the previously selected repo keeps the active pill because the switcher keys off selectedRepositoryKey, which stays set while route.section is "repositories". Pass a repositories-active signal from FactoryView (src/ui/shell.ts:121-149 segmented variant and line 106 select variant).

## BBF-0017 Selecting a repository leaves the route on the landing view
status: done (orchestrated session 2026-09-11)
priority: 2
depends_on: none
risk: low
plan: src/ui/FactoryView.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- Clicking a repository card on the landing view selects it AND navigates to its overview, so the body never shows the repositories list under the highlighted Overview tab.
- The same applies when selection changes while on any repositories-scoped route.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: RepositoryLandingView onSelect calls onRepositorySelect only (src/ui/FactoryView.ts:573), which sets the override but never navigates, so route.section stays "repositories" and the landing re-renders while the tab scope maps it to the Overview highlight (src/ui/FactoryView.ts:316-318). Wire the landing onSelect through the existing onOpenRepository path (select + navigate, src/ui/FactoryView.ts:481).

## BBF-0018 Run detail cannot open the worker thread
status: done (orchestrated session 2026-09-11)
priority: 3
depends_on: none
risk: low
plan: src/ui/views/runs.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- RunDetailView renders an "Open thread" control that calls ctx.onOpenThread(run.workerThreadId) whenever a workerThreadId exists, placed in the run header next to the status/id cluster.
- Attempt rows link their own workerThreadId the same way when present.
- Runs with no worker thread show no dead control.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: run list rows already offer a Thread button (src/ui/views/runs.ts:93-101) but RunDetailView only surfaces the thread id as copyable text inside the collapsed Technical details disclosure (src/ui/views/runs.ts:227,306). ctx.onOpenThread already navigates to the bb thread.

## BBF-0019 Settings Repository card is all read-only fields
status: done (orchestrated session 2026-09-11)
priority: 3
depends_on: none
risk: low
plan: src/ui/views/settings.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- The Repository card shows the mutable controls (the per-repo dispatch toggle) and host status inline, and moves the read-only identity fields (key, root, checkout, branch, main ref, host id, project, environment) into a collapsed disclosure labelled so it reads as details, not settings.
- No field that factory_update_repository cannot mutate remains presented as an editable setting.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: the card is a grid of CopyText fields; the only mutable input is dispatchPaused (updateRepositoryInputSchema accepts repositoryKey + dispatchPaused only, src/contracts.ts:1276-1279). Identity fields are registration-time config, so they collapse into a Disclosure like the run detail's Technical details pattern (src/ui/views/runs.ts:297-307).

## BBF-0020 Repository selection is dead and the panel thrashes
status: done (orchestrated session 2026-09-11)
priority: 1
depends_on: none
risk: medium
plan: src/ui/FactoryView.ts, src/ui/shell.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- Repo pill and select clicks made while the landing is rendered (repositories, not-found, add-repository routes) select AND navigate to overview; clicks on repo-scoped tabs keep the current tab.
- A selection change no longer unmounts the switcher: the previous repositories projection stays rendered while the reload runs, and repositorySelectionLoading drives a subtle busy state instead of the pills vanishing.
- The repository override is keyed to the configured repositoryKey only, so registry writes (dispatch toggle, add repository) no longer snap the selection back to the default repo.
- Realtime invalidations that name a different repositoryKey do not reload the selected repository's projections; settings/host-scoped events still do.
validate:
- pnpm test
- pnpm typecheck
notes: Review of cbcdfe4 found the live-reported glitch: on the landing the Overview tab is highlighted by scopeSection, repo pills call onRepositorySelect with no navigation, and repositoriesActive guarantees they can never appear active, so every click fires a full load() that resets data.repositories to loading, unmounts the whole pill strip, and repaints the identical landing. Secondary: load() empties the switcher on every reload; onRealtime reloads on every factory event including other repos' (invalidationEventSchema carries repositoryKey, src/contracts.ts:1003); repositoryOverride is keyed to settingsIdentity which includes the raw registry JSON, so any registry write clears it and snaps back to the default repo (src/ui/FactoryView.ts:125-129,189-197).

## BBF-0021 Repo chrome stays rendered over the repositories landing
status: done (orchestrated session 2026-09-11)
priority: 2
depends_on: BBF-0020
risk: low
plan: src/ui/shell.ts
approved: user direction 2026-09-11 (filed and orchestrated on instruction)
acceptance:
- When the repositories landing is the rendered content, the branch/commit chip, dispatch chip, running/idle badge, Pause/Resume, Run now (and its confirm dialog), and the section tab bar do not render.
- The Factory title, repository switcher, refreshed indicator, chip legend, and connection/malformed banners still render.
- Repo-scoped routes keep all chrome; the add-repository route is excluded from repositoriesActive, so the wizard keeps the chrome as before.
- Regression coverage asserts the tablist, dispatch chip, and branch/commit chip absent on the landing and present on a repo view.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
notes: Reported by live QA after c29f3cc: clicking "All" left the previous repo's sub-header (chips, run controls, tab bar) rendered above the Repositories landing. Fix gates all repo-scoped chrome in FactoryShell on the existing repositoriesActive prop (src/ui/FactoryView.ts:671), which is true exactly when the landing is the content (repositories route, no repos, or no selected entry).

## BBF-0022 Plugin SDK pin drifted from host (0.4.47 vs 0.4.84)
status: done (orchestrated session 2026-09-12)
priority: 3
depends_on: none
risk: low
plan: package.json (@get-bb/plugin-sdk devDependency)
approved: dependency repin (user direction 2026-09-12)
acceptance:
- `bb plugin types --check .` passes again (pin matches the running host SDK).
validate:
- bb plugin types --check .
notes: The host SDK moved 0.4.47 to 0.4.84 between 2026-09-11 and 2026-09-12. `bb plugin types` repinned the devDependency; `pnpm install` installed it (local dev uses pnpm, never npm). The 0.4.84 surface added `connectMachineId` on hosts.get (HostInfo now binds to the hosts.list element in src/services/live-health.ts) and three nullable environment fields on the thread list type (test fixture updated).

## BBF-0023 Provider preference accepts any reported provider
status: done (orchestrated session 2026-09-12)
priority: 3
depends_on: none
risk: medium
plan: src/contracts.ts (providerPreferenceSchema, providerStatusSchema), src/dispatch/preflight.ts, src/dispatch/types.ts, src/settings.ts, src/ui/views/settings.ts, src/ui/FactoryView.ts, src/services/live-health.ts
approved: user direction 2026-09-12 (filed and orchestrated on instruction); contract seam widening reviewed in-thread before filing
acceptance:
- `providerPreference` accepts `alternate` or any provider-id-shaped string end to end (factorySettingsSchema, the update-settings patch, the settings UI); all previously stored values still parse.
- The Settings provider dropdown lists every provider the host reports, labeled with availability, keeps `alternate` first, and still renders a stored id the host no longer reports.
- Dispatch can start a run on any usable provider (pi, acp-*, ...): usable means the host reports it `available` with a model, it is not marked limited, and, when the host reports permission modes, it supports `full` (spawn passes `permissionMode: "full"`).
- `alternate` rotates deterministically across all usable providers, and a pinned-but-unusable provider falls back to another usable provider with a recorded reason; with only codex and claude-code usable the behavior matches today.
- The plugin settings descriptor no longer limits the value to a static option list.
- UI copy no longer describes rotation as codex and claude-code specifically.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Wire contract v1.2 is frozen; this widens providerPreferenceSchema from a fixed enum to `alternate` | providerIdSchema (backward compatible: every stored value still parses) and may add an optional capability field to providerStatusSchema. User direction: every provider available in a regular session should be selectable. Host catalog on 2026-09-12 reports codex, claude-code, pi, acp-cursor, acp-opencode, acp-devin, acp-prime-agent.

## BBF-0024 Multi-id question headings fail the whole protocol read
status: done (interactive session 2026-09-12)
priority: 3
depends_on: none
risk: low
plan: src/protocol/markdown.ts, templates/questions.md, templates/foreman.md, tests/protocol-reader.test.ts
approved: user direction 2026-09-12 (reported live on diggs-data-platform and monorepo, diagnosed and fixed in-thread)
acceptance:
- A question heading carrying more than one dashboard id fails `parseQuestions` with malformed-protocol and a message naming the expected `Q<n> <YYYY-MM-DD> <blocking|assumption> <dashboard-id>` shape and the single-id rule.
- `templates/questions.md` documents the one-token dashboard id and the multi-entry pattern: lead id in the heading, each other gated entry carries its own `blocked-by: Q<n>` reference in queue.md, the rest named in `context:`.
- `templates/foreman.md` states the same rule in the question-authoring checklist.
- `templates/MANIFEST.json` digests match the edited templates.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- git diff --check
notes: Reported live: `Q14 2026-09-10 blocking DATA-0064 and DATA-0009.01` in diggs-data-platform and `Q15 2026-09-12 blocking MON-0080.06 and MON-0080.08 through MON-0080.13` in monorepo both threw malformed-protocol and degraded the whole Work tab. Data fixes shipped in diggs-data-platform-factory 8da79bc (Q14 now names DATA-0064, the entry it gates via dashboardId; DATA-0009.01 stays gated by its own `blocked-by: Q14` field) and monorepo-factory 1b21e2e (Q15 now names MON-0080, matching Q14's parent-row convention). Wire contract v1.2 untouched: dashboardId remains a single string; only docs, the error message, and a test changed.

## BBF-0025 Approve composer drafts scope and explains the ask
status: done (orchestrated session 2026-09-12)
priority: 3
depends_on: none
risk: medium
plan: src/contracts.ts (recommend-approval action + outcome), src/actions/interactions.ts, src/ui/views/work.ts, src/ui/FactoryView.ts
approved: user direction 2026-09-12 (design approved in-thread); contract seam addition reviewed in-thread: new action kind recommend-approval, additive and backward compatible
acceptance:
- The Approve composer explains what approval covers before the textarea: the entry's risk and the gated-action list (merges, deploys, migrations, dependency changes, secrets, destructive ops, customer-facing changes), with plain-language placeholder copy.
- A "Draft with agent" button opens the provider/model picker and dispatches a new recommend-approval action that spawns an advisory thread; the prompt carries the entry's title, plan, risk, acceptance, and notes, and the thread drafts a recommended approved: line without writing to the repository. The outcome opens the thread, matching recommend-question.
- A "Routine scope only" button writes a canned conservative approved line through the existing approve-queue action, behind the same confirm dialog.
- recommend-approval joins actionKindSchema, bbInteractionActionSchema, its outcome schema, and the outcome union; idempotent intent handling and guarded/reconcile paths match recommend-question.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: User report: the Approve form asked for free-text approval scope with no explanation even though the entry already carries plan, risk, and acceptance. Mirrors the questions flow's Ask-an-agent advisory spawn. Wire contract v1.2: additive action kind and outcome only; no existing member changed.

## BBF-0026 Run detail header declutter and visible thread button
status: done (interactive session 2026-09-13)
priority: 4
depends_on: none
risk: low
plan: src/ui/views/runs.ts, tests/ui-runs.test.ts
approved: user direction 2026-09-13 (reported live via run-detail screenshot, fixed in-thread)
acceptance:
- The RunDetailView header no longer renders the run id; the id remains reachable inside the Technical details disclosure.
- The Open thread control renders as a bordered button (secondary variant, default size, pinned to the header's right edge) instead of a ghost text affordance.
- Regression coverage asserts the run id renders only inside a details element and the Open thread button carries the bordered styling.
validate:
- pnpm test
- pnpm typecheck
notes: Reported live: the run detail header mixed a long copyable run id, metadata, and a nearly invisible ghost "Open thread" link, so the page's primary action read as metadata text. Attempt-row "Thread" buttons stay ghost by design; they are row-level affordances inside the collapsible Attempts section.

## BBF-0027 Remaining labels keep pill radii on phone widths
status: done (interactive session 2026-09-13)
priority: 4
depends_on: none
risk: low
plan: src/ui/primitives.ts, src/ui/shell.ts, src/ui/views/questions.ts, tests/ui-shell.test.ts
approved: user direction 2026-09-13 (labels need smaller border radii on mobile, fixed in-thread)
acceptance:
- No text-bearing chip or label renders `rounded-full`: StateChip, section counts, tab count badges, and the answered/recorded chips in questions.ts all use `rounded-md`, matching the Badge treatment from the phone-width pass (6025521).
- Geometric circles keep `rounded-full`: StatusDot and the help "?" icon button.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: The user flagged label radii on mobile after the phone-width pass had already converted Badge to rounded-md globally; this finishes the job for every remaining text label. Applied globally rather than behind an sm: breakpoint so desktop stays consistent with the already-square badges. Superseded same-day by BBF-0028: rounded-md still read as round on small screens, so labels went to bare `rounded` (the existing small-chip radius).

## BBF-0028 Labels still read as round on small screens
status: done (interactive session 2026-09-13)
priority: 4
depends_on: none
risk: low
plan: src/ui/primitives.ts, src/ui/shell.ts, src/ui/views/questions.ts, tests/ui-shell.test.ts
approved: user direction 2026-09-13 (radii still need to be smaller, reported after BBF-0027)
acceptance:
- Every text-bearing label/chip renders bare `rounded` (the same radius the mono id chips already use): Badge, StateChip, section counts, tab count badges, answered/recorded chips.
- Geometric circles keep `rounded-full`: StatusDot and the help "?" icon button; controls and cards keep their existing radii (buttons rounded-md, cards rounded-lg).
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Follow-up to BBF-0027, same user direction. rounded-md (6px) still read as "trying to be round" on small screens and tall labels; bare `rounded` (4px) is the repo's existing small-chip radius and reads as a softened box rather than a pill.
