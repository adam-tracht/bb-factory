# Factory repo rules

## Standard checks

Run from the repo root. All are required for every task unless noted. Replace the placeholder commands and record the measured results when the protocol is scaffolded.

| Check | Command | Result on `factory` at scaffold time |
|---|---|---|
| Tests | `<test command>` | <result> |
| Typecheck | `<typecheck command>` | <result> |
| Lint | `<lint command>` | <result> |

## Repo-specific limits

- Never push to `main` and never commit on `main`. Factory work lives on the `factory` branch only.
- Never add or upgrade dependencies without an `approved:` queue line.

## Worker models

| Job type | If foreman is codex | If foreman is claude-code |
|---|---|---|
| Implementation, debugging | gpt-5.6-luna, reasoning xhigh | claude-opus-5[1m], reasoning high |
| Tests, docs, mechanical edits | gpt-5.4-mini, reasoning medium | claude-sonnet-5, reasoning medium |

A foreman on any other provider (pi, acp-*, or future ids) uses the codex column by default.

`--reasoning-level` accepts `low`, `medium`, `high`, `xhigh`, `max`.

## Tracking rules

`plans/README.md` is the canonical dashboard for durable plan state.

1. IDs are `<PREFIX>-NNNN`, assigned once, never renumbered, reused, or encoded with status, owner, or year.
2. One row per work item; every distinct repository work item appears exactly once.
3. Status is one of `Active`, `Blocked`, `Deferred`, `Needs Review`, `Done`; every open item has a concrete next action.
4. `Done` requires evidence.
5. Validate ID uniqueness, links, and anchors before committing; never create a parallel status register or `future-work.md`.
