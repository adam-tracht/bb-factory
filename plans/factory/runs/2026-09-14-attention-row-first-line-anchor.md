# Factory run record: BBF-0042 attention row severity dot drifts off the title line when expanded

date: 2026-09-14
state: success
task: BBF-0042
branch: factory
commit: this commit
push: origin/factory
workers: none (interactive session)

## Scope

Follow-up from live review of BBF-0041 on the aggregate overview. Above the sm
breakpoint the Needs attention row switched to items-center and dropped the
severity dot's mt-1.5 offset, so an expanded (taller) row vertically centered
the dot on the whole row block while the caret stayed on the title line. The
row now anchors every item to the title's first line: items-start applies at
all widths, the dot keeps mt-1.5, and the action sits in a one-line-tall
(h-5) lane that centers it on the title line whether the row is collapsed or
expanded. Applied identically to the repository-scoped and aggregate Needs
attention rows. This commit also corrects current.md: BBF-0039's display-name
work was committed as 434765f between the two earlier fix commits, so it is no
longer uncommitted.

## Validation

- `pnpm test`: 28 files, 473 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.

## Protocol bookkeeping

- Added BBF-0042 to the factory queue with the recorded `approved:` line.
- Updated `plans/factory/current.md` and the dashboard row in
  `plans/README.md`.
- Immutable prior run records were not changed.
