# BB Factory implementation plan

## Current execution model override

For the currently authorized Phase 0 bootstrap, the implementation worker is Luna Extra High and the two reviews are separate Sol Medium passes, compliance first and code quality second. Root coordinates the reviews and freezes the phase only after both pass. This is the current implementation and review model for downstream task work as well, without authorizing downstream implementation.

## 1. Purpose and current state

`bb-factory` began as a planning-only repository; it is now a shipped public plugin at `v0.1.0`, installable via `bb plugin install git:github.com/adam-tracht/bb-factory`. The Phase 0 bootstrap is frozen at contract `v1.2`. Phases 1 through 6 are implemented: the control surface, guarded actions, the dispatch engine (dispatch stays `paused` until the hosting gate closes), the quickstart add-repository wizard, protocol scaffolding, and dedicated-worktree provisioning. The separate rollout gate remains open for an always-on non-personal host, the remote Connect route, and a live run-detail path. The active factory is still the shell tooling under `~/.bb/factory/`: `dispatch.sh`, `redeploy.sh`, `merge-state.sh`, and `templates/foreman.md`. The plugin described here replaces the dispatcher and adds a native BB control surface without replacing the repository factory protocol.

### Phase 0 checkpoint

Phase 0 is complete and frozen at contract `v1.2`. Implementation thread `thr_za7y2tw5vq` passed separate Sol Medium compliance review `thr_xrnpijf4nt` and code-quality review `thr_84bhqsym63`. The approved v1.1 interaction amendment passed compliance review `thr_vme9e859th` and code-quality review `thr_5ei85kmian`; the approved v1.2 settings registry amendment passed the same reviews. Full validation on the final schema version passed typecheck, 10 tests, lint, SDK freshness, build, and diff checks. Interface-only health separation was rechecked with typecheck, lint, build, and diff.

Phase 1 checkpoint: operational storage passed compliance review `thr_xb9qqm6u9f` and code-quality review `thr_q2mvicbwdb`; the read-only UI passed compliance review `thr_939nn9nneh` and code-quality review `thr_t7zf4u47hr`. The protocol adapter, BB interaction reader, read integration, and product corrections passed their scoped reviews, with final product review `thr_pu2xm632jc`. Local acceptance passed on 2026-09-10 (record removed post-ship; see git history). The always-on hosting, remote Connect owner-session, and live `run_detail` limits remain separate rollout gates; the live detail route was not exercised because both run lists were empty, with unit coverage in place. Phases 2 through 5 remain open.

### Current status

- [x] Phase 0 contract and bootstrap complete, frozen at v1.2.
- [x] Phase 1 local read acceptance complete, covering both repositories, reload, all five UI surfaces, repository switching, settings, Done status, capability wording, canonical links, and the enabled, paused, no-service, no-schedule state. Evidence: acceptance pass of 2026-09-10 (record removed post-ship; see git history).
- [x] Phase 2 guarded actions implemented: repository question answers and queue `ready` approval under durable one-shot intents, BB interaction answers with the typed resolution state machine, and run controls (run now, pause, resume, retry, stop) routed through the action RPC. Guard details: [docs/action-implementation-gates.md](docs/action-implementation-gates.md).
- [x] Phase 3 dispatch engine implemented: host preflight, ownership leases, durable run intents, worker start and lifecycle reconciliation, runtime caps, cancellation, bounded retry, startup recovery, and the night-window scheduler with spacing and provider alternation. Dispatch remains `paused` until the hosting gate closes.
- [x] Phase 6 public quickstart and community distribution implemented: BBF-0001 through BBF-0006 are Done on the [dashboard](plans/README.md) (unmanaged-workspace spawn contract, protocol scaffolder, dedicated-checkout provisioning, quickstart wizard, registry-first gating, release hygiene). Verified live on the bb app; run record at [runs/2026-09-11-phase6-orchestrated.md](plans/factory/runs/2026-09-11-phase6-orchestrated.md).
- [ ] BBF-0007 marketplace listing: public repo and `v0.1.0` tag are in place; the marketplace fork/PR still needs an explicit `approved:` line on the queue entry.
- [ ] Phase 1 rollout gate: verify an approved always-on host, the remote Connect owner-session route, and a live `run_detail` path when a run exists. The hosting decision remains pending in [docs/hosting-decision.md](docs/hosting-decision.md).
- [ ] Phases 4 and 5 remain open: controlled cutover behind a disabled dispatch mode, then legacy shell removal after stable operation.

