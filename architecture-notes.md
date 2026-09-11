# BB Factory Architecture Notes

*Planning input, superseded by [PLAN.md](PLAN.md) and `docs/`; kept for the
guardrail and cutover rationale. Phase numbering here predates the final
plan.*

Planning input for downstream phases. Phase 0 bootstrap is frozen in [docs/phase-0-contract.md](docs/phase-0-contract.md). This document defines boundaries and a phased migration plan. It does not authorize downstream implementation, repository policy changes, commits, or remote publishing.

## Architecture decision

Build BB Factory as a thin, purpose-built BB plugin over each repository’s existing factory files. The plugin replaces the shell dispatcher and presents native **Overview**, **Queue**, **Questions**, **Runs**, and **Settings** views. It must not create another task system, dashboard, or policy source.

### Settings, protocol, and code boundary

- **Plugin settings** select operational facts: repository, connected host, checkout path, schedule, execution profile, concurrency limit, and whether dispatch is enabled.
- **Repository protocol files** remain the source of business and workflow policy. The plugin reads `plans/factory/`, applies repository-specific `repo.md` rules, and preserves existing queue, question, recovery, and integration conventions.
- **Plugin code** enforces mechanisms that cannot safely rely on prose: exclusive dispatch ownership, authorization provenance, serialized writes, stale-content checks, host availability, and safe start/stop behavior.
- Do not invent a generic policy language. The two repositories already express meaningful differences in readable Markdown.

### Repo-backed state and writes

The repository remains canonical:

- `plans/README.md` is the canonical dashboard.
- Existing queue and question files remain canonical work state.
- Repository protocol files remain canonical policy.
- Git history remains the durable audit trail.

The plugin may parse these files into UI models and write back narrowly. Every write should target the connected host checkout, verify the expected prior content or revision, preserve unrelated text, and fail clearly on conflicts. Preserve existing commit boundaries, including separate claim commits where required and repository-specific completion behavior.

Run records may live in plugin-local storage because they describe plugin execution, not project work. Store only operational metadata such as run ID, owner, timestamps, trigger, result, and links to the associated BB thread and repository revision. Do not mirror task status there.

### Scheduling and host limits

Use one scheduler owned by the plugin. BB cron schedules persist across server restarts but run only while the plugin is loaded and use server-local time. Treat scheduling as at-least-once, not exactly-once. Ownership and idempotency must make duplicate wakeups harmless.

Before dispatch, verify that the configured connected host is online and the checkout exists. Some data-platform work also requires host-local browser and dbt Studio access. The plugin should report these constraints prerequisites rather than imply that moving the scheduler removed the Mac dependency.

### Dispatch ownership and cutover

A single durable ownership record must be acquired before any repository mutation or worker spawn. State transitions must be serialized. Ownership includes repository, queue item, run, worker thread, lease timestamp, and authorization provenance.

Do not clear ownership merely because cancellation was requested. Confirm worker termination or mark the run as requiring reconciliation. Recovery must inspect both repository state and worker state before requeueing.

Cutover sequence:

1. Disable every legacy dispatcher trigger.
2. Snapshot and reconcile current dispatcher state, live workers, queue claims, and repository revisions.
3. Drain or explicitly adopt each live run.
4. Confirm no legacy process can dispatch.
5. Enable the plugin scheduler for one repository first.
6. Verify one complete dispatch and recovery cycle.
7. Enable remaining repositories individually.

Rollback disables plugin dispatch before restoring a legacy trigger. Never allow both owners concurrently.

### Authorization and repository policies

Preserve human-only authorization for an item’s first transition to ready. Record where that authorization came from. Agent recovery may requeue only where the repository protocol explicitly permits it.

Do not normalize repository integration rules:

- Monorepo restrictions on pushing main, deployment, and live migrations remain unchanged.
- Data-platform dbt integration through main retains its immediate build, warehouse verification, and corrective-commit requirements.
- Data-platform non-dbt integration remains human-owned.

The UI should explain the active repository rule at the action point. It must not silently broaden permissions or change main-branch policy.

## Phased plan

### Phase 1: Contract and read-only UI

Define parsed models for repository protocol, queue, questions, dashboard, and run ownership. Add repository and host settings. Build read-only Overview, Queue, Questions, Runs, and Settings views. Validate both repositories without writing files or scheduling work.

### Phase 2: Guarded repository actions

Add narrow queue and question actions using revision checks, authorization provenance, and repository-specific rules. Keep `plans/README.md` canonical. Reject ambiguous or stale writes instead of attempting merges.

### Phase 3: Exclusive dispatch engine

Add durable ownership, serialized transitions, host preflight, worker lifecycle tracking, recovery, and plugin scheduling. Exercise duplicate wakeups, unavailable hosts, stale checkouts, and interrupted workers with a small focused test set.

### Phase 4: Controlled cutover

Perform the cutover sequence repository by repository. Start with the simpler protocol. Observe one successful cycle and one recovery path before expanding. Keep rollback documented and mutually exclusive with plugin dispatch.

### Phase 5: Remove legacy dispatcher

After stable operation, remove obsolete dispatcher scheduling and code paths while retaining only migration-relevant documentation. Do not remove repository protocol files or canonical dashboards.

## Complexity guardrails

**Necessary:** exclusive ownership, guarded writes, authorization provenance, host checks, repository-specific policy, recovery reconciliation, concise operational run history.

**Unnecessary:** duplicate task storage, duplicate dashboards, simultaneous schedulers, distributed consensus for a single-host deployment, a general workflow engine, a policy DSL, broad file rewriting, automatic main-policy changes, or exhaustive test matrices.
