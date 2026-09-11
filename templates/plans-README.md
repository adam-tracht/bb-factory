# Repository work dashboard

This table is the sole canonical dashboard for durable plan state. Each row links to its implementation source or canonical acceptance tracker. Status values are `Active`, `Blocked`, `Deferred`, `Needs Review`, and `Done`.
Implementation evidence is separate from rollout, cutover, production acceptance, and optional enhancement work. Source or Git evidence does not prove deployment.

## Factory

Unattended factory runs work on the `factory` branch and take tasks only from `plans/factory/queue.md`. Each run records results in `plans/factory/current.md` and `plans/factory/runs/`, and files open questions in `plans/factory/questions.md`. The run protocol is in `plans/factory/foreman.md`; repo-specific checks and limits are in `plans/factory/repo.md`.

## Tracked implementation and review

| ID | Work item | Status | Next action or remaining outcome | Evidence and canonical detail |
|---|---|---|---|---|