Hosting gate: [docs/hosting-decision.md](docs/hosting-decision.md) remains pending. No always-on non-personal BB server and execution host is verified, so dispatch remains disabled and no host is selected or provisioned. Data-platform work requiring Mac-local Aside/browser or dbt Studio remains gated; a general-work Linux pilot still requires separate approval and host preflight.

The implementation must preserve the behavior already encoded in the dispatcher and in the two managed repositories. Current behavior includes:

- One unattended foreman per repository during the night window, working on `factory`, never merging or switching to `main`.
- For each selected queue item: human authorization for its initial transition to `ready`, satisfied dependencies, and no open blocking question on that item before work can start.
- Repository-specific `plans/factory/foreman.md` and `repo.md` rules, queue entries, current state, immutable run records, questions, lock files, checks, dashboards, and integration policies.
- A runtime cap that defaults to 10,800 seconds, provider retry and failover behavior, and a default one-hour minimum gap between foreman starts. The spacing must be configurable, with the current one-hour behavior as the default and the rolling-hour safety guard preserved.
- Dispatcher state containing active thread and provider, start times, provider limits, last foreman state, failure and no-op counts, and the current night key. `noopCount` resets on a night-key change, not after a successful run.
- Foreman outcomes limited to `success`, `blocked`, `failed-safe`, and `no-op`.
- Merge reporting that compares `factory` with `origin/main`, identifies unmerged task commits, excludes claim, release, and run-record commits, and reports whether a safe fast-forward is possible.

The plugin must not silently correct existing shell inconsistencies. For example, the dispatcher header says it exits zero in all cases, while missing `REPO_KEY` or `jq` currently exits one. Such behavior is a migration input to record and either preserve or intentionally change at a documented acceptance gate.

## 2. Boundaries and source of truth

The first implementation checkpoint freezes these boundaries before parallel work begins:

- **BB core:** projects, environments, threads, messages, queued messages, pending interactions, provider state, and thread lifecycle.
- **Plugin:** factory dispatch policy, scheduling, run orchestration, operational state, and UI projections.
- **Repository:** business and workflow policy, queue and question state, canonical dashboard, current report, immutable run records, and Git audit history.
- **Plugin SQLite:** durable operational metadata only, such as run intents, dispatch attempts, ownership leases, idempotency keys, and links. It must not mirror task status or become a second queue/question database.
- **KV:** only small cursors and links, never durable queue or run state.
- **Secrets:** server-side settings only. Frontend settings expose no credentials or secret values.

The Work and Questions views read repository-backed `plans/factory/queue.md` and `questions.md`, plus BB pending interactions where applicable. They do not create independent plugin queue or question records. The plugin may keep an idempotency result for an answer or write operation, but the question itself remains in its authoritative source.

Repository writes are narrow, root-confined to the configured checkout, serialized, and compare-and-swap guarded. A stale or changed file is rejected with a conflict; the plugin must not overwrite unrelated text or attempt an implicit merge. Existing claim commits, completion commits, dashboard rows, and repository-specific integration rules remain intact.

The plugin provides Overview, Work, Questions, Runs, and Settings tab surfaces, plus a repositories landing view and an add-repository wizard. Overview may also be exposed as a small homepage section, but it must not replace BB's native homepage, header, side-panel chrome, thread behavior, navigation, or deletion confirmations.

## 3. Target module and ownership layout

Phase 0 established a small TypeScript package using `pnpm` for local development. BB Git installation remains an `npm` concern and must not be described as a pnpm installation path.

The following ownership boundaries prevent parallel edits from colliding:

- `src/protocol/`: repository discovery, root confinement, Markdown parsing, protocol models, queue eligibility, question extraction, dashboard and merge-state projection. Owned by the protocol adapter task.
- `src/storage/`: SQLite schema, append-only migrations, transactions, uniqueness constraints, and operational records. Owned by the state task.
- `src/dispatch/ownership.ts`, `preflight.ts`, and `start.ts`: ownership lease, host checks, provider selection, durable intent, and BB thread creation. Owned by the ownership and dispatch task.
- `src/dispatch/lifecycle.ts`, `recovery.ts`, `cancel.ts`, and `retry.ts`: worker lifecycle, reconciliation, cancellation, and bounded retry. Owned by the lifecycle and recovery task.
- `src/schedule/`: one plugin-owned scheduler, configured spacing and night-window behavior, duplicate wakeup handling, and pause behavior. Owned by the scheduling task, then integrated with dispatch only after the three contracts pass review.
- `src/ui/`: native plugin panels and action forms for the five tab surfaces plus the repositories landing and add-repository views. Owned by the UI task; it consumes typed projections and calls validated RPCs rather than reading files directly.
- `src/settings/`: declarative operational settings and server-side validation. Owned by the settings task.
- `src/lifecycle/`: startup reconciliation, reload disposal, and shutdown behavior. Owned by the dispatch/state integration task.
- `tests/`: focused parser, policy, idempotency, stale-write, scheduler, and recovery tests. Each task adds only tests that protect a stated behavior.
- `docs/`: migration and rollback instructions, hosting prerequisite, and operator runbook. Documentation is updated after implementation, not used as a second policy source.

