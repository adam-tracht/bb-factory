# Factory (bb-factory)

A [bb](https://getbb.app) plugin that is both a native control surface and an
unattended overnight factory for your repositories.

Each managed repository keeps a queue-and-foreman protocol as plain markdown
under `plans/factory/`: a queue file lists work items with acceptance criteria
and validation commands, and a human authorizes each one by setting
`status: ready`. On a schedule or on demand, the plugin dispatches an
unattended foreman thread that claims ready entries on the `factory` branch,
delegates implementation to worker threads, runs the declared validation,
commits per task, and leaves a run record plus any blocking questions for
morning review. Protected operations (merges, deploys, dependency changes,
secrets, customer-facing changes) always wait for an explicit `approved:`
line from a human.

The repository's own files stay authoritative: the queue, dashboards, and
repo-specific rules in `plans/factory/repo.md` are never replaced, and every
plugin write is a guarded action with revision checks and durable intent
records.

## What you see

- A Repositories landing view and an Add repository wizard for registering
  managed repositories.
- Five tabs per repository: Overview, Work, Questions, Runs, and Settings.
- Shell header controls: repository switcher, dispatch status chip,
  pause/resume, and a confirmed Run now.

## Requirements

- bb >= 0.42 with plugin SDK >= 0.4.47 (enforced at install).
- npm on PATH: bb uses it to install dependencies and build git-source
  plugins.
- For dispatch: a signed-in agent provider (such as Claude Code or Codex) on
  the host that owns the repository.
- For scheduled overnight dispatch: an always-on bb server. A laptop install
  still gets the full control surface while bb is open; dispatch only runs
  while the server is up.

## Install

```sh
bb plugin install git:github.com/adam-tracht/bb-factory
```

Pin a release tag:

```sh
bb plugin install git:github.com/adam-tracht/bb-factory@v0.1.3
```

## Quickstart

1. Open the Factory view and click **Add repository**, then **Choose
   repository folder**. The native picker opens on the connected host.
2. Review the derived registration: the wizard fills the repository key and
   main ref (`origin/main` by default), matches or creates the bb project,
   and defaults the checkout to a dedicated `<root>-factory` worktree so the
   foreman never works in your main working copy. Registering the selected
   checkout directly stays available as the advanced path, and when the
   `factory` branch is already checked out elsewhere the wizard offers that
   checkout instead. Registration ends paused.
3. If the checkout has no `plans/factory/` protocol, the wizard offers to
   scaffold it (`foreman.md`, `repo.md`, `queue.md`, `current.md`,
   `questions.md`, `runs/`), committed on the `factory` branch. Existing
   protocol files are never overwritten.
4. Write the first queue entry in `queue.md` with acceptance criteria and
   validation commands, then set `status: ready`. Marking work ready is
   always a human act.
5. Press **Run now** in the header for a supervised first run, or unpause
   dispatch and let the schedule take it. Review `current.md`, `runs/`, and
   `questions.md` from the tabs the next morning.

## Docs

- [docs/release.md](docs/release.md): how releases are gated, tagged, and
  pushed.
- [PLAN.md](PLAN.md): the phased implementation plan and contract history.
- [docs/](docs/): protocol contracts, acceptance records, and hosting notes.

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
