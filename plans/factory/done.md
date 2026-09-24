# Completed factory tasks

Entries moved here verbatim from `plans/factory/queue.md` when their status became `done (run <timestamp>)`. The foreman never reads this file; the plugin reads it so completed work stays visible and `depends_on` references keep resolving. Never edit or delete entries here.

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

## BBF-0029 Run detail has no way back to the Runs list
status: done (interactive session 2026-09-14)
priority: 1
depends_on: none
risk: low
plan: src/ui/views/runs.ts, src/ui/FactoryView.ts, src/ui/routes.ts, tests/ui-runs.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- Run detail renders a "Runs" back control at the top left of the header that routes to the repository's Runs tab, and the Runs tab remains highlighted while a run detail is open.
- Browser back from run detail returns to the Runs list, not to a prior repository.
- The back control meets a 44px tap target on phone width.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase A (navigation and shell). User-reported. The separate Run notes contract change remains excluded and uncommitted pending its own approval. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0030 Phone header is crowded and the tab strip hides overflow
status: done (interactive session 2026-09-14)
priority: 1
depends_on: none
risk: low
plan: src/ui/shell.ts, src/ui/FactoryView.ts, tests/ui-shell.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- On phone width the repository status row drops the `@sha` chip and its copy button (the sha stays visible on desktop and inside Settings or Overview technical details) so "repo name, Dispatch on, Idle" fits on one line without wrapping.
- The scrollable tab strip shows an overflow affordance (a fade edge on the clipped side, or the active tab scrolled into view) so "Settings" is never silently cut off at 390px.
- Small controls reach a 24px minimum hit area on phone: "refreshed just now", "Add repository +", the legend "?", and file links.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase A. User-reported (crowding) plus audit items 10 and 11. Keep the header grouping from the 2026-09-13 phone-width pass (commit 6025521); this only removes the id chip and grows hit areas. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0031 Add-repository wizard keeps stale repository chrome
status: done (interactive session 2026-09-14)
priority: 3
depends_on: BBF-0030
risk: low
plan: src/ui/shell.ts, src/ui/FactoryView.ts, src/ui/views/repositories.ts, tests/ui.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- On `/repositories/new` no repository pill renders pressed, the tab strip and Pause/Run now controls are hidden, and the "All" control is not shown active either.
- "Back" returns to the view the wizard was opened from (the landing list or the repository tab), not always the repository list.
- The folder-picker copy reads "Choose the folder on this machine (MacBook Pro)" style wording rather than "The folder picker opens on MacBook Pro."
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase A. Audit items 16 and 17. Reuse the repositories-active signal added in BBF-0016 and the chrome suppression from BBF-0021. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0032 "All" view has no aggregate Work, Questions, or Runs tabs
status: done (interactive session 2026-09-14)
priority: 1
depends_on: BBF-0030
risk: medium
plan: src/ui/FactoryView.ts, src/ui/routes.ts, src/ui/shell.ts, src/ui/views/repositories.ts, src/ui/views/work.ts, src/ui/views/questions.ts, src/ui/views/runs.ts, src/ui/attention.ts, tests/ui.test.ts, tests/ui-work.test.ts, tests/ui-runs.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- With "All" selected the tab strip shows Overview, Work, Questions, and Runs; each tab renders the union of every registered repository's entries, grouped by repository with the repository name as the group heading, using the existing per-repository read projections (no new RPC or storage seam).
- Tab badges under "All" sum the per-repository attention counts; the repository cards on the aggregate Overview show a labeled count ("2 need attention") instead of a bare number, and the tooltip grammar is fixed.
- Actions dispatched from an aggregate row target the row's own repository (`ViewContext.onAction` receives that repository key).
- Opening the Factory sidebar item lands on the aggregate Overview, and the last-selected repository is one tap away via its pill.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase B (aggregate view). User-reported: "which is the whole point of that view." Audit items 7 and 18. Composed in the view layer from existing per-repository projections; the v1.2 wire contract is unchanged. Aggregate compliance and quality reviews passed, including partial settlement and collision-safe detail identity. Final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0033 Questions and Overview text overflows or hard-truncates
status: done (interactive session 2026-09-14)
priority: 2
depends_on: none
risk: low
plan: src/ui/views/questions.ts, src/ui/views/overview.ts, src/ui/primitives.ts, tests/ui-questions.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- Question rows never exceed the column width at 390px: the flex parent of the truncating span carries `min-w-0`, and the Answered or Recorded chip stays visible on the row.
- Question titles are no longer cut at ~80 characters; they wrap to two lines (line clamp) on any width and the full text is available when the row is expanded.
- The Overview "Needs attention" body and its task-id list wrap or clamp on phone width, and expanding the item reveals the full text.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase C (row correctness). Audit items 1, 2, and 12. Item 1 was a live layout bug on phones. Implementation and both Sol reviews passed; responsive visual acceptance passed at 390px, 360px, 320px, and 1440px in light and dark themes with no page-level or element-level overflow. Final validation passed with 437 tests, typecheck, lint, build, SDK freshness, and whitespace. Committed in 4217a73.

