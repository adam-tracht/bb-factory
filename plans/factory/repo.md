# Factory repo rules: bb-factory

## Standard checks

Run from the repo root via the `pnpm` script wrappers. pnpm here is pinned to Node 20; invoking node_modules binaries directly under the machine-default Node 24 fails on the better-sqlite3 native module (per CLAUDE.md), so the wrappers are the correct commands in this repository. All are required for every task unless noted.

| Check | Command | Result on `factory` at scaffold time |
|---|---|---|
| Tests | `pnpm test` | Pass (22 files, 194 tests, 0 skipped) |
| Typecheck | `pnpm typecheck` | Pass (0 errors) |
| Lint | `pnpm lint` | Pass (0 errors, 0 warnings) |
| Build | `pnpm build` (runs `bb plugin build .`) | Pass (emits dist/server.js, dist/app.js, dist/app.css, and meta files) |
| SDK type freshness | `bb plugin types --check .` | Pass (@get-bb/plugin-sdk pin 0.4.47 matches host 0.4.47) |
| Whitespace | `git diff --check` | Pass |

Results measured on 2026-09-11 at scaffold time.

## Repo-specific limits

- Never push to `main` and never commit on `main`. Factory work lives on the `factory` branch only.
- Never add or upgrade dependencies without an `approved:` queue line.
- BB plugin installs use `npm`; `pnpm` is the local development manager only and must never be described as the BB installation mechanism.
- Files under `plans/factory/` are authoritative protocol state; plugin SQLite must never mirror queue or question state.
- Unknown queue statuses must keep rendering tolerantly; a read never fails on an unrecognized status string.

## Worker models

| Job type | If foreman is codex | If foreman is claude-code |
|---|---|---|
| Implementation, debugging | gpt-5.6-luna, reasoning xhigh | claude-opus-5[1m], reasoning high |
| Tests, docs, mechanical edits | gpt-5.4-mini, reasoning medium | claude-sonnet-5, reasoning medium |

`--reasoning-level` accepts `low`, `medium`, `high`, `xhigh`, `max`.

Task reviews run as separate Sol Medium threads (compliance, then code quality) per PLAN.md's execution model.

## Tracking rules

`plans/README.md` is the canonical dashboard for durable plan state.

1. IDs are `BBF-NNNN`, assigned once, never renumbered, reused, or encoded with status, owner, or year.
2. One row per work item; every distinct repository work item appears exactly once.
3. Status is one of `Active`, `Blocked`, `Deferred`, `Needs Review`, `Done`; every open item has a concrete next action.
4. `Done` requires evidence.
5. Validate ID uniqueness, links, and anchors before committing; never create a parallel status register or `future-work.md`.
