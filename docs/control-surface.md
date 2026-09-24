# Control surface

How the plugin UI composes the factory protocol. This document describes the
surface as implemented in `src/ui/`; it does not approve a rollout or change
any repository policy. Action-layer guards live in
[action-implementation-gates.md](action-implementation-gates.md).

## Scopes and routes

`src/ui/routes.ts` parses the panel subPath into a section plus a scope:

- Repository scope: `overview`, `work`, `questions`, `runs`, `settings`, and
  `runs/<runId>` render the selected repository. `queue` is a legacy alias for
  `work`.
- Aggregate scope: the panel root, `repositories`, `all`, and `all/overview`
  land on the aggregate overview; `all/work`, `all/questions`, and `all/runs`
  render union tabs. `all/runs/<repositoryKey>/<runId>` pins an aggregate run
  detail to its owning repository. `all/settings` intentionally does not
  exist; settings stay repository-scoped.
- Section anchors travel as a trailing path segment
  (`questions/question-Q3`) because the host percent-encodes `#` inside a
  subPath; the legacy `%23` form still decodes. Aggregate anchors carry the
  owning repository as `<repositoryKey>/<inner>` so a focused row resolves to
  one group; a bare inner anchor focuses every group that contains the item.

Registry entries may include an optional `displayName` for presentation. The
resolved display label appears in the repository switcher, landing cards,
aggregate repository headings, repository-specific empty states, and
confirmation copy. `repositoryKey` remains the operational identity in routes,
DOM ids, storage keys, action scopes, RPC inputs, callbacks, and technical
details.

The Work tab reads the union of `plans/factory/queue.md` and optional
`plans/factory/done.md`, with queue entries first. Completed entries remain
visible and satisfy `depends_on` references after moving to `done.md`. The
foreman never reads `done.md`; existing status and attention rules still apply.

## Run completion and recovery

The dispatch lifecycle settles a run only after the observed terminal worker,
its active attempt, the current lease, a fresh `plans/factory/current.md`, and
an attributable immutable run record agree on the same outcome. Immutable
record names carry the UTC timestamp and worker thread id. A failed-safe
outcome may settle without an immutable record only when the fresh current
state explicitly says `failed-safe`.

Malformed, stale, unreadable, or mismatched evidence moves the run into
`reconciliation-required`. This is a bounded settlement state, not a terminal
outcome. The deadline is persisted on first detection and is never extended by
later observations. The current settlement window is ten minutes. A corrected
correlated outcome can settle during that window. At the deadline, the
operational run becomes `failed-safe` so it no longer consumes global run
capacity, terminalizes active attempts, and updates counters once. The
dispatcher releases the repository lease only after a worker re-observation
confirms termination. If the worker is live, stopping, unreadable, or the
spawn was ambiguous, the lease stays `reconciliation-required`, quarantining
only that repository. An ambiguous spawn with no real thread id remains
quarantined. An explicit operator repair may release the sentinel lease only
after repository dispatch is paused and the durable quarantine timeout has
elapsed; `current.md` cannot authorize release.
Repeated finalization is a no-op, and a conflicting terminal outcome is
rejected. The public run projection stays unchanged, so diagnostic observations
remain internal while the attention surface marks reconciliation as urgent and
the run detail explains the next state.

## Aggregate composition

The "All" tabs are a pure view-layer union (`src/ui/views/aggregate.ts`):
`AggregateSectionView` renders status categories first, then only the
repository subgroups that contribute rows to that category. All Work uses
Needs you, Ready, Blocked, Running, Drafts, and Done; All Questions uses BB
questions, Open, and Answered; All Runs uses Active and History. Each subgroup
uses the same per-repository rows (`WorkView`, `QuestionsView`, `RunsView`)
against a context scoped to that repository. FactoryView fetches each
repository's existing read projections into a `data.all` bundle map, sharing
in-flight fetches with the landing cards' `loadSummary`, so no new RPC or
storage seam exists and the wire contract is unchanged. The aggregate
overview is category-first: Needs attention, Work queue, Questions, Current
run when present, Last run, Dispatch, and a conditional Repository section.
Each category nests only contributing repositories under a scoped context.
Repository subgroup headings render at normal weight under the semibold
category titles, Needs attention rows show only the item title in the summary
and reveal the detail line indented under it on expand while the severity dot
and row action stay anchored to the title line at every viewport width, and on desktop the Work queue subgroup
carries its status chips and Open work action inline on the repository row
(on phone they stay inside the collapsible body). The
Last run category always has one row per repository, including repositories
whose latest completed run succeeded; its View action keeps the existing
aggregate run-detail route. Work and question content is summarized with
counts and compact rows, while dispatch and repository details retain useful
actions and links for attention states. Healthy repositories omit repository
detail disclosures. Aggregate Overview hides filesystem paths, digests,
capture times, raw cron, extra future run times, and routine older run history;
it does not render `RepositoryLandingView` cards or duplicate the
repository-scoped `OverviewView`.