No task may edit another task's owned module without first updating the interface contract. Reviews happen after each task: first protocol and acceptance compliance, then reuse, simplicity, and maintainability.

## 4. Phased implementation

### Phase 0: Interface contract and bootstrap

**Dependency:** none. This is sequential and blocks all implementation work.

**Deliverables:**

1. Freeze typed interfaces for repository configuration, protocol snapshots, queue entries, questions, dashboard summary, run intent, dispatch attempt, ownership lease, provider status, host preflight, and action results.
2. Define the plugin settings boundary: repository key and root, connected host, checkout path, schedule/night-window settings, runtime cap, provider preference or alternation, configurable spacing, concurrency limit, and dispatch enabled/paused state.
3. Decide how the current `templates/foreman.md` is made available to the plugin without changing its protocol text or silently creating a second version. Record its source and versioning rule.
4. Define RPC validation, error categories, idempotency-key shape, stale revision representation, and UI invalidation events. Realtime events are invalidation signals only; every client reloads durable state after a signal or reconnect.
5. Bootstrap the package, manifest, build/typecheck/lint commands, plugin entry point, and test runner. Keep the initial scaffold limited to the agreed interfaces and startup/shutdown skeleton.
6. Record one dependency map naming each task's owned paths, consumed interfaces, required predecessor review, and integration owner. Freeze the interfaces before parallel tasks start; interface changes return to this phase for review rather than crossing ownership boundaries informally.

**Ownership and agents:** first use one Luna Extra High task to verify BB extension points and draft the contract and minimal bootstrap. Then use one Sol Medium task to review scope, action wording, protocol-versus-setting boundaries, and dispatcher migration inputs. The phase owner incorporates that review and freezes the contract. No later task starts until both reviews pass.

### Phase 1: Protocol adapters and read-only surfaces

**Dependency:** Phase 0 interfaces.

Run these tasks in parallel with separate file ownership:

- **Luna Extra High, protocol adapter:** implement repository discovery and root confinement; parse both repositories' `plans/factory/` files; expose per-item queue eligibility, dependencies, item-level blocking questions, current state, immutable run records, dashboard rows, and merge-state projections. Preserve Markdown customizations rather than normalizing them into a generic policy language. Parse enough structure to explain why each item is or is not eligible, including authorization provenance when present. One blocked item must not prevent another eligible item from dispatching.
- **Luna Extra High, operational state:** implement SQLite initialization, append-only migrations, read models for run history and current ownership, and transaction helpers. Add uniqueness constraints for run creation, dispatch attempts, question answers, and repository writes. Do not persist queue or question copies.
- **Luna Extra High, UI:** implement read-only Overview, Queue, Questions, Runs, and Settings panels using typed projections. Overview shows repository health, current foreman state, spacing/window status, host prerequisites, and the canonical dashboard link. Runs link every execution to stable BB thread, project, environment, provider, and repository revision identifiers. Settings show validation and status without returning secrets.
After each Luna task, run a separate Sol Medium review in this order: first check the frozen contract, repository protocol, and acceptance criteria; then check reuse, simplicity, and maintainability. The task owner fixes concrete review findings before its output becomes a dependency. Finish with one Sol Medium product review across the assembled read-only surfaces, including whether main-branch integration is presented only as a report.

**Acceptance checks:** both repositories load without writes; queue and question text remains repository-backed; canonical `plans/README.md` is linked and not copied as a plugin dashboard; no scheduler or worker starts; a disconnected host and malformed protocol produce actionable read-only errors.

### Phase 2: Guarded repository actions

**Dependency:** Phase 1 projections and the frozen write/RPC interfaces.

