# Factory run record: BBF-0039 repository display names

date: 2026-09-14
state: success
task: BBF-0039
branch: factory
commit: none (direct human instruction)
push: none (direct human instruction)
workers: none (direct human instruction)

## Scope

Implemented the approved repository display-name feature. Optional displayName
metadata is stored on the repository registry entry, outside
RepositoryConfiguration. repositoryKey remains the sole operational identity.
Existing add and update settings mutations carry the display name, including
trimmed validation, clear semantics, preservation of unrelated fields, and no
new RPC or migration.

Visible shell, landing, aggregate, empty-state, confirmation, Add repository,
and Settings surfaces use the centralized display-name fallback. Routes, ids,
storage keys, actions, RPC inputs, and technical details retain raw keys.
Focused regression coverage and README/control-surface documentation were
augmented.

## Validation

- `pnpm test`: 28 files, 465 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- `bb plugin types --check .`: passed, host/package 0.4.87.
- `git diff --check`: passed.

## Protocol bookkeeping

- Added BBF-0039 to the factory queue and recorded the exact line:
  `approved: direct human request and approved plan authorize this customer-facing change`.
- Updated mutable `plans/factory/current.md` and the dashboard row in
  `plans/README.md`.
- Immutable prior run records were not changed.
- No child workers, commit, push, or pull request were used.