## BBF-0034 Work rows show contradictory chips and raw provenance
status: done (interactive session 2026-09-14)
priority: 2
depends_on: none
risk: low
plan: src/ui/views/work.ts, src/ui/primitives.ts, tests/ui-work.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- An entry listed under the Blocked group never renders a green "Ready" chip; the chip reflects the effective eligibility (blocked-by, stale gate, or waiting on approval).
- Expanding an empty group renders a muted empty-state line ("Nothing needs you right now") instead of a blank area.
- Done rows render provenance in one format: "Done <relative time> via run" or "via thread" with the id as a mono chip, whether the source is a run timestamp, a run date, a thread id, or a `wfr_` id.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase C. Audit items 3, 4, and 5. The effective eligibility now drives the row label at its source, with muted empty groups and consistent provenance ids. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0035 Runs history rows misalign task chips on phone and mix status casing
status: done (interactive session 2026-09-14)
priority: 2
depends_on: none
risk: low
plan: src/ui/views/runs.ts, src/ui/primitives.ts, tests/ui-runs.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- On phone width a run row lays out as two lines: "time ago, status, provider, duration" on the first and the task-id chips as a wrapping inline group on the second, with even chip spacing; the chevron stays vertically centered on the row.
- Run status labels use one casing everywhere ("Blocked", "No-op", "Success", "Failed safe"), via the existing state label helper.
- A run with no task ids renders a muted "No tasks" instead of a bare "none".
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase C. User-reported (screenshot) plus audit item 6. The phone history layout now separates metadata from wrapping task chips, with consistent status casing and a No tasks label. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73. The separate Run notes contract change remains excluded.

## BBF-0036 Chip contrast fails AA and the legend and refresh cues are incomplete
status: done (interactive session 2026-09-14)
priority: 3
depends_on: none
risk: low
plan: src/ui/primitives.ts, src/ui/shell.ts, tests/ui-shell.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- Green and amber chip text reaches at least 4.5:1 on white and on the dark theme (darker text on a tinted background rather than colored text on white).
- The "?" legend explains every chip family that appears in the shell and rows: status colors, "current", host ids, provider chips, and mono id chips.
- When a background refresh changes the header count or health state, the header shows a brief "updated" cue (the existing "refreshed just now" text pulses or restates the time) so the change is not silent.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase C. Audit items 8, 9, and 19. Measured fixed-pair contrast ratios are 6.492 and 6.153, above the 4.5:1 AA floor. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0037 Settings gives no save feedback and mislabels the dispatch toggle
status: done (interactive session 2026-09-14)
priority: 2
depends_on: none
risk: low
plan: src/ui/views/settings.ts, src/ui/views/overview.ts, src/ui/primitives.ts, tests/ui-settings.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- Every settings field shows a saving and saved state (inline "Saved" that fades, or a footer with Save and Cancel when edits are pending); the user can always tell whether an edit persisted.
- "Dispatch active for this repo" renders as a labeled toggle or button ("Pause dispatch") rather than a status chip.
- Helper copy no longer leaks storage details ("Stored as seconds"), and no validation message ends in a double period.
- The schedule summary reads as a sentence ("Every 10 minutes between 01:00 and 05:59, every day") on both Overview and Settings for `*/10 1-5 * * *` style cron values.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase D (settings). Audit items 13, 14, and 15. Settings mutations continue through the existing settings RPCs. Implementation and both Sol reviews passed; final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Background refresh preserves drafts and Saved state, and cron descriptions are truthful. Committed in 4217a73.

