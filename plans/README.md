# Repository work dashboard

This table is the sole canonical dashboard for durable plan state. Each row links to its implementation source or canonical acceptance tracker. Status values are `Active`, `Blocked`, `Deferred`, `Needs Review`, and `Done`.
Implementation evidence is separate from rollout, cutover, production acceptance, and optional enhancement work. Source or Git evidence does not prove deployment.

## Factory

Unattended factory runs work on the `factory` branch and take tasks only from `plans/factory/queue.md`. Each run records results in `plans/factory/current.md` and `plans/factory/runs/`, and files open questions in `plans/factory/questions.md`. The run protocol is in `plans/factory/foreman.md`; repo-specific checks and limits are in `plans/factory/repo.md`.

## Tracked implementation and review

| ID | Work item | Status | Next action or remaining outcome | Evidence and canonical detail |
|---|---|---|---|---|
| BBF-0001 | [Spawn contract and registry schema](./factory/queue.md#bbf-0001-spawn-contract-and-registry-schema) | Done | None. | `environmentId` is optional across registry, add-input, and dispatch; [`spawnEnvironment`](../src/dispatch/types.ts) reuses a pinned env or spawns an unmanaged host workspace and records the auto-registered env id; storage CHECK relaxed via rebuild migration; 202 tests, typecheck, and lint pass. |
| BBF-0002 | [Protocol scaffolder](./factory/queue.md#bbf-0002-protocol-scaffolder) | Active | Eligible for an unattended run once dependencies are satisfied. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 2. |
| BBF-0003 | [Dedicated checkout provisioning](./factory/queue.md#bbf-0003-dedicated-checkout-provisioning) | Active | Eligible for an unattended run once dependencies are satisfied. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 3. |
| BBF-0004 | [Quickstart add-repository flow](./factory/queue.md#bbf-0004-quickstart-add-repository-flow) | Active | Eligible for an unattended run once dependencies are satisfied. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 4. |
| BBF-0005 | [Registry-first discovery gating](./factory/queue.md#bbf-0005-registry-first-discovery-gating) | Active | Eligible for an unattended run once dependencies are satisfied. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 5. |
| BBF-0006 | [Release hygiene](./factory/queue.md#bbf-0006-release-hygiene) | Active | Eligible for an unattended run once dependencies are satisfied. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 6. |
| BBF-0007 | [Marketplace listing](./factory/queue.md#bbf-0007-marketplace-listing) | Active | Eligible once dependencies are satisfied; `risk: high` also needs an `approved:` line for publish actions or a run skips it. | Scope and acceptance are in [PLAN.md](../PLAN.md) Phase 6, deliverable 7. |
| BBF-0008 | Phase 1 rollout gate and hosting decision | Blocked | Verify always-on host, remote Connect owner-session route, and live run_detail path per docs/hosting-decision.md. | Human-gated, no queue entry; gate detail is in [docs/phase-1-acceptance.md](../docs/phase-1-acceptance.md) and [docs/hosting-decision.md](../docs/hosting-decision.md). |
