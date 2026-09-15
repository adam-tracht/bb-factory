# Factory run record: BBF-0046 attention row severity dot still drifts below the title line

date: 2026-09-15
state: success
task: BBF-0046
branch: factory
commit: this commit
push: origin/factory
workers: none (interactive session)

## Scope

Follow-up to BBF-0042: live review showed the severity dot still rendered a
line below the caret. BBF-0042 fixed the sm+ centering drift but missed the
real cause, confirmed by rendering the exact markup against the compiled
app.css in a browser: the StatusDot is an inline-block inside a plain span
wrapper, so it baseline-aligns within the wrapper's inherited line box and
lands near the baseline instead of at the wrapper's top. mt-1.5 only offset
the wrapper, not the dot inside it. The wrapper is now display:flex, which
blockifies the dot into a flex item pinned at the wrapper's top so mt-1.5
sets a true top offset. Measured after the fix: dot center 25px vs caret
center 25px vs title text center 24.5px. Applied identically to the
repository-scoped and aggregate Needs attention rows.

## Validation

- `pnpm test`: 28+ files, 524 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- Live render check of the exact markup plus dist/app.css in a browser.

## Protocol bookkeeping

- Added BBF-0046 to the factory queue with the recorded `approved:` line.
- Updated `plans/factory/current.md` and the dashboard row in
  `plans/README.md`.
- Immutable prior run records were not changed.