- **Luna Extra High, repository actions:** implement narrow actions for queue approval, queue updates allowed by the repository protocol, and question updates or resolution where the authoritative source permits it. Every action validates the target path, expected content or revision, authorization provenance, that item's dependencies, that item's blocking-question state, and repository-specific policy before writing. A blocked item remains blocked without preventing other eligible items from proceeding.
- **Luna Extra High, BB interaction actions:** implement Answer question, Approve queue, Retry, Pause, and Stop request plumbing. Answer resolves one identified BB interaction once and repeated submissions return the prior outcome. Retry references a failed attempt and uses bounded retry policy; it must not duplicate the original user message. Stop requests cancellation and preserves history, repository records, and user-authored queue items.
Each Luna task receives its own Sol Medium review before integration: spec and authorization compliance first, then reuse, simplicity, and maintainability. The policy review must cover edge cases where a generic action would violate either repository's `repo.md`, especially main-branch, deployment, migration, dbt, and non-dbt integration rules. The UI must state the active rule at the action point and reject, rather than broaden, permissions.

**Acceptance checks:** stale content is rejected without mutation; a changed file is never overwritten; unauthorized or ambiguous `ready` transitions are rejected; agents cannot perform the first transition to `ready`; successful writes preserve unrelated Markdown and required dashboard or claim boundaries; duplicate action submissions do not duplicate queue changes, answers, or messages.

### Phase 3: Exclusive dispatch engine and scheduler

**Dependency:** Phase 2 action and state interfaces. This phase is the first that can create work.

Run the engine tasks in parallel, then integrate them in one sequential wiring task:

- **Luna Extra High, ownership and dispatch:** acquire one durable ownership record before any repository mutation or worker spawn. Include repository, queue item, run, worker thread, lease timestamp, and authorization provenance. Serialize transitions. Preflight the connected host, checkout, branch, required tools, and data-platform browser/dbt prerequisites where relevant. Create the durable run intent before dispatch, then start at most one BB worker thread for it.
- **Luna Extra High, worker lifecycle and recovery:** track active, completed, failed-safe, blocked, no-op, cancellation-requested, and reconciliation-required states. Do not clear ownership on a cancellation request until worker termination is confirmed. On startup or lease expiry, reconcile BB thread state, repository lock, queue claim, current report, Git revision, and plugin records before requeueing. Preserve substantial work, both-provider participation when required by protocol, plain-English accomplishments, and questions.
- **Luna Extra High, scheduler:** implement exactly one plugin-owned scheduler. Make the normal spacing configurable while defaulting to the current one-hour minimum and never allowing a duplicate wakeup, reload, or recovery path to bypass the rolling-hour safety guard. Preserve night-window behavior and pause semantics: pause prevents new dispatch but leaves active work and queued intent intact. Scheduling is at-least-once, not exactly-once.
- **Luna Extra High, lifecycle integration:** reconcile durable state on startup, dispose timers, sockets, listeners, database handles, and worker subscriptions on reload, and make repeated initialization safe. Hosting must be always-on for reliable scheduling; the plugin must report when BB or the configured host is unavailable. This is a prerequisite, not a new hosting migration project. A Mac-local browser or dbt Studio dependency remains a visible prerequisite for data-platform work.
Review each engine task separately with Sol Medium before integration: protocol and acceptance compliance first, then reuse, simplicity, and maintainability. A final Sol Medium dispatch review checks provider preference, alternation, retry/failover, no-op stopping, and the meaning of “substantial” against the existing dispatcher and repository protocols. Do not alter provider or integration policy merely to simplify implementation.

**Focused tests:** duplicate Run now calls with one idempotency key; cron replay after restart; spacing at the configured boundary; paused dispatch; unavailable host; stale checkout; cancellation followed by worker termination; interrupted worker requiring reconciliation; retry after a failed attempt; and ownership uniqueness under concurrent starts. Use deterministic boundary tests and one integration smoke path; do not build a broad scheduler matrix or duplicate parser fixtures.

### Phase 4: Controlled cutover and acceptance

**Dependency:** Phase 3 passes focused tests and one integrated smoke run.

Use one dispatcher-owner cutover, while enabling repositories one at a time behind it. The order is selected after comparing protocol fixtures, not assumed from repository name. The sequence is:

