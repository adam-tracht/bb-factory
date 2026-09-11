# Factory

Unattended overnight coding runs for your repositories, behind a native bb
control surface.

Factory manages a queue-and-foreman protocol stored as markdown inside each
repository under `plans/factory/`. You authorize work by marking queue
entries `ready`; an unattended foreman claims them on the `factory` branch,
delegates implementation to worker threads, runs the validation commands you
declared, and commits per task. Merges, deploys, dependency changes, secrets,
and anything customer-facing stay behind an explicit human `approved:` line.
Every run leaves an immutable record, the current state, and any blocking
questions the foreman raised instead of guessing.

## What you get

- A Repositories landing view plus an Add repository wizard: pick a folder,
  review the derived key and main ref, and register paused. The wizard
  matches or creates the bb project, defaults to a dedicated
  `<root>-factory` worktree, and offers to scaffold `plans/factory/` when
  the checkout lacks it. No host, project, or environment ids are ever
  asked for.
- Five tabs per repository:
  - Overview: dispatch state, latest run, and what needs attention.
  - Work: the queue, eligibility, and active claims.
  - Questions: blocking questions and recorded assumptions.
  - Runs: immutable run history and the latest run record.
  - Settings: editable registry and dispatch configuration.
- Header controls everywhere: repository switcher, dispatch status chip,
  pause/resume, and a confirmed Run now.
- Guarded actions: revision-checked writes with durable intent records; the
  foreman never commits to `main`.

## Requirements

- bb >= 0.42.
- A signed-in agent provider (such as Claude Code or Codex) on the host that
  owns each repository, for dispatch.
- An always-on bb server for scheduled overnight runs. On a laptop, the full
  control surface works while bb is open; dispatch only runs while the
  server is up.

## Quickstart

1. Open Factory, click **Add repository**, and pick the repository folder.
   The wizard derives the key and main ref, matches or creates the bb
   project, and provisions a dedicated `<root>-factory` worktree.
   Registration ends paused.
2. Accept the offered protocol scaffold if the checkout lacks
   `plans/factory/`; it writes the protocol files and commits on `factory`.
3. Add a queue entry with acceptance criteria and validation commands, and
   mark it `status: ready`.
4. Press **Run now** for a supervised first run, or unpause dispatch and let
   the schedule work overnight.
