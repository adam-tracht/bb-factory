# BB Factory hosting decision

**Status:** Decision pending. This document prepares the hosting choice; it does not authorize provisioning, configuration, cutover, or protocol changes.

## Decision to make

Approve an always-on BB server and execution host that do not depend on Adam's personal Mac. Until that exists and passes the rollout gates below, BB Factory dispatch remains disabled and the current repository, browser, dbt, and integration policies remain unchanged.

The current audit found only one enrolled BB machine, `MacBook Pro`. Existing Cloud Run and dbt services are not BB hosts: no BB server, host daemon, persistent BB data directory, provider authentication, or repository checkout was verified on them.

## Existing decisions that constrain hosting

- The plugin owns one scheduler. BB cron is durable across server restarts, but runs only while the plugin is loaded and uses server-local time.
- The configured execution host must be online and have the repository checkout and required tools before dispatch.
- Repository protocol files and Git history remain canonical. Hosting cannot weaken repository-specific main, deployment, migration, dbt, or non-dbt integration rules.
- Rollout requires persistent plugin storage, verified restart behavior, operator access, one dispatch owner, and repository-by-repository enablement.
- Some data-platform work requires host-local Aside/browser and dbt Studio access. Moving the scheduler does not remove that requirement.

These constraints come from [PLAN.md](../PLAN.md) and the frozen contract `v1.2` (freeze note in [CLAUDE.md](../CLAUDE.md); the full Phase 0 record lives in git history).

## Verified BB deployment facts

The current stable package is `bb-app@0.42.1`, matching the installed CLI observed on 2026-09-10.