1. Put plugin dispatch in cutover-disabled mode for every repository and verify the always-on BB host, persistent plugin storage, restart behavior, and operator access.
2. Disable every legacy dispatcher trigger across all managed repositories in one controlled maintenance window.
3. Snapshot and reconcile shell state, live workers, queue claims, locks, and repository revisions for every repository.
4. Drain or explicitly adopt each live run into plugin ownership, then confirm no legacy process can dispatch anywhere.
5. Enable the plugin scheduler globally with all repository dispatch flags still disabled.
6. Enable one repository and verify one complete dispatch plus one recovery or reconciliation cycle.
7. Confirm its canonical dashboard, queue, questions, immutable repository run records, and merge reporting remain correct.
8. Enable remaining repositories individually. Never restore a legacy trigger for one repository while the plugin scheduler can dispatch that repository.

Keep rollback explicit and global at the ownership boundary: disable plugin dispatch for all repositories, reconcile every active ownership record, stop the plugin scheduler, confirm it cannot dispatch, then restore selected legacy triggers. Never run both dispatcher owners concurrently, even for different repositories. Rollback must not delete plugin history, repository records, or user-authored queue entries.

### Phase 5: Legacy removal after stable operation

**Dependency:** repository-by-repository rollout acceptance, not merely a successful build.

Remove obsolete dispatcher scheduling and dead integration paths only after stable operation is documented. Retain migration-relevant references to the former shell configuration, defaults, and rollback procedure. Do not remove `plans/factory/` protocol files, canonical dashboards, merge-state policy, or immutable run records. Verify that `dispatch.sh`, `redeploy.sh`, and `merge-state.sh` are no longer active owners before deleting or archiving any replacement path.

### Phase 6: Public quickstart and community distribution

**Dependency:** Phase 1 read surfaces and the Phase 2 action layer. Independent of the Phase 4 cutover. This phase makes the plugin installable and immediately useful for repositories that have no factory protocol yet.

The current add-repository flow assumes an operator who already runs the shell factory: it asks for a connected host id, an absolute repository root and checkout path, a project id, and an environment id, and it tells the user to scaffold `plans/factory/` by hand. Phase 6 replaces that with a guided quickstart and publishes the plugin to the BB Community marketplace.

Verified extension points (checked against `@get-bb/plugin-sdk` 0.4.47 and live bb behavior on 2026-09-11):

- `sdk.hosts.pickFolder` opens a native folder picker on a host; `sdk.hosts.list` enumerates connected hosts.
- `sdk.projects.list` returns project sources (`local_path`, host id); `sdk.projects.create` exists; `sdk.projects.branches` supports default-branch detection.
- `sdk.environments` exposes no list or create, so an environment id is never a user input. `threads.spawn` accepts `environment: { type: "host", workspace: { type: "unmanaged", path, branch } }`; a live probe confirmed bb auto-registers an unmanaged environment record and returns its id on the spawned thread. The existing registry environments are unmanaged worktree pointers carrying nothing beyond host, path, and branch.
- `sdk.terminals` runs commands on a host, permitting `git worktree add`, branch creation, commits, and remote probing without any shell on the plugin host.
- `sdk.files.write` supports `createParents` and `expectedSha256` compare-and-swap, sufficient for root-confined scaffold writes that never overwrite existing content.

Deliverables:

