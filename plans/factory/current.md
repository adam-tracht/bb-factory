# Current factory run

The 2026-09-13 interactive session completed BBF-0026, BBF-0027, and
BBF-0028. BBF-0026 dropped the redundant copyable run id from the run
detail header (still in Technical details) and made "Open thread" a
bordered button instead of a ghost link. BBF-0027 and BBF-0028 shrank
label radii twice under user direction: every text chip went
`rounded-full` to `rounded-md` to bare `rounded`, matching the mono id
chips. Details in runs/2026-09-13-run-detail-header.md and
runs/2026-09-13-label-radii.md.

Open work:

- BBF-0007 marketplace listing is Active but requires an explicit
  `approved:` line before any tag, publish, or marketplace submission.
- BBF-0008 rollout gate is Blocked on the always-on host, remote Connect
  owner-session route, and live run_detail path (docs/hosting-decision.md).

state: success
