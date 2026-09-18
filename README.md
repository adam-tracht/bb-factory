# Factory (bb-factory)

A [bb](https://getbb.app) plugin that runs coding work on your repositories
while you are not there. You write tasks into a Markdown queue committed in
the repo. A foreman agent claims them overnight on a `factory` branch,
delegates to worker threads, runs your checks, and commits one task at a
time. In the morning you open one screen and see what shipped, what failed,
and which decisions are waiting on you.

The repository is always the source of truth. The queue, questions, run
records, and repo-specific rules are plain Markdown files committed inside
the repo, so Git history is the audit trail. The plugin reads those files,
guards every write it makes to them, and keeps only operational metadata
(run intents, ownership leases, idempotency results) in its own SQLite
store. It never copies task state into a second database.

## What you can do with it

- **Approve work.** The Work tab shows the queue and why each item can or
  cannot run. You mark items `ready` there; agents cannot.
- **Answer the questions that are yours.** When a foreman hits a decision
  that belongs to a human it writes a question with a recommended answer
  and moves on. Answer it in the Questions tab, or ask an agent for a
  recommendation first.
- **See every run.** The Runs tab lists each dispatch with its thread,
  provider, model, duration, and outcome. Overview shows repository
  health, the schedule, and the last run.
- **Control dispatch.** Settings edits the schedule, provider rotation,
  and pause state. The header pauses dispatch or starts a run right now,
  optionally pinned to a provider and model.
- **Review everything at once.** The All scope unions the tabs across
  every managed repository, so a morning review is one screen.

Underneath, a dispatch engine spawns the foreman threads on a cron
schedule or on demand, enforces one active run per repository, and cleans
up after anything that dies mid-run.

## Requirements

- bb >= 0.42 with plugin SDK >= 0.4.47 (enforced at install).
- npm on PATH. bb uses it to install dependencies and build git-source
  plugins.
- For dispatch: a signed-in agent provider (such as Claude Code or Codex)
  on the host that owns the repository.
- For scheduled overnight dispatch: an always-on bb server. A laptop
  install still gets the full control surface and manual **Run now** while
  bb is open; the schedule only fires while the server is up.

## Install

```sh
bb plugin install git:github.com/adam-tracht/bb-factory
```

Pin a release tag:

```sh
bb plugin install git:github.com/adam-tracht/bb-factory@v0.1.5
```

## Quickstart

1. Open the Factory view, click **Add repository**, then **Choose
   repository folder**. The native picker opens on the connected host.
2. Review the derived registration. The wizard fills the repository key
   and main ref (`origin/main` by default), matches or creates the bb
   project, and defaults the checkout to a dedicated `<root>-factory`
   worktree so the foreman never works in your main working copy.
   Registering the selected checkout directly is the advanced path. When
   the `factory` branch is already checked out elsewhere, the wizard
   offers that checkout instead. You can edit the display name shown in
   the UI; the repository key stays the technical identity. Registration
   ends paused.
3. If the checkout has no `plans/factory/` protocol, the wizard offers to
   scaffold it (`foreman.md`, `repo.md`, `queue.md`, `current.md`,
   `questions.md`, `runs/`), committed on the `factory` branch. Existing
   protocol files are never overwritten.
4. Draft the first queue entries. The wizard's final step and the Work
   tab both carry a **Draft tasks** control: give it a goal and an
   optional plan file, and it spawns an agent chat on the factory
   checkout that reads `repo.md` and the queue format header, appends
   entries with `status: draft`, and commits them on `factory`. Review
   the drafts in the Work tab's collapsed Drafts group and approve what
   should run. Marking work ready is always a human act.
5. Press **Run now** in the header for a supervised first run, or unpause
   dispatch and let the schedule take it. The next morning, review
   `current.md`, `runs/`, and `questions.md` from the tabs.

## The factory protocol

Each managed repository carries its protocol as Markdown under
`plans/factory/`:

| File | Role |
|---|---|
| `foreman.md` | The generic run protocol every foreman thread executes: preflight, claim, delegate, verify, commit, record. |
| `repo.md` | Repo-specific rules: standard checks, worker model table, branch policy, integration limits. Wins over `foreman.md` on conflict. |
| `queue.md` | Open work items with acceptance criteria and validation commands. Only entries a human marked `ready` are eligible. |
| `done.md` | Completed entries, moved here verbatim by the foreman. Satisfies `depends_on` references. |
| `current.md` | Three to six lines on the latest run plus a machine-readable `state:` line. Overwritten each run. |
| `questions.md` | Append-only questions for the human, classified `blocking` or `assumption`. |
| `runs/<timestamp>-<thread>.md` | Immutable record of one run. Never edited after the fact. |
| `lock` | Claim file containing the live run's thread id and start time. |

`plans/README.md` in the repository root stays the canonical dashboard. The
plugin links to it rather than replacing it.

### Queue entries

A queue entry is a fenced block of fields:

```
## <DASHBOARD-ID> <short title>
status: draft | ready | in-progress (thread <id>, <timestamp>) | done (run <timestamp>) | blocked-by: Q<n>
priority: 1 (highest) to 5
depends_on: <IDs, or none>
risk: low | medium | high
plan: <path to the canonical plan file>
approved: <none, or the gated actions the human allows: dependency add, migration, ...>
acceptance:
- <observable criterion>
validate:
- <exact command>
notes: <anything the foreman should know>
```

The status vocabulary is a closed list. `ready` is the only status a run
claims, and only a human may set it the first time. Agents can restore
`ready` when releasing or recovering a claim, but never grant it. Anything
that needs a human decision is not a status at all: it becomes a question
in `questions.md` and the entry is marked `blocked-by: Q<n>`.

An entry is eligible when it is `ready`, every `depends_on` target has
completed and moved to `done.md`, and no open blocking question references
it. Eligibility is evaluated per item, so one blocked entry never stalls
the rest of the queue.

### The human gates

Two authorization points are enforced by the plugin, not left to
convention:

- **Initial `ready`.** The first transition of a queue entry to `ready`
  can only be made through the plugin's approve control or by hand in the
  file. Agents cannot perform it. The plugin binds each approval to the
  exact entry, revision, and change, and the approval expires after 10
  minutes.
- **Protected operations.** Merges, deploys, migrations, dependency
  changes, secrets, data deletion, and customer-facing changes are off
  limits unless the entry carries an explicit `approved:` line naming what
  is allowed. A `risk: high` entry without one is skipped.

### Questions instead of waiting

The foreman never waits for an answer. When a decision belongs to a human
(customer-facing wording, money, vendor choice, secrets, irreversible
actions) it appends a `blocking` question with its recommended answer and
moves to other work. When it makes a judgment call a senior engineer would
make, it records an `assumption` question so you can reverse it. Every
question carries a `recommended:` line, so replying "yes" is enough.

## How a run works

A run is one unattended foreman thread executing the protocol end to end.

**Dispatch.** The scheduler fires, or you press **Run now**. The engine
then, in order:

1. Replays the recorded result if this request was seen before, so
   retries and double-clicks never double-dispatch.
2. Refuses when dispatch is paused globally or for the repository.
3. Loads a fresh protocol snapshot and rejects if the repository revision
   moved since the request.
4. Runs host preflight: connected host online, checkout present, on the
   `factory` branch, required tools available.
5. Selects a provider: your pinned preference, an explicit Run now
   override, or the configured rotation. It skips providers that are
   unavailable, permission-limited, or inside their 6-hour limit window
   after a dead start. Per-provider model and reasoning overrides apply
   after that check.
6. Persists, in one SQLite transaction, the run intent (eligible items and
   who authorized them), an ownership lease (a unique index guarantees one
   active run per repository), and the dispatch attempt.
7. Spawns the foreman: a bb thread on the repository's project and the
   factory checkout, told to read `plans/factory/foreman.md` then
   `repo.md` and execute one run.

**The foreman loop.** What the spawned thread does, per `foreman.md`:

1. *Preflight.* `git status`, `git fetch`, rebase onto `origin/main` per
   the repo's rules. A dirty tree triggers recovery: finish coherent
   partial work, or stash it and release the claim. An existing fresh lock
   means another run is live, so this one stops as a no-op.
2. *Claim.* Picks the highest-priority eligible entry, marks it
   `in-progress`, and commits the claim alone.
3. *Plan.* Breaks the task into worker jobs with explicit file boundaries,
   done conditions, and validation commands. Vague acceptance criteria
   become a blocking question, not a guess.
4. *Delegate.* Spawns worker bb threads in the same worktree (models per
   `repo.md`), reviews each job for spec compliance and then code quality,
   and fixes or re-briefs before the next job.
5. *Verify.* Runs every `validate:` command plus the repo's standard
   checks itself. After two failed fix rounds it reverts the task's files,
   releases the entry back to `ready` with a `failed:` note, and records
   it.
6. *Commit.* One commit per task (`factory: <ID> <summary>`) including the
   dashboard row and queue update. The finished entry moves to `done.md`.
   Pushes `origin/factory`. Repeats from claim while budget remains
   (roughly 90 minutes or 4 tasks, whichever comes first).
7. *Record.* Writes the immutable run record, overwrites `current.md`
   with a summary and the `state:` line (`success`, `blocked`,
   `failed-safe`, `no-op`), removes the lock, commits and pushes, and
   posts a plain-English report: what shipped, what did not and why,
   every open question in full, and the merge state of `factory` versus
   `origin/main`.

**Reconciliation.** The plugin watches the foreman thread. On completion
it trusts `current.md` only when the file was modified after the run
started. It maps the `state:` line onto the operational run record,
updates counters, and releases the lease. A thread that dies without a
fresh state line is marked `failed-safe` and its provider takes a 6-hour
limit. A spawn that may or may not have landed is marked
`reconciliation-required` instead of being retried blind. Runtime past the
configured cap requests cancellation, and the lease releases only after
the thread is confirmed terminated. **Retry** resubmits the original
message through bb's retry path, bounded to three total attempts per run.

## The control surface

- **Repositories landing**: cards per registered repository plus **Add
  repository**.
- **Add repository wizard**: pick a folder with the native host picker.
  The plugin validates it is a git repo, derives the repository key,
  detects `mainRef` from the remote HEAD, matches or creates the bb
  project, and defaults to provisioning a dedicated `<root>-factory`
  worktree on the `factory` branch so runs never touch your working copy.
  An advanced path registers the checkout directly. When the `factory`
  branch is already checked out elsewhere, the wizard offers that checkout
  instead of failing on a git error. Registration always ends paused.
- **Protocol scaffolding**: for a checkout with no `plans/factory/`, one
  guarded action writes the missing files from the bundled templates.
  Existing content is never overwritten, the action refuses off the
  `factory` branch, and it commits the scaffold on `factory`.
- **Overview**: repository health, current foreman state, schedule and
  spacing status, host prerequisites, and the dashboard link.
- **Work**: the union of `queue.md` and `done.md`, eligibility chips per
  entry (a `ready` entry gated by a question or missing approval never
  shows a green Ready chip), and the guarded approve control.
- **Questions**: repository questions merged with the foreman's pending bb
  interactions. Answering resolves the real interaction once.
  **Recommend** spawns a separate thread to draft an answer or approval.
  It writes nothing to the repository, so you still record the decision.
- **Runs**: run history with links to each thread, provider, model,
  duration, and task ids. Run detail shows attempts and the linked
  canonical records.
- **Settings**: editable dispatch form (schedule, providers, pause) with a
  plain-English schedule preview and next fire times.
- **All scope**: unions Overview, Work, Questions, and Runs across every
  registered repository, grouped by repository. Rows still act on their
  own repository. Settings stays repository-scoped.
- **Shell header**: repository switcher, dispatch status chip, running or
  idle badge, pause and resume, and a confirmed **Run now** that
  optionally pins provider, model, and reasoning level for that run.

## Scheduling and dispatch policy

One plugin-owned scheduler evaluates a five-field cron expression in
`server-local` or a named IANA time zone.

- **Night window**: `nightWindowEndHour` (default 6) bounds when new work
  stops. The nightly counters reset when the night key rolls over.
- **Spacing**: `minimumStartGapSeconds` enforces a rolling minimum gap
  between foreman starts (default and floor: 3600).
- **Runtime cap**: `runtimeCapSeconds` (default 10800, three hours) stops
  a run safely.
- **Concurrency**: `concurrencyLimit` (default 1) caps simultaneous runs.
  The per-repository lease allows exactly one active run regardless.
- **Pause**: prevents new dispatch only. Active work and queued intent are
  untouched.
- **At-least-once**: scheduling may fire more than once for a window
  (restart, replay, reload), but the durable intent and lease mean a
  duplicate wakeup produces a replay, not a second run.

## What the plugin will not do

- Commit to or switch to `main`, or merge `factory` into it. Merge
  reporting is a report only. The merge decision stays human.
- Let an agent perform the first transition of a queue entry to `ready`.
- Merge, deploy, migrate, change dependencies, touch secrets, delete data,
  or change customer-facing behavior without an `approved:` line.
- Overwrite a file that changed underneath it, or overwrite existing
  protocol content during scaffolding.
- Keep a second copy of queue or question state. Repository files stay
  authoritative, and unknown status values render tolerantly rather than
  failing the read.

## How writes are guarded

Every change the plugin makes to repository files goes through the
`factory_action` RPC and the same sequence:

1. Validate the action, binding, and repository policy against a fresh
   snapshot. Reject if `expectedRevision` does not match what you saw.
2. Persist a durable intent in SQLite: the idempotency key, target file,
   expected revision, expected file SHA-256, and the exact write payload.
3. Write with `expectedSha256` compare-and-swap. A conflict returns
   `stale-revision` and nothing is overwritten.
4. Re-read the target, verify the content landed as intended, and record
   the result.

Resubmitting the same request replays the stored result. A different
payload under the same key returns `idempotency-conflict`. Idempotency
keys have the frozen shape `bbf:v1:<repository>:<operation>:<UUID>`, and
the repository and operation segments must match the request. Writes are
single-file and section-preserving: the plugin edits the parsed field of
the parsed record and leaves the rest of the Markdown byte-identical.

Answering bb interactions (provider approvals and user questions raised by
a running foreman) follows the same pattern: claim the key, resolve the
interaction once, verify the persisted resolution, replay on retry. An
ambiguous or mismatched resolution becomes `reconciliation-required`
rather than a second, different answer.

## Docs

- [docs/control-surface.md](docs/control-surface.md): how the UI composes
  the protocol (aggregate scope, wizard chrome, disclosure, deep links,
  chips).
- [docs/action-implementation-gates.md](docs/action-implementation-gates.md):
  the guarded-action design, durable intents, and the human-only `ready`
  policy.
- [docs/hosting-decision.md](docs/hosting-decision.md): the pending
  always-on hosting decision and rollout gates.
- [docs/release.md](docs/release.md): how releases are gated, tagged, and
  pushed.
- [PLAN.md](PLAN.md): the phased implementation plan and contract history.

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm build       # bb plugin build ., writes dist/ (gitignored)
pnpm release     # full gate plus staged dist/, then prints the tag commands
```

License: [MIT](LICENSE).