- BB officially supports macOS and Linux hosts. `npx bb-app@<version>` starts the server, local host daemon, and web app, stores managed state under `~/.bb/` by default, and restarts either managed child if it exits unexpectedly. Node.js 22.19, 24, or 26 and Git are prerequisites. See the official [bb-app package README](https://github.com/get-bb/bb/blob/main/packages/bb-app/README.md).
- The server binds to loopback by default. Its direct API is unauthenticated and permits file reads and command execution, so it must not be exposed directly to the public internet. BB documents account-gated `bb connect` and private Tailscale Serve as remote-access paths. See [Using bb on multiple devices](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md).
- One server can dispatch to enrolled execution machines. The Add machine installer installs the host daemon and a launchd or systemd user service on the execution machine. Browser access and execution-machine enrollment are separate. See [Using bb on multiple devices](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md#add-an-execution-machine).
- `BB_SERVER_URL` targets an already-running remote server; it does not relocate the full server. `BB_DATA_DIR` and launcher flags select the persistent data directory and ports. See BB's [configuration reference](https://github.com/get-bb/bb/blob/main/docs/configuration.md).

BB does not document a turnkey full-server systemd unit or a managed BB hosting product. A VM deployment therefore needs an operator-owned service definition and explicit restart, backup, upgrade, and monitoring checks.

## Minimum viable architecture

```text
Owner browser
    |
    | account-gated bb connect
    v
One always-on Linux VM
    - pinned stable bb-app launcher
    - BB server and local host daemon
    - persistent BB data directory
    - persistent repository checkouts
    - Git and provider CLIs with host-local authentication
    - system service, health check, logs, and backups
```

This single-VM topology is the minimum because it supplies both the always-on scheduler and a non-personal execution host. It avoids a second machine, network route, and host-daemon enrollment during the pilot. Keep the BB listener on loopback and use `bb connect`; do not open port 38886 publicly.

### Candidate path: Google Compute Engine VM

This is a verified viable infrastructure shape, not an approved provider selection. Compute Engine supplies persistent VMs and Persistent Disk, and Google documents VM creation, IAM/OS Login, backups, and machine sizing. Relevant primary references are [creating a VM](https://cloud.google.com/compute/docs/instances/create-start-instance), [E2 machine types](https://cloud.google.com/compute/docs/general-purpose-machines#e2_machine_types), [Persistent Disk](https://cloud.google.com/compute/docs/disks/persistent-disks), and [current pricing](https://cloud.google.com/products/compute/pricing).

An initial test size of `e2-standard-2` (2 vCPU, 8 GB RAM) with a 50 GB persistent boot disk is an **unverified sizing assumption**, chosen to leave room for BB, one active provider process, native Node modules, Git operations, and logs. It is not a capacity claim. Measure memory, CPU, disk growth, and provider-process behavior during the smoke run before enabling recurring dispatch. Do not use Spot capacity for the scheduler host.

No monthly cost is approved or defensible yet. Region, disk class, snapshots, egress, taxes, discounts, and actual runtime load are unselected. The official price page also charges disk separately from the VM. Produce a calculator estimate only after the project, region, retention, and sizing decisions below are answered.

### Contingent split-host path

BB also supports an always-on server VM plus a separately enrolled execution machine. Use this only if an approved non-personal execution host already exists or is procured. It adds another availability boundary, credential set, checkout, daemon service, and route back to the server. No such host is currently verified, so this path is not deployable yet.

## Data-platform external gate

The Linux VM path does not prove unattended Aside/browser or dbt Studio access. No supported unattended replacement was verified in this audit. Therefore:

- Data-platform queue items requiring Mac-local Aside/browser or dbt Studio must remain ineligible for recurring dispatch.
- Adam's personal Mac cannot be the scheduled fallback.
- Full rollout requires either an approved non-personal always-on macOS execution host with those sessions and tools verified, or a separately approved change to the data-platform operating model. The latter is outside this decision and must not be inferred.
- General repository work may pilot on Linux only after its own host preflight proves every required tool and permission.

## Assumptions still unverified

- One concurrent worker is enough for the pilot and fits the proposed test size.
- Both managed repositories and their dependencies can run on Linux for all queue items admitted to the pilot.
- Provider subscription or API authentication can remain valid unattended on the VM under an approved account and secret-handling policy.
- The selected Git authentication can clone, fetch, commit, and perform only the repository actions already authorized by protocol.
- `bb connect` account limits and organization policy permit the server and operator clients.
- A 50 GB disk and the selected backup retention meet BB SQLite, plugin storage, logs, worktrees, and repository growth needs.
- Server-local timezone can be set and tested to preserve the existing night window across daylight-saving changes.
- The chosen VM and network can reach npm, Git remotes, provider endpoints, and `getbb.app` for the tunnel.

## Required decisions and prerequisites

1. **Scope:** approve a general-work Linux pilot only, or wait until the data-platform host gate is also solved.
2. **Infrastructure owner:** name the approved Google Cloud project, billing owner, region/zone, operator, and incident contact. If Google Cloud is not approved, select another persistent Linux VM provider and verify the same capabilities from its current primary docs.
3. **Execution topology:** approve the single VM for server plus general execution, or identify the specific approved always-on execution host for the split topology.
4. **Data-platform gate:** identify an approved non-personal always-on macOS host with verified Aside/dbt Studio access, or explicitly exclude those items from rollout. No replacement has been verified.
5. **Access and authentication:** approve BB remote access (`bb connect` is the minimum documented path), VM administrative access, Git identity/credentials, provider identities, secret storage, and credential rotation owners. Secret values must not enter this repository.
6. **Persistence and recovery:** choose BB data and checkout locations, disk class, snapshot schedule, retention, restore test, recovery point objective, and recovery time objective.
7. **Runtime policy:** approve a pinned stable BB version, the full-server service manager definition, restart policy, logs/alerts, maintenance window, and tested upgrade/rollback procedure. The execution-host installer auto-updates its daemon to the server protocol; the full server upgrade remains operator-owned.
8. **Sizing and cost:** approve a pilot size and budget after a provider calculator estimate. Validate one active worker, then resize from observed peaks and disk growth before recurring use.

## Deployment acceptance gate

Provisioning, when separately authorized, is not rollout approval. Before any recurring dispatch:

- prove the BB server, plugin, local host daemon, and tunnel recover after process and VM restart;
- restore BB state from backup in a disposable test;
- verify the expected host ID, checkout, branch, Git identity, provider status, required tools, timezone, and available disk;
- verify one controlled general-work run and one interrupted-run reconciliation path;
- keep all data-platform items requiring Aside/dbt Studio disabled until their external host gate passes;
- complete the repository-by-repository cutover sequence in `PLAN.md`, with legacy and plugin dispatch never active at the same time.

## Prepared decision

If no approved always-on host already exists, approve a **single Google Compute Engine Linux VM pilot for the BB server and general execution only**, subject to the prerequisites above. Do not call that full rollout. Full unattended coverage remains blocked on the explicit data-platform host gate.
