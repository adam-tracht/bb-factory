# Current factory run

The 2026-09-11 orchestrated session completed BBF-0009, BBF-0010, and
BBF-0011, the three live-UI defects reported from diggs-data-platform
(see runs/2026-09-11-ui-defects-orchestrated.md), plus BBF-0013 which
made `status: draft` a first-class quiet status. A follow-on session
completed BBF-0014 and BBF-0015, which keep question references visible
on blocked entries and flag `blocked-by` gates whose question resolved
or vanished as `stale-question-gate` so they land in Needs you instead
of stranding, and BBF-0016 through BBF-0019, four live-UI fixes
(switcher All state, landing-card navigation, run-detail thread links,
and a collapsed Repository details disclosure in Settings). All are Done
on the canonical dashboard; see runs/2026-09-11-stale-question-gates.md.

Open work:

- BBF-0007 marketplace listing is Active but requires an explicit
  `approved:` line before any tag, publish, or marketplace submission.
- BBF-0008 rollout gate is Blocked on the always-on host, remote Connect
  owner-session route, and live run_detail path (docs/hosting-decision.md).
- BBF-0012 approve-on-ready dead end is filed as a draft pending
  authorization.

state: success