Aggregate sections settle independently. A ready repository renders its rows
while another repository remains in a loading or error subgroup, and the
outer count is the sum of ready rows only. A repository subgroup is omitted
when it has no rows and all its sources are settled; unresolved sources keep a
loading or error subgroup visible. When every source is settled and empty, the
tab shows one explicit all-repositories empty state instead of misleading
zero-count rows.

## Repository-scoped actions

`scopedContext` in `src/ui/FactoryView.ts` pins each aggregate group to its
own registry entry and bundle: repository configuration, environment and
project ids, dispatch pause flag, and the snapshot revision come from that
repository, and `onAction` submits against that repository and revision.
Feedback and pending state are scoped per repository and section, so one
repository's action result never paints on another's rows. Links to sections
without an aggregate tab (overview detail, settings) hop to the row's own
repository; work, questions, and runs links stay inside the aggregate.

## Draft tasks

The Work tab carries a **Draft tasks** control above the queue groups, and
the add-repository wizard offers the same control as its final step once the
protocol files exist on the `factory` checkout. Both take a free-text goal
and an optional plan file path; the Work tab dialog also offers an Automatic
provider default or an explicit pick through the shared provider picker,
while the wizard drafts on the project's stored defaults. The control
dispatches the `draft-tasks` action, which spawns a permission-`auto` thread
on the repository's factory checkout (the recommend-* spawn pattern) that
reads `plans/factory/repo.md` and the queue format header, appends entries
with `status: draft` and observable acceptance criteria, and commits them on
`factory`. It never writes any other status and never edits existing
entries, so the human-only initial `ready` gate is unchanged: the Work tab
surfaces the appended drafts in the collapsed Drafts group, where the
existing Approve control marks one ready and records its `approved:` line.

## Shell chrome

`src/ui/shell.ts` gates per-repository chrome on the rendered scope. The
branch/commit chip, dispatch chip, running/idle badge, global Pause/Resume, and the
confirmed Run now render only on repository-scoped routes. The repositories
landing and the aggregate scope show the tab strip without that chrome (four
tabs under aggregate; Settings is omitted). The add-repository wizard
suppresses repo chrome and every pressed switcher state while it renders. The
repository switcher is a segmented control at the `sm` breakpoint and up, a
select below it and whenever more than four repositories are registered, and
an "All" control owns the active state on aggregate and landing routes.
Selecting a repository while on a landing or aggregate route navigates to
that repository's view of the current section.

## Wizard origin and Back

Opening the add-repository wizard (`repositories/new`) records the current
repository selection and subPath; its Back control restores that exact view. A wizard reached by
deep link has no remembered origin, so Back lands on the aggregate
repositories view, and leaving the wizard by any other path drops the
origin. The folder-picker step asks for "the folder on this machine" with
the host label.

## Progressive disclosure and deep links

`CollapsibleSection` (`src/ui/primitives.ts`) is a controlled `<details>`:
children mount only while open. Open state persists per section in
`window.sessionStorage` under `bb-factory:section:<repositoryKey>:<tab>:<section>`,
and `Section` keys the inner `CollapsibleSection` by that storageKey, so a
repository switch remounts and restores the newly selected repository's own
stored choice instead of carrying the previous one over; the aggregate view
reuses the same tabs under different repositories without collisions. On
phone width only the first section of each tab starts open (Needs attention
on Overview, Needs you on Work, Open on Questions); on run detail the
Summary header is always visible and the remaining sections collapse. Technical details, Attempts, Done, and Answered start collapsed on
every width, and collapsed sections keep their count badge. A focused deep link reveals its section via
`forceOpen` without rewriting the stored choice. Row anchors are DOM ids
(`work-<id>`, `question-<id>`, `interaction-<id>`); in aggregate views
`ctx.idPrefix` prefixes them with `<repositoryKey>:` so ids stay unique, and
deep links scroll to and expand the focused row. Run detail carries a "‹
Runs" back control that routes to the repository's Runs tab while Runs stays
highlighted.