1. **Spawn contract and registry schema.** `environmentId` becomes optional on registry entries. Dispatch keeps `{ type: "reuse" }` when an entry carries an environment id (existing installations unchanged) and otherwise spawns `{ type: "host", workspace: { type: "unmanaged", path: checkoutPath, branch: { kind: "existing", name: factoryBranch } } }`, recording the returned environment id on the run for linking. Preflight gains a readable failure for a missing `factory` branch that names the scaffolder. This contract change returns to the Phase 0 review process before downstream work consumes it.
2. **Protocol scaffolder.** The plugin ships a template set: the generic `foreman.md`, a `repo.md` skeleton (checks table, worker-model table, tracking rules), `queue.md` and `questions.md` format headers, an initial `current.md`, a `plans/README.md` dashboard seed, and a `runs/` placeholder. One guarded action writes only missing files inside the configured checkout with compare-and-swap and commits them on `factory`; it never edits existing protocol content. The bundled `foreman.md` is copied verbatim from the migration-baseline template: per the v1.2 contract the repository copy is authoritative from first write, and the shipped template carries a recorded digest so a baseline change is a deliberate update rather than drift.
3. **Dedicated checkout provisioning.** The guided path provisions the two-checkout topology by default: `git worktree add <root>-factory` on the connected host, creating the `factory` branch when missing, then scaffolding into that worktree. `git worktree list` is checked first; when `factory` is already checked out elsewhere the flow explains the conflict and offers the direct-checkout option instead of failing obscurely. An advanced toggle registers the repository root itself as the checkout for users who keep protocol files in their main working copy.
4. **Quickstart add-repository flow.** The wizard becomes: pick a repository folder with the native picker; the plugin validates it is a git repository, derives the repository key from the folder name, detects `mainRef` from the remote HEAD, resolves the project by matching `projects.list` sources (calling `projects.create` on a miss), defaults the host to the picked host with a picker only when several are connected, probes for an existing `plans/factory/`, and offers the scaffold. Registration always completes with dispatch paused. No field asks for an environment id, host id, or project id.
5. **Registry-first discovery.** The `legacy` merge-state.sh discovery stays for the two existing repositories but runs only when the configured `factoryRoot` file exists, and is never surfaced in the add flow or new-user docs.
6. **Release hygiene.** Remove `private`, add `license` and `repository`, trim `files` to the runtime artifact set, decide and implement the `dist/` strategy for git-source installs (prebuilt `dist/` committed on release tags, which git installs prefer), verify `engines.bb` and `engines.bbPluginSdk` ranges, add `bb plugin types --check` to CI, rewrite the README for a fresh install (install, add repository, dispatch prerequisites including provider sign-in and the always-on scheduling limitation), and add `PLUGIN_OVERVIEW.md`.
7. **Marketplace listing.** A public GitHub repository serves as the `git:` source tracking `vX.Y.Z` tags. Submit `entries/bb-factory.json` (v2 schema: id, displayName, description, icon, tags, author) to `github.com/get-bb/marketplace` with a vendored icon, screenshots from a clean install, and the overview file, via fork pull request or the `bb plugin submit` intake path, whichever the registry README documents at submission time. Releases are tags on the plugin repository; listing changes go through reviewed pull requests. Publishing, tagging, and the marketplace pull request are protected actions requiring an `approved:` queue line.

Acceptance checks:

- On a bb install with no prior factory state, the full path works end to end: install, Add repository, pick folder, initialize protocol, one queue entry authored, and Run now produces exactly one foreman thread in the provisioned worktree.
- A new user is never asked for an environment id, host id, project id, or file-format knowledge.
- The scaffolder never overwrites existing protocol content; all writes stay inside the configured checkout; the scaffold commit lands on `factory`.
- A `factory` branch checked out in another worktree produces a clear explanation, not a git error.
- Existing registry entries with explicit environment ids behave exactly as before.
- Registration always leaves dispatch paused.

Reviews follow the standing model: each implementation task is Luna Extra High with separate Sol Medium compliance and code-quality passes, and the spawn-contract and registry-schema change returns to contract review before downstream work consumes it.

## 5. Rollout acceptance, separate from implementation

A rollout is accepted only when all of these are demonstrated for each repository:

- The plugin runs on an always-on BB host and reports the connected checkout and any host-local browser or dbt prerequisite accurately.
- Exactly one dispatch owner exists. A restart, reconnect, cron replay, double-click, or recovery attempt cannot create a duplicate run.
- The configured spacing and night window behave as displayed, while the rolling-hour safety rule remains enforced.
- Queue eligibility is evaluated per item: each item needs human-only initial authorization, satisfied dependencies, and no open blocking question attached to that item. A blocked item does not gate other eligible items, and authorization provenance is visible.
- Queue and Questions views reflect repository files and BB pending interactions, not a plugin task or question database.
- Preview performs no dispatch, write, branch, or schedule mutation. Run now creates one durable intent. Pause, Stop, Approve, Answer, Retry, and Integration follow their defined semantics.
- A stale repository write fails safely. A cancellation, host outage, provider limit, and interrupted worker leave enough durable state for reconciliation.
- Both repository protocols, their custom checks, canonical dashboards, existing integration policies, and `factory` versus `main` merge reporting remain unchanged.
- A successful run and a recovery run produce concise plugin operational history linked to BB and repository identifiers, while the repository's own current and immutable run records remain authoritative.

The final smoke check should use a controlled checkout and test BB threads, exercise one normal path and one recovery path, and inspect user-visible panels. Do not add broad coverage targets or redundant test matrices. The priority is enforcing ownership, authorization, safe writes, repository-specific rules, and recoverability before enabling unattended dispatch.
