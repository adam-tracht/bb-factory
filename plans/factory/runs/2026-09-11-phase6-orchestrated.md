# Orchestrated session: Phase 6 quickstart build

Date: 2026-09-11
Driver: human-directed interactive session (not an unattended foreman run)

## Scope

BBF-0001 through BBF-0006, claimed from `status: ready` entries authorized in
commit 7dab733. Work was delegated to implementation workers and reviewed
before each commit; commits landed on `factory` and pushed to `origin/factory`.

## Landed

- c424b02 BBF-0001 unmanaged-workspace spawn contract
- 9ad9000 BBF-0002 protocol scaffolder
- 0535bbd BBF-0003 dedicated checkout provisioning
- d7dfbca BBF-0004 quickstart add-repository flow
- 209271b BBF-0005 registry-first discovery gating
- 7d4902f BBF-0006 release hygiene

## Live acceptance findings (fixed in this session)

- `bb plugin reload` failed with `FOREIGN KEY constraint failed`: table-rebuild
  migrations dropped `operational_runs` while child rows referenced it.
  Fixed in cd0adde by pausing `foreign_keys` around the migration window.
- The wizard's provision step failed with `HTTP 409: terminal output is
  unavailable because the session is not running`: the host serves terminal
  output only while the session runs, so fast git commands lost their output.
  Fixed in bced819 by redirecting command output to a per-run temp file read
  back through the durable files API and removed after.

## Wizard verification (live, human-driven)

Native folder pick, derived-values review, worktree provisioning, the
branch-in-use offer, existing-checkout fallback, and paused registration were
all exercised against the real host on `/Users/adamtracht/Desktop/Code/bb-factory`
and behaved as designed. The already-registered repository resolved as a
no-op duplicate.

## Open

- BBF-0007 marketplace listing remains Active and requires an explicit
  `approved:` line before tag, publish, or marketplace PR actions.
- BBF-0008 rollout gate is unchanged (always-on host, remote Connect owner
  route, live run_detail).

state: success
