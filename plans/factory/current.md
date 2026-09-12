# Current factory run

The 2026-09-12 orchestrated session completed BBF-0023: the factory run
provider preference now accepts `alternate` or any provider id the host
reports (pi, acp-*, etc.), the Settings dropdown lists the whole host
catalog, and `alternate` rotates deterministically across all usable
providers instead of only codex and claude-code. Providers that report
permission modes must support `full` to be dispatch-eligible. Details in
runs/2026-09-12-provider-catalog-preference.md.

Open work:

- BBF-0007 marketplace listing is Active but requires an explicit
  `approved:` line before any tag, publish, or marketplace submission.
- BBF-0008 rollout gate is Blocked on the always-on host, remote Connect
  owner-session route, and live run_detail path (docs/hosting-decision.md).

state: success
