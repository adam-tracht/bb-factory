# Factory run record: BBF-0047 agent-drafted queue entries

date: 2026-09-18
state: success
tasks: BBF-0047
branch: factory
commits: 8dbcb6c (task), plus the claim c537e82 and this bookkeeping record
push: origin/factory
workers: codex / gpt-5.6-luna xhigh (implementation); codex / gpt-5.6-sol
medium (compliance and code-quality reviews); foreman acp-devin / swe-2-max

## Preflight

Clean tree, no live lock. `git fetch origin` ran; the `git rebase
origin/main` step was skipped under assumption Q3: this repository's main
is a synthetic release branch (commit-trees of factory minus plans/ plus
dist/), so the rebase can only conflict and main never carries source
changes factory lacks. Claim committed as c537e82.

## Tasks

- BBF-0047 agent-drafted queue entries: new `draft-tasks` guarded action
  spawns an advisory thread on the repository's factory checkout that
  reads repo.md and the queue format header, appends only `status: draft`
  entries (approved: none), commits them on `factory`, and replies with
  the appended IDs. Contract widens the action-kind union and outcome
  schema; storage rebuilds pending_action_intents as v6 to widen the
  CHECK list. Controls ship as a Draft tasks dialog on the Work tab
  (Automatic or shared-picker provider choice) and as the wizard's final
  card after a factory-branch registration (Finish stays a separate
  step). Draft rows surface in the collapsed Drafts group and approve
  through the existing human-only composer. Foreman docs gain the
  draft-follow-up rule; README step 4 and control-surface.md describe the
  flow.

## Reviews

Compliance (Sol Medium) passed every acceptance criterion. Code quality
(Sol Medium) found three should-fix items, all fixed and re-verified: a
test that a lone serviceTier is suppressed when no provider triple is
sent, a v5-to-v6 migration test proving populated intents survive the
rebuild and draft-tasks claims land on the new table, and disabling the
wizard's Finish and Back controls while a draft request is in flight so
navigation cannot race its thread redirect.

## Validation

pnpm test (543), pnpm typecheck, pnpm lint, pnpm build,
`bb plugin types --check .` (0.4.87), `git diff --check`. All green on the
committed tree.

## Notes for the next foreman

- The wizard intentionally sends no provider triple; project defaults
  apply. The Work tab dialog offers Automatic vs an explicit pick.
- `serviceTier` is schema-valid alone but the executor drops it unless a
  full provider triple rides with it; tests pin that behavior.
- Any future action-kind addition needs another rebuild migration; copy
  the v6 block verbatim and widen the CHECK list.