## Responsive rows

Under `sm` (639px): repository scope uses deterministic repository, shared
controls, operations, and tabs rows. The repository row puts All, the picker,
and add before a flexible spacer with refresh and the legend; the bounded
operations bar pairs the scoped dispatch chip with global Pause/Resume, shows Idle or an
active run when useful, and anchors Run now at the right. Aggregate scope goes
directly from the repository row to tabs. The duplicate Factory title is
hidden, the expected `factory` branch is hidden, and an unexpected branch is
labeled `Branch: <name>`.
The `@sha` chip is hidden and the tab strip scrolls the active tab into view;
mobile tabs use equal widths with a clipped-edge affordance and a hidden
scrollbar, then fall back to horizontal scrolling when their minimum width is
reached. Small controls (refreshed indicator, add-repository "+", legend "?",
file links) keep a 32px minimum hit area and the run-detail back control a 44px
one. The refresh cue stays in the controls row. Work rows wrap the title to a
clamped second line, run history rows lay
out as two lines (time, status, provider, duration, then a wrapping group of
task-id chips) with the chevron centered, and question titles clamp to two
lines with the Answered or Recorded chip still visible. Work row chips
reflect effective eligibility (a `ready` entry that is question-gated or
awaiting approval never renders a green Ready chip), empty groups render a
muted line, and Done provenance renders in one format ("Done <relative time>
via run" or "via thread") with the id as a mono chip. Run status labels use
one casing everywhere ("Blocked", "No-op", "Success", "Failed safe"), and a
run with no task ids renders a muted "No tasks".

## Settings save feedback and schedule sentence

The Settings dispatch card tracks a draft against the loaded projection: each
field shows an inline "Saving..." then a "Saved" mark that fades after
1500ms, and pending edits pin a sticky "Unsaved changes" bar with Discard and
Save behind a confirm dialog. A same-repository refresh keeps the Saved
marks and untouched concurrent edits; a different repository resets the
form. Global dispatch mode is a segmented Enabled/Paused control, and the
Repository card pairs host status with a labeled "Pause repository dispatch"/
"Resume repository dispatch" button. These are independent gates: the global
`dispatchMode` setting controls whether new runs may start for any repository,
while each repository's `dispatchPaused` flag controls only that repository.
The shell chip reports "Global dispatch active", "Global dispatch paused", or
"Repository dispatch paused"; its "Pause global dispatch"/"Resume global
dispatch" control always edits the global mode, while the Settings Repository
card edits only the selected repository's pause flag. New runs require global
dispatch to be enabled and the repository pause flag to be false only when
they are scheduled starts; confirmed Run now remains an explicit ad hoc
dispatch while the schedule is paused. The mobile operations bar uses the same
scoped chip labels and global button labels. The card also provides an
optional editable "Display name" field; clearing it restores the repository key
as the visible fallback. The repository key
remains read-only technical identity, and the other read-only identity fields
collapse into a "Repository details" disclosure. `describeSchedule` (`src/schedule/describe.ts`) renders a
five-field cron as a sentence ("Every 10 minutes between 01:00 and 05:59,
every day") on the Settings preview, which also lists the next three fire
times, and on the repository Overview dispatch card; All Overview shows at
most the next fire time, shows non-server-local time zones beside the
summarized schedule, and uses "Schedule configured" when the expression
cannot be described without exposing raw cron. An "Every N minutes" reading
only applies when N divides 60 evenly, and repository-scoped views otherwise
fall back to the raw expression. Presets set Nightly, Hourly, or Manual only.

## Chips, legend, and refresh cue

Badge tones use fixed hex pairs (`src/ui/primitives.ts` `TONE_BADGE`): green
`#dcfce7`/`#166534` and amber `#fef3c7`/`#854d0e` hold at least 4.5:1
contrast on light and dark themes, since the theme status hues fail on light
packs. Text-bearing chips and labels use the bare `rounded` radius while
geometric circles (status dots, the "?" button) keep `rounded-full`. The "?"
legend explains every chip family in the shell and rows: status colors,
"current", provider chips, host ids, and mono id chips. When a background
refresh changes the header state, the refreshed indicator briefly reads
"Updated" so the change is not silent.
