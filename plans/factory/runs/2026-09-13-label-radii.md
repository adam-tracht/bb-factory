# Run record: remaining labels keep pill radii on phone widths

- Date: 2026-09-13
- Thread: this interactive session (acp-devin)
- Tasks attempted: BBF-0027 (remaining labels keep pill radii on phone widths)

## Outcome

- BBF-0027: done. User direction: labels need smaller border radii on
  mobile. The phone-width pass (6025521) had already converted `Badge`
  to `rounded-md`; this change finishes the job for every remaining
  text-bearing chip.
- Moved to `rounded-md`: `StateChip` (the Dispatch on/paused pill),
  the `Section` count bubble, the tab count badges in the shell, and
  the Recorded/Answered chips in `questions.ts`.
- Left `rounded-full` where it is geometric, not a label: `StatusDot`
  and the fixed-square help "?" icon button.
- Applied globally rather than behind an `sm:` breakpoint so desktop
  stays consistent with the already-square badges.

## Validation

- `pnpm test`: 27 files, 331 passing (+1 new regression test)
- `pnpm typecheck`, `pnpm lint`: clean
- `git diff --check`: clean

## Workers used

- None; class-only edits plus one regression test, done inline.

state: success
