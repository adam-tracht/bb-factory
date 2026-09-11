# Orchestrated session: live-UI defect fixes

Date: 2026-09-11
Driver: human-directed interactive session (not an unattended foreman run)

## Scope

BBF-0009, BBF-0010, BBF-0011: three defects reported from live use of the
Factory view against the diggs-data-platform repository. The user
authorized the entries by flipping them to `status: ready`. Work was
delegated to three parallel workers with disjoint file ownership and
reviewed before each commit; commits landed on `factory` and were pushed.

## Landed

- 5d274cc BBF-0009 question deep links: anchors ride as `section/<anchor>`
  path segments; the parser decodes once and rescues legacy
  `questions%23...` and literal-`#` forms. New coverage in
  tests/ui-routes.test.ts.
- 10ca0f9 BBF-0010 refresh indicator: raw U+21BB replaced by an inline SVG
  icon in currentColor.
- (this commit) BBF-0011 gated-ready rows: badge folds open-question gating
  into blocked-by treatment, Answer CTA wins over Approve, and the detail
  composer hides while gated.

## Findings

- BBF-0012 filed during review: `approve-queue` on an already-ready entry
  is a dead end (conflict at repository.ts:90-95 before the question
  guard), while the reader still emits `missing-authorization` for
  unapproved ready entries, so the UI offers an Approve that always fails.

## Validation

289 tests, typecheck, lint, and build pass on `factory`.

state: success