## BBF-0038 Info-dense tabs need progressive disclosure
status: done (interactive session 2026-09-14)
priority: 2
depends_on: BBF-0033, BBF-0034, BBF-0035
risk: medium
plan: src/ui/primitives.ts, src/ui/views/overview.ts, src/ui/views/work.ts, src/ui/views/questions.ts, src/ui/views/runs.ts, tests/ui.test.ts, tests/ui-runs.test.ts
approved: user direction 2026-09-13 ("Do it")
acceptance:
- `Section` gains a collapsible variant with a persisted open state per section key (session storage), and Overview, Work, Questions, and run detail use it for their secondary sections.
- Defaults: on phone width only the first section of each tab is open (Needs attention on Overview, Needs you on Work, Open on Questions, Summary on run detail); Technical details, Attempts, Done, and Answered start collapsed on every width.
- Collapsed sections still show their count badge so nothing is hidden without a signal.
- Expanded rows in Work and Questions keep their current content; this task only wraps sections, it does not move fields.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Phase E (disclosure). User-reported. Depends on the Phase C row fixes so the collapsed defaults are set against final row heights. The implementation uses native details elements, repository-scoped session preferences, phone-first defaults, and bounded deep-link reveal retries. Both Sol reviews passed, including focus lifecycle, interactive summary descendants, and regrouping behavior. Final validation passed with 437 tests, typecheck, lint, build, SDK freshness, whitespace, and responsive visual acceptance. Committed in 4217a73.

## BBF-0039 Repository display names
status: done (interactive session 2026-09-14)
priority: 2
depends_on: BBF-0038
risk: medium
plan: /Users/adamtracht/.claude/plans/eager-foraging-rabbit.md
approved: direct human request and approved plan authorize this customer-facing change
acceptance:
- An optional presentation-only displayName is stored on each registry entry, never inside RepositoryConfiguration; repositoryKey remains the sole operational identity.
- Existing add and update repository mutations persist trimmed displayName values, enforce the 64-character limit, allow duplicate display names, and clear the alias without dropping unrelated registry fields.
- Add repository and Settings expose the display name, while switcher, landing, aggregate headings, repository-specific empty states, and confirmation copy use the resolved display label; routes, DOM ids, storage keys, action payloads, RPC inputs, and technical details retain repositoryKey.
- Focused regression coverage protects the contract, mutation semantics, UI labels, and raw-key identity boundaries; README and control-surface documentation describe the distinction.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Direct human authorization is recorded above. Implemented without a new RPC or migration. Compliance corrections and focused and full automated validation pass. Code-quality review and live visual validation are explicitly deferred by the user. No commit or push per the request.

## BBF-0040 Overview attention duplication and work-queue row layout
status: done (interactive session 2026-09-14)
priority: 2
depends_on: none
risk: low
plan: src/ui/primitives.ts, src/ui/views/overview.ts, src/ui/views/aggregate.ts, tests/ui-overview.test.ts, tests/ui.test.ts
approved: user direction 2026-09-14 ("let's do it")
acceptance:
- Needs attention rows render only the item title in the disclosure summary; the detail line mounts only while the row is expanded, so the detail never displays twice.
- On desktop widths, each aggregate Work queue repository row carries its status chips and the Open work action inline in the section header; on phone widths they stay inside the collapsible body.
- Repository subgroup headings across the aggregate overview render at normal weight while category titles keep the semibold treatment.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Direct human request with overview screenshots. Single-repo NeedsAttention and aggregate OverviewAttentionRow share the same title-only summary fix. Work queue repository rows are non-collapsible on desktop (no body to disclose); unresolved loading and error subgroups keep the collapsible treatment. Section gained an optional titleClassName used only by overviewRepositorySection; every other consumer keeps the semibold default. BBF-0039's uncommitted display-name work was excluded from this task's commit and remains in the working tree per the earlier request.

## BBF-0041 Overview attention rows stack awkwardly on phone
status: done (interactive session 2026-09-14)
priority: 2
depends_on: BBF-0040
risk: low
plan: src/ui/primitives.ts, src/ui/views/overview.ts, src/ui/views/aggregate.ts, tests/ui-overview.test.ts
approved: user direction 2026-09-14 (follow-up review of BBF-0040)
acceptance:
- Collapsed Needs attention rows keep the severity dot, title, and action on one line; the action never takes a dedicated full-width row on phone widths.
- An expanded row's detail line indents to sit under the title text, past the disclosure caret, instead of starting at the row's left edge.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Follow-up from live review of BBF-0040 on the aggregate overview. The basis-full action wrapper forced a second line per item; it now shares the title line with ml-auto fallback for extreme widths. Disclosure's body gains pl-3 so expanded content aligns under the summary text at every call site. BBF-0039's uncommitted display-name work remains excluded from commits.

## BBF-0042 Attention row severity dot drifts off the title line when expanded
status: done (interactive session 2026-09-14)
priority: 2
depends_on: BBF-0041
risk: low
plan: src/ui/views/overview.ts, src/ui/views/aggregate.ts, docs/control-surface.md
approved: user direction 2026-09-14 (follow-up review of BBF-0041)
acceptance:
- The severity dot stays vertically aligned with the disclosure caret and title line whether the row is collapsed or expanded, at every viewport width.
- The row action stays centered on the title line when the row is collapsed and remains pinned to it when expanded.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: Follow-up from live review. Above the sm breakpoint the row switched to items-center and dropped the dot's mt-1.5 offset, so an expanded (taller) row centered the dot on the whole block instead of the title line. The row now anchors every item to the first line: items-start at all widths, the dot keeps mt-1.5, and the action sits in a one-line-tall lane that centers it on the title line.

