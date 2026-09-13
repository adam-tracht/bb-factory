# Current factory run

The 2026-09-12 interactive session completed BBF-0024 and BBF-0025.
BBF-0024 fixed malformed multi-id question headings in both managed
repositories and hardened the authoring docs and error message. BBF-0025
gave the Approve composer an explainer, a "Draft with agent" advisory
spawn (new `recommend-approval` action, additive to the v1.2 contract),
and a "Routine scope only" preset, plus a storage fix for claims without
`expectedRevision`. Details in runs/2026-09-12-multi-id-question-headings.md
and runs/2026-09-12-approve-composer.md.

Open work:

- BBF-0007 marketplace listing is Active but requires an explicit
  `approved:` line before any tag, publish, or marketplace submission.
- BBF-0008 rollout gate is Blocked on the always-on host, remote Connect
  owner-session route, and live run_detail path (docs/hosting-decision.md).

state: success
