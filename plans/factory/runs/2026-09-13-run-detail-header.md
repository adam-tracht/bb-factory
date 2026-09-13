# Run record: run detail header declutter and visible thread button

- Date: 2026-09-13
- Thread: this interactive session (acp-devin)
- Tasks attempted: BBF-0026 (run detail header declutter and visible thread button)

## Outcome

- BBF-0026: done. User reported on a live screenshot that the run detail
  header carried too much chrome: a full copyable run id (already
  available under Technical details) and an "Open thread" ghost link
  that read as metadata text despite being the page's primary action.
- The header no longer renders the run id; it stays reachable in
  Technical details. "Open thread" is now a bordered secondary button
  at default size, pinned to the header's right edge with `ml-auto`.
- Attempt-row "Thread" controls intentionally keep the ghost treatment:
  they are secondary affordances inside the collapsible Attempts
  section.

## Validation

- `pnpm test`: 27 files, 329 passing (+1 new regression test)
- `pnpm typecheck`, `pnpm lint`: clean
- `git diff --check`: clean

## Workers used

- None; a one-file fix plus bookkeeping, done inline.

state: success