## BBF-0043 Pick provider, model, and thinking on manual Run now
status: done (run 2026-09-15T04:39Z)
priority: 2
depends_on: none
risk: medium
plan: src/contracts.ts (run-now action variant, line ~719), src/dispatch/start.ts, src/dispatch/types.ts, src/actions/interactions.ts, src/ui/shell.ts, src/ui/FactoryView.ts, src/ui/providerPicker.ts, tests/dispatch.test.ts, tests/ui-shell.test.ts, tests/ui.test.ts
approved: user direction 2026-09-15 (reviewed as draft, marked ready, run directed in-thread)
acceptance:
- The run-now confirm dialog embeds the shared ProviderModelPicker seeded from live provider status via seedPickerValue (configured preference first), so a manual run starts on a chosen provider, model, and thinking level; on hosts that do not bind experimental_ProviderModelPicker the dialog keeps today's plain confirm behavior.
- The run-now action accepts optional providerId, model, reasoningLevel, and serviceTier (the PickerValue shape recommend-approval already carries); scheduled and retry-driven runs omit them and behave exactly as today.
- An explicitly chosen provider that fails the usability check returns provider-unavailable naming that provider rather than silently substituting another; no override keeps the existing preference/rotation path untouched.
- The thread spawn marks the chosen triple explicit via executionInputSources (matching the recommend-* spawns at src/actions/interactions.ts:437-442) so the server does not re-derive project defaults, and the dispatch attempt row records the effective providerId, model, and reasoningLevel.
- Regression coverage for override accepted, unusable override rejected, and no-override parity with today.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Widens the strict `{ kind: "run-now" }` variant (src/contracts.ts:719) with optional fields; additive and wire-compatible (old senders omit, new readers default), but it is a v1.2 contract touch and returns to review before landing per the interface-change rule. The idempotency key shape, action kind set, and storage CHECK lists are unchanged. UI reuse: work.ts:299-336 shows the ConfirmDialog + ProviderModelPicker + routing pattern; the run-now dialog already computes provider context copy at src/ui/FactoryView.ts:766-775 which the picker supersedes.

