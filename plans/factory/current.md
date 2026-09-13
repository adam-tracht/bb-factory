# Current factory run

The 2026-09-12 interactive session completed BBF-0024: blocking questions
filed with several dashboard ids in the one-token heading slot
(`Q14 ... DATA-0064 and DATA-0009.01` in diggs-data-platform,
`Q15 ... MON-0080.06 and MON-0080.08 through MON-0080.13` in monorepo) threw
malformed-protocol and degraded each repository's whole read. Both
questions.md files were fixed on `factory`, the malformed-heading error now
names the expected shape, and the templates document the one-id rule and
the lead-id-plus-`blocked-by` pattern for multi-gate questions. Details in
runs/2026-09-12-multi-id-question-headings.md.

Open work:

- BBF-0007 marketplace listing is Active but requires an explicit
  `approved:` line before any tag, publish, or marketplace submission.
- BBF-0008 rollout gate is Blocked on the always-on host, remote Connect
  owner-session route, and live run_detail path (docs/hosting-decision.md).

state: success
