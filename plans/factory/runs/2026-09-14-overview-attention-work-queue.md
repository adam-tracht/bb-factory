# Factory run record: BBF-0040 overview attention duplication and work-queue row layout

date: 2026-09-14
state: success
task: BBF-0040
branch: factory
commit: this commit
push: origin/factory
workers: none (interactive session)

## Scope

User-reported fixes on the aggregate overview. Needs attention rows no longer
render a clamped copy of the detail inside the disclosure summary, so expanding
a row reveals the detail instead of duplicating it. On desktop the Work queue
repository row carries its status chips and Open work action inline in the
section header (the row is non-collapsible there since it has no body); on
phone the chips stay inside the collapsible body. Repository subgroup headings
across the aggregate overview render at normal weight via a new optional
Section titleClassName, while category titles keep the semibold treatment.

## Validation

- `pnpm test`: 28 files, 465 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.

## Protocol bookkeeping

- Added BBF-0040 to the factory queue with the recorded `approved:` line.
- Updated `plans/factory/current.md` and the dashboard row in
  `plans/README.md`.
- BBF-0039's completed display-name work stays uncommitted and unpushed in the
  working tree per the earlier direct request; this commit stages only
  BBF-0040 hunks.
- Immutable prior run records were not changed.