## BBF-0044 Default model and thinking per provider
status: done (run 2026-09-15T04:39Z)
priority: 2
depends_on: none
risk: medium
plan: src/contracts.ts (factorySettingsSchema ~line 173, factorySettingsPatchSchema ~line 1295), src/settings.ts (providerPreference descriptor), src/dispatch/preflight.ts (selectProvider), src/ui/views/settings.ts (provider FormRow ~line 623), tests/settings-mutations.test.ts, tests/dispatch.test.ts, tests/ui-settings.test.ts
approved: user direction 2026-09-15 (reviewed as draft, marked ready, run directed in-thread)
acceptance:
- Settings persists an optional per-provider default `{ model, reasoningLevel }` keyed by provider id; model names are not portable across providers, so the store is a keyed map, not one global pair. Providers without an entry keep the host-reported default.
- When providerPreference pins a specific provider, the Settings provider section exposes a model and thinking control for that provider (reusing ProviderModelPicker's host catalog via routing where supported) and saves through the existing factory_update_settings patch path with the established Saving/Saved feedback.
- selectProvider applies the configured default to the selected provider after the usability check, so a configured model never resurrects a provider the host reports unusable; the selection reason notes the override and the dispatch attempt persists the effective model and reasoning level.
- Stored defaults for providers the host no longer reports parse cleanly and render tolerantly (matching the `(not reported)` option precedent).
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Additive optional keys on factorySettingsSchema and factorySettingsPatchSchema plus a settings descriptor; no action-schema or key-shape change. Today model and reasoning come straight from ProviderStatus (host-reported default model and its defaultReasoningEffort, src/services/live-health.ts:65-74,109); this adds a configured override layer at selection time. "Thinking" maps to reasoningLevel (low|medium|high|xhigh|max); validate a configured level is one the chosen model supports if the catalog reports that, else pass through.

## BBF-0045 User-configured alternate rotation of up to 5 providers
status: done (run 2026-09-15T04:39Z)
priority: 3
depends_on: BBF-0044
risk: low
plan: src/contracts.ts (providerRotation on factorySettingsSchema and factorySettingsPatchSchema), src/settings.ts, src/dispatch/preflight.ts (selectProvider alternate branch, lines 63-73), src/ui/views/settings.ts (provider FormRow), tests/dispatch.test.ts, tests/ui-settings.test.ts, tests/settings-mutations.test.ts
approved: user direction 2026-09-15 (reviewed as draft, marked ready, run directed in-thread)
acceptance:
- Settings persists an optional ordered providerRotation list of 2 to 5 unique provider ids; null or absent clears it. The Settings UI offers the rotation editor only when providerPreference is alternate, lets the user add, remove, and reorder providers from the reported catalog, and tolerantly renders stored ids the host no longer reports.
- With providerPreference alternate and a rotation set, selectProvider advances through the configured list order from lastStartProvider and picks the first usable member; with no list the catalog-wide rotation behaves exactly as today.
- If every rotation member is unusable, dispatch falls back to any usable provider outside the list with a recorded reason, matching the pinned-provider fallback contract.
- Rotation members with a BBF-0044 per-provider default use their configured model and thinking when selected.
- Regression coverage for list ordering, skipping unusable members, all-unusable fallback, and unset-list parity.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Additive optional settings key only; selectProvider's signature gains the list internally, wire key shape untouched. depends_on BBF-0044 because both extend the settings provider section and selectProvider in the same places; land sequentially to avoid churn. Rotation semantics mirror the existing catalog rotation (preflight.ts:63-73): advance from lastStartProvider, first usable member wins.

## BBF-0046 Attention row severity dot still drifts below the title line
status: done (interactive session 2026-09-15)
priority: 2
depends_on: BBF-0042
risk: low
plan: src/ui/views/overview.ts, src/ui/views/aggregate.ts
approved: user direction 2026-09-15 (follow-up review of BBF-0042)
acceptance:
- The severity dot sits vertically centered on the disclosure caret and title line whether the row is collapsed or expanded, at every viewport width.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
notes: BBF-0042's alignment fix was verified insufficient by live measurement. The real cause: the dot is an inline-block inside a plain span wrapper, so it baseline-aligns inside the wrapper's inherited line box and lands near the baseline, below the title line's center. The wrapper is now display:flex, making the dot a flex item pinned to the wrapper's top so mt-1.5 sets a true top offset. Verified by rendering the exact markup plus compiled app.css in a browser: dot center matches caret center within ~0.5px.

## BBF-0047 Agent-drafted queue entries
status: done (run 2026-09-18T01:52Z)
priority: 2
depends_on: none
risk: low
plan: docs/control-surface.md (Work tab, wizard), src/actions/interactions.ts (Recommend pattern), templates/foreman.md
approved: user direction 2026-09-17 (spec approved and marked ready in-thread; no gated actions)
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

## BBF-0050 Validate protocol writes before settlement
status: done (interactive session 2026-09-24)
priority: 2
depends_on: none
risk: medium
plan: plans/factory/queue.md (this entry)
approved: user direction 2026-09-24 (build the fix directly; no gated actions)
acceptance:
- A plugin CLI command, bb factory validate, runs the same parsers and frozen-schema checks the plugin uses to load a repository against a checkout's protocol files, reading through the BB files API on the invoking host.
- It reports every problem in every file as path:line, message, rule, and fix hint, and exits 1; a clean checkout prints protocol ok and exits 0.
- The foreman spawn prompt, templates/foreman.md, and plans/factory/foreman.md require running it before every commit touching plans/ and after the final current.md write, and tell workers to escape literal pipes in dashboard cells.
- Tests cover a pipe inside an evidence cell, a pipe used as a sentence separator, and state idle in current.md.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- bb plugin types --check .
- git diff --check
notes: Workers commit and push their own protocol writes, so the plugin cannot reject a bad write after the fact; the check runs in the worker before the commit instead. No automatic repair: the plugin never rewrites worker files. Repository load stays strict; tolerating a bad current.md would need a change to the frozen snapshot contract.

## BBF-0051 Show the parse diagnostic on failed-safe runs
status: done (interactive session 2026-09-24)
priority: 2
depends_on: BBF-0050
risk: low
plan: plans/factory/queue.md (this entry)
approved: user direction 2026-09-24 (build the fix directly; no gated actions)
acceptance:
- Every malformed-protocol error carries the file, line, rule, and fix hint, and its message reads path:line: message (rule id). Fix: hint.
- The load-error banner, error notices, and failed-safe settlement reasons show that message, wrapped without truncation.
- Queue field errors report the field's own line.
validate:
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm build
- git diff --check
notes: The diagnostic travels in the error message, so every existing surface shows it without new UI plumbing and without a contract change.
