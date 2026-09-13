# Run record: approve composer drafts scope and explains the ask

- Date: 2026-09-12
- Thread: this interactive session (thr_m55bq4jmcb, acp-devin foreman)
- Tasks attempted: BBF-0025 (approve composer drafts scope and explains the ask)

## Outcome

- BBF-0025: done. The Approve composer asked the operator for a free-text
  approval scope with no explanation even though the queue entry already
  carries plan, risk, and acceptance, and there was no agent-assist path
  like the questions flow's "Ask an agent".
- New advisory action `recommend-approval` (additive to the frozen v1.2
  contract, reviewed in-thread before filing): same seam as
  `recommend-question`, spawns a thread in the repository environment that
  drafts an `approved:` line from the entry's id, title, status, risk,
  plan, acceptance, validate commands, notes, and the canonical
  gated-action list. Advisory only; the operator still records the line.
- The composer now shows the entry's risk and the gated-action list above
  the textarea, a "Draft with agent" button opens the provider picker
  (shared `providerPicker.ts`, extracted from questions.ts), and "Routine
  scope only" presets a conservative line behind the same confirm dialog.
- Storage v5 migration admits the new action kind and the queue-item
  intent target; a confirmed latent bug is fixed: bb-interaction claims
  without `expectedRevision` (sent whenever the snapshot is unavailable,
  e.g. malformed protocol) previously threw at claim, and now normalize
  to the empty revision sentinel in both stored request and column.
- Copy correction: approval is required for every ready entry
  (`missing-authorization` fires whenever `approved:` is absent), so the
  explainer no longer calls it optional for low/medium risk.

## Reviews

- Spec compliance (Sol medium, thr_gd8vjg633f): NON-COMPLIANT on first
  pass, three findings — two wording nits resolved by standardizing on the
  foreman.md canonical gated-action list, and a missing
  idempotency-conflict test that was added.
- Code quality (Sol medium, thr_qggbzxrc28): four findings — one HIGH was
  rejected on verification (approve-queue writes approval for
  ready+unauthorized rows, repository.ts:90-108); the expectedRevision
  claim bug, the inaccurate "optional" copy, and the duplicated picker
  helpers were all fixed.

## Validation

- `pnpm test`: 27 files, 328 passing (+8)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean
- `bb plugin types --check .`: pass (pin 0.4.84 matches host)
- `git diff --check`: clean

## Workers used

- Implementation: codex / gpt-5.6-luna xhigh (thr_fi6htaqh8r), ~35 min
  including the fix pass
- Reviews: codex / gpt-5.6-sol medium x2 (thr_gd8vjg633f compliance,
  thr_qggbzxrc28 quality)

state: success
