# Run record: stale question gates

- Date: 2026-09-11
- Thread: this interactive session (root)
- Tasks attempted: BBF-0014 (badge drops question id), BBF-0015 (stale question gates strand blocked entries)

## Outcome

- BBF-0014: done. `queueStatusLabel` renders `Blocked by Q<n>: <detail>` so the question id survives alongside the detail text.
- BBF-0015: done. The reader now emits `staleBlockingQuestionIds` plus a `stale-question-gate` eligibility reason when a `blocked-by` status names a question that is answered or missing. Work rows put stale-gated entries in Needs you with a `Review Q<n>` CTA that opens the question card; the expanded detail keeps the reference reachable and prints "Gating question is answered or missing". The attention model raises an action item so the Work tab badge counts them. `templates/foreman.md` (and this repo's `plans/factory/foreman.md`) now instruct foremen to re-file leftover human work as a new blocking question rather than leaving an entry gated on a question they just answered. `templates/MANIFEST.json` re-hashed.

## Data fix (diggs-data-platform)

- `diggs-data-platform-factory` commit `acc6097` on `factory`: Q6's answer now notes the remainder was re-filed; new `Q18` carries the GA4-to-BigQuery pipe creation; `DATA-0007.04` re-pointed to `blocked-by: Q18`. The entry now lands in Needs you with an Answer CTA.

## Validation

- `pnpm test`: 293 passing (new coverage: reader stale-gate test, Work needs-you/Review-CTA test, detail reachability test)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean

## Workers used

- None; implemented inline (small coherent change across reader, contracts, two UI surfaces, and the foreman template).

state: success

## Follow-on in the same session: BBF-0016 through BBF-0019

Four more live-UI defects, orchestrated as three parallel workers (0016+0017 shared FactoryView.ts):

- BBF-0016: done. `FactoryShellProps.repositoriesActive` mirrors the landing-render branch; the All pill owns active state on the landing and repo pills stay dark. Select-fallback All switches to the secondary treatment when active.
- BBF-0017: done. Landing card select now runs select + navigate("overview"), so card clicks leave the landing instead of re-rendering it under the Overview tab highlight.
- BBF-0018: done. RunDetailView header renders "Open thread" via `ctx.onOpenThread(run.workerThreadId)`; attempt rows link their own `workerThreadId`. Null threads render no control.
- BBF-0019: done. RepositoryCard keeps host status and the dispatch toggle inline; the eight read-only identity fields moved into a collapsed "Repository details" Disclosure.

Validation: `pnpm test` 300 passing, `pnpm typecheck`, `pnpm lint`, `pnpm build` clean.

state: success

## BBF-0020: repository selection dead controls and panel thrash

Live report after cbcdfe4: repo pills on the landing never navigate and can
never appear active (repositoriesActive forces them dark) while every click
reset the whole panel and unmounted the switcher. Two review passes
(spec compliance + code quality) converged on the same mechanism plus two
amplifiers (settingsIdentity-keyed override snapping back on registry writes;
unfiltered realtime events for other repositories reloading everything).

Fix: pill/select clicks on landing-scoped routes now select + navigate to
overview; load() preserves the ready repositories projection so pills stay
mounted, with repositorySelectionPending driving an aria-busy + opacity dim;
the override keys on configuredRepositoryKey only; onRealtime skips events
naming another repositoryKey (global/null events still reload).

Validation: pnpm test 304 passing (4 new integration tests: pill navigates on
landing, pills stay mounted mid-load, selection survives a registry write,
cross-repo invalidations ignored), typecheck, lint, build clean.

state: success

## BBF-0021: repo chrome stuck over the repositories landing

Live QA after c29f3cc: clicking "All" left the previous repo's sub-header
(branch/commit chip, dispatch badge, running badge, Pause/Resume, Run now,
and the section tab bar) rendered above the Repositories landing.

Fix: `FactoryShell` derives `repoChrome = !repositoriesActive` and gates the
branch/commit chip, dispatch chip, running/idle badge, Pause/Resume, Run now,
its confirm dialog, and the SECTION_TABS nav on it (src/ui/shell.ts). Title,
switcher, refreshed indicator, legend, and connection/malformed banners always
render. The add-repository route is excluded from `repositoriesActive`, so the
wizard keeps the chrome; unchanged.

Validation: pnpm test 306 passing (new integration test: chrome absent on the
landing and present on a repo view; new shell unit test), typecheck, lint,
build, `bb plugin types --check`, `git diff --check` clean. Commit 5fd679e,
pushed to origin/factory; installed plugin rebuilt and reloaded.

Live re-verify (Aside repl, direct DOM assertions on http://127.0.0.1:38886):
after clicking All, the tab bar, dispatch chip, branch/commit chip, Resume,
and Run now are absent while the switcher, refreshed indicator, and legend
remain; after clicking the bb-factory pill the tab bar and chips return.
Confirmed fixed.

state: success
