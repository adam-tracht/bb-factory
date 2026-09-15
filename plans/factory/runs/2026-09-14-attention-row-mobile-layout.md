# Factory run record: BBF-0041 overview attention rows stack awkwardly on phone

date: 2026-09-14
state: success
task: BBF-0041
branch: factory
commit: this commit
push: origin/factory
workers: none (interactive session)

## Scope

Follow-up from live review of BBF-0040. Collapsed Needs attention rows carried
the action on a dedicated full-width line (basis-full), roughly doubling each
row's height and leaving the severity dot floating. The action now shares the
title line with an ml-auto fallback. Disclosure bodies gained pl-3 so expanded
detail text aligns under the summary title instead of starting at the row's
left edge; the fix applies to every Disclosure call site.

## Validation

- `pnpm test`: 28 files, 473 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.

## Protocol bookkeeping

- Added BBF-0041 to the factory queue with the recorded `approved:` line.
- Updated `plans/factory/current.md` and the dashboard row in
  `plans/README.md`.
- BBF-0039's completed display-name work stays uncommitted and unpushed in the
  working tree per the earlier direct request; this commit stages only
  BBF-0041 hunks.
- Immutable prior run records were not changed.
