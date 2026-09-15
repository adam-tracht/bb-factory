# Factory run record: BBF-0043, BBF-0044, BBF-0045 provider and model selection

date: 2026-09-15
state: success
tasks: BBF-0043, BBF-0044, BBF-0045
branch: factory
commits: eb7672a, 049fd31, a57367d
push: origin/factory
workers: acp-devin / swe-2-max (implementation xhigh, reviews medium) per user direction overriding the repo.md worker table

## Preflight

Clean tree, no live lock. `git fetch origin` ran; `git rebase origin/main` was
skipped because this repository's main is a synthetic release branch (each
main commit is a commit-tree of factory minus plans/ plus dist/), so the
rebase can only conflict and main never carries source changes factory lacks.
Filed as assumption Q3 in questions.md.

## Tasks

- BBF-0043 run-now picker: run-now action gained optional
  providerId/model/reasoningLevel/serviceTier (all-or-none triple); the
  confirm dialog embeds ProviderModelPicker behind an Automatic (default, no
  override) vs custom radio so alternate rotation survives the just-confirm
  path; explicit picks face the same usability gate and error rather than
  substitute; spawns mark caller-picked inputs explicit. First worker pass
  always sent the seeded triple; a fix round made the override opt-in.
- BBF-0044 per-provider defaults: providerModelDefaults keyed map persisted
  as a JSON string through a settings descriptor; applied post-usability in
  selectProvider for pinned and alternate picks; pinned-provider Settings
  row uses a provider-locked ProviderModelPicker with a text/select fallback.
  Review caught an invisible-error Save block, an "unavailable" sentinel
  leaking into the bound picker, and dotted-path field errors missing the
  field map; all fixed.
- BBF-0045 rotation list: providerRotation (2-5 unique ids) drives the
  alternate path, skips unusable/unreported members, and falls back outside
  the list on exhaustion; Settings shows an ordered editor under alternate.
  Nit round extracted shared jsonSettingValueSchema/jsonSettingSchema and
  hasFullPermission helpers.

## Validation

Every queue-listed command plus the repo standard checks ran green at each
task boundary: 484 tests (0043), 507 (0044), 524 (0045), typecheck, lint,
build, `bb plugin types --check .` (0.4.87), `git diff --check`.

## Notes for the next foreman

- swe-2-max was used for workers and reviewers this run at the user's
  direction; the repo.md worker table still lists Luna/Sol.
- BBF-0039's code-quality review and live visual validation remain deferred
  by the user (see its queue entry and dashboard row).
- The providerModelDefaults/providerRotation settings persist as JSON
  strings through multiline descriptors; a third structured setting should
  reuse the jsonSetting factories, not copy them.
