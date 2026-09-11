# Run record: stale question gates

- Date: 2026-09-11
- Thread: this interactive session (root)
- Tasks attempted: BBF-0014 (badge drops question id), BBF-0015 (stale question gates strand blocked entries)

## Outcome

- BBF-0014: done. `queueStatusLabel` renders `Blocked by Q<n>: <detail>` so the question id survives alongside the detail text.
- BBF-0015: done. The reader now emits `staleBlockingQuestionIds` plus a `stale-question-gate` eligibility reason when a `blocked-by` status names a question that is answered or missing. Work rows put stale-gated entries in Needs you with a `Review Q<n>` CTA that opens the question card; the expanded detail keeps the reference reachable and prints "Gating question is answered or missing". The attention model raises an action item so the Work tab badge counts them. `templates/foreman.md` (and this repo's `plans/factory/foreman.md`) now instruct foremen to re-file leftover human work as a new blocking question rather than leaving an entry gated on a question they just answered. `templates/MANIFEST.json` re-hashed.

## Data fix (diggs-data-platform)

- `diggs-data-platform-factory` commit `acc6097` on `factory`: Q6's answer now notes the remainder was re-filed; new `Q18` carries the GA4-to-BigQuery pipe creation; `DATA-0007.04` re-pointed to `blocked-by: Q18`. The entry now lands in Needs you with an Answer CTA.

## Validation

- `pnpm test`: 293 passing (new coverage: reader stale-gate test, Work needs-you/Review-CTA test, detail reachability test)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean

## Workers used

- None; implemented inline (small coherent change across reader, contracts, two UI surfaces, and the foreman template).

state: success
