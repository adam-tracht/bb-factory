# Run record: provider preference accepts any reported provider

- Date: 2026-09-12
- Thread: this interactive session (thr_jviq88fvh7, acp-devin foreman)
- Tasks attempted: BBF-0023 (provider preference accepts any reported provider)

## Outcome

- BBF-0023: done (d721ff8). `providerPreference` is now `alternate` or any
  providerId end to end; `selectProvider` treats every host-reported provider
  as a candidate (catalog order), rotates `alternate` cyclically past
  unusable providers, and falls back from a pinned-but-unusable pick.
  Usable additionally requires `full` permission support when the host
  reports `capabilities.permissionModes`, which is now carried on
  `ProviderStatus`. The Settings dropdown lists the full host catalog with
  availability (and marks providers lacking full permission), the BB
  settings descriptor became a validated string, and repo.md codifies the
  codex model column for foremen on other providers.
- Contract note: providerPreferenceSchema widened from a fixed enum and
  providerStatusSchema gained an optional field; both changes are backward
  compatible and were reviewed in-thread before filing, per the frozen
  contract rule.
- Workers: one Luna xhigh implementation thread (thr_xvg3pchzv8), then two
  Sol Medium review threads (compliance thr_xe629ic6ge COMPLIANT, quality
  thr_9gf426crmi MINOR). The seven MINOR findings were fixed in-session:
  descriptor schema validation, live-health permissionModes propagation
  test, unusable-lastStart rotation coverage, ring-scan simplification,
  honest `fallback, <id> unusable` reason, dropdown marking for providers
  without full permission, and the repo.md worker-model gap.

## Validation

- `pnpm test`: 27 files, 320 passing (worker added 10, foreman added 2)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean
- `bb plugin types --check .`: pass (pin 0.4.84 matches host)
- `git diff --check`: clean

## Workers used

- Implementation: codex / gpt-5.6-luna xhigh, ~12 min
- Reviews: codex / gpt-5.6-sol medium x2, ~5 min each

state: success
