# Run record: label radius pass (rounded-full → rounded-md → rounded)

- Date: 2026-09-13
- Thread: this interactive session (acp-devin)
- Tasks attempted: BBF-0027 (remaining labels keep pill radii on phone
  widths), BBF-0028 (labels still read as round on small screens)

## Outcome

- BBF-0027: done, then superseded same-day. Moved every remaining
  text-bearing chip from `rounded-full` to `rounded-md`: `StateChip`,
  the `Section` count bubble, the tab count badges, and the
  Recorded/Answered chips in `questions.ts`.
- BBF-0028: done. `rounded-md` still read as round on small screens
  and tall labels, so all text labels including `Badge` moved to bare
  `rounded`, the radius the mono id chips already used.
- Left `rounded-full` where it is geometric, not a label: `StatusDot`
  and the fixed-square help "?" icon button. Controls keep
  `rounded-md`, cards keep `rounded-lg`.
- Applied globally rather than behind an `sm:` breakpoint so desktop
  stays consistent.

## Validation

- `pnpm test`: 27 files, 331 passing (+1 new regression test)
- `pnpm typecheck`, `pnpm lint`: clean
- `git diff --check`: clean

## Workers used

- None; class-only edits plus one regression test, done inline.

state: success
