import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  provisionCheckoutActionRequestSchema,
  type FactoryActionResult,
  type IdempotencyKey,
  type ProvisionCheckoutActionRequest,
  type ProvisionCheckoutOutcome,
  type RepositoryKey,
  type RepositoryRegistryEntry,
} from "../contracts.js";
import type { ProvisionCheckoutActionExecutor } from "../ports.js";
import { readCheckoutBranch } from "../services/live-health.js";
import type { OperationalStateStore, PendingActionIntentRecord } from "../storage/index.js";
import {
  HostCommandLostError,
  HostCommandStartError,
  runHostCommand,
  shellQuote,
  type HostCommandResult,
} from "./host-command.js";
import { claimErrorResult, completeIntent, consumedResult, reconcileIntent, recordedIntentResult } from "./intents.js";
import { actionError, actionSuccess, errorMessage } from "./results.js";

type ProvisionSdk = Pick<BbPluginApi["sdk"], "files" | "terminals" | "hosts">;

export interface ProvisionCheckoutActionExecutorOptions {
  readonly sdk: ProvisionSdk;
  readonly store: OperationalStateStore;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
  readonly now?: () => Date;
}

const FACTORY_BRANCH = "factory";
const GIT_TIMEOUT_MS = 60_000;

/** One entry of `git worktree list --porcelain`: the path plus its branch (null for detached/bare). */
export interface WorktreeListEntry {
  readonly path: string;
  readonly branch: string | null;
}

/**
 * Parses `git worktree list --porcelain` output into path + branch pairs.
 * `detached`, `bare`, `locked`, and `prunable` records yield branch null.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push({ path: current.path, branch: current.branch });
      current = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (current !== null && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (current !== null) entries.push({ path: current.path, branch: current.branch });
  return entries;
}

function normalizeHostPath(value: string): string {
  return value.replace(/[\\/]+$/u, "");
}

function sameHostPath(left: string, right: string): boolean {
  return normalizeHostPath(left) === normalizeHostPath(right);
}

function provisionFailure(error: unknown, idempotencyKey: IdempotencyKey): FactoryActionResult {
  if (error instanceof HostCommandStartError || error instanceof HostCommandLostError) {
    return actionError("host-unavailable", errorMessage(error), idempotencyKey);
  }
  return actionError("internal", errorMessage(error), idempotencyKey);
}

export function createProvisionCheckoutActionExecutor(options: ProvisionCheckoutActionExecutorOptions): ProvisionCheckoutActionExecutor {
  const now = options.now ?? (() => new Date());
  const sdk = options.sdk;

  function runGit(hostId: string, cwd: string, command: string, title: string): Promise<HostCommandResult> {
    return runHostCommand(sdk.terminals, { hostId, cwd, command, title, timeoutMs: GIT_TIMEOUT_MS }, now);
  }

  function provisionOutcome(args: {
    status: "preview" | "accepted" | "already-applied";
    outcome: ProvisionCheckoutOutcome["outcome"];
    mode: "worktree" | "direct";
    checkoutPath: string;
    branch: string | null;
    message: string;
    blockingWorktreePath?: string | null;
    branchCreated?: boolean | null;
    branchExisted?: boolean | null;
    baseRef?: string | null;
  }): ProvisionCheckoutOutcome {
    return {
      status: args.status,
      message: args.message,
      revision: null,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "provision-checkout",
      questionId: null,
      interactionId: null,
      mode: args.mode,
      outcome: args.outcome,
      checkoutPath: args.checkoutPath,
      branch: args.branch,
      blockingWorktreePath: args.blockingWorktreePath ?? null,
      branchCreated: args.branchCreated ?? null,
      branchExisted: args.branchExisted ?? null,
      baseRef: args.baseRef ?? null,
    };
  }

  /** Read-only re-probe used to classify a failed or unverifiable worktree add. */
  async function listWorktrees(hostId: string, repositoryRoot: string): Promise<WorktreeListEntry[] | null> {
    const listed = await runGit(
      hostId,
      repositoryRoot,
      `git -C ${shellQuote(repositoryRoot)} worktree list --porcelain`,
      "factory worktree list",
    ).catch(() => null);
    if (listed === null || listed.exitCode !== 0) return null;
    return parseWorktreeList(listed.output);
  }

  async function execute(request: ProvisionCheckoutActionRequest): Promise<FactoryActionResult> {
    const parsed = provisionCheckoutActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return actionError("invalid-input", `Invalid provision request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const valid = parsed.data;
    const action = valid.action;

    // A finished intent replays its recorded result without touching the host.
    const recorded = recordedIntentResult(options.store, valid);
    if (recorded) return recorded;

    // The wizard provisions before a registry entry exists, so an explicit
    // host + root target wins; otherwise the configured entry supplies both.
    const explicitTarget = action.hostId !== undefined;
    const entry = options.repositoryLookup(valid.repositoryKey);
    if (!explicitTarget && !entry) {
      return actionError("not-found", `Repository '${valid.repositoryKey}' is not configured.`, valid.idempotencyKey);
    }
    const hostId = action.hostId ?? entry!.configuration.connectedHostId;
    // For worktree mode the root is the repository root the worktree extends;
    // for direct mode it is the candidate checkout to verify. An explicit
    // path always wins; a configured entry supplies the fallback.
    const repositoryRoot = normalizeHostPath(
      action.repositoryRoot
        ?? (action.mode === "direct" ? entry!.configuration.checkoutPath : entry!.configuration.repositoryRoot),
    );
    const worktreePath = `${repositoryRoot}-factory`;

    // Guard: the root must be a Git checkout on the connected host. The .git
    // probe also covers linked worktree roots, where .git is a pointer file.
    let existence: Record<string, boolean>;
    try {
      existence = (
        await sdk.hosts.pathsExist({
          hostId,
          paths: [repositoryRoot, `${repositoryRoot}/.git`, worktreePath],
        })
      ).existence;
    } catch (error) {
      return actionError(
        "host-unavailable",
        `Could not probe '${repositoryRoot}' on host '${hostId}': ${errorMessage(error)}`,
        valid.idempotencyKey,
      );
    }
    if (existence[repositoryRoot] !== true) {
      return actionError(
        "checkout-invalid",
        `'${repositoryRoot}' does not exist on host '${hostId}'.`,
        valid.idempotencyKey,
      );
    }
    if (existence[`${repositoryRoot}/.git`] !== true) {
      return actionError(
        "checkout-invalid",
        `'${repositoryRoot}' is not a Git checkout on host '${hostId}'.`,
        valid.idempotencyKey,
      );
    }

    if (action.mode === "direct") {
      // Direct mode is read-only: it verifies the root and reports its
      // branch. Creating or switching branches is never this action's job, so
      // nothing is claimed in the intent store.
      const branch = await readCheckoutBranch(sdk, hostId, repositoryRoot);
      return actionSuccess(
        provisionOutcome({
          status: "preview",
          outcome: branch === FACTORY_BRANCH ? "verified" : "off-branch",
          mode: "direct",
          checkoutPath: repositoryRoot,
          branch,
          message: branch === FACTORY_BRANCH
            ? `'${repositoryRoot}' is a Git checkout on '${FACTORY_BRANCH}'; register it as the direct checkout.`
            : `'${repositoryRoot}' is on '${branch ?? "no branch"}', not '${FACTORY_BRANCH}'. Switch the checkout yourself or provision a dedicated worktree; this action never creates or switches branches.`,
        }),
        null,
      );
    }

    let listed: HostCommandResult;
    try {
      listed = await runGit(
        hostId,
        repositoryRoot,
        `git -C ${shellQuote(repositoryRoot)} worktree list --porcelain`,
        "factory worktree list",
      );
    } catch (error) {
      return provisionFailure(error, valid.idempotencyKey);
    }
    if (listed.exitCode !== 0) {
      return actionError(
        "checkout-invalid",
        `Could not list worktrees for '${repositoryRoot}' on host '${hostId}': ${listed.output || "git worktree list failed"}`,
        valid.idempotencyKey,
      );
    }
    const worktrees = parseWorktreeList(listed.output);
    const atTarget = worktrees.find((candidate) => sameHostPath(candidate.path, worktreePath));
    if (atTarget && atTarget.branch === FACTORY_BRANCH) {
      return actionSuccess(
        provisionOutcome({
          status: "already-applied",
          outcome: "already-provisioned",
          mode: "worktree",
          checkoutPath: worktreePath,
          branch: FACTORY_BRANCH,
          branchExisted: true,
          message: `The dedicated factory worktree '${worktreePath}' already exists on '${FACTORY_BRANCH}'; nothing was changed.`,
        }),
        null,
      );
    }
    if (atTarget) {
      return actionError(
        "conflict",
        `'${worktreePath}' is already a worktree on '${atTarget.branch ?? "a detached HEAD"}', not '${FACTORY_BRANCH}'. Remove it or register a different checkout.`,
        valid.idempotencyKey,
      );
    }
    const holder = worktrees.find((candidate) => candidate.branch === FACTORY_BRANCH);
    if (holder) {
      return actionSuccess(
        provisionOutcome({
          status: "preview",
          outcome: "branch-in-use",
          mode: "worktree",
          checkoutPath: worktreePath,
          branch: null,
          blockingWorktreePath: normalizeHostPath(holder.path),
          branchExisted: true,
          message: `Branch '${FACTORY_BRANCH}' is already checked out at '${normalizeHostPath(holder.path)}'. Register that checkout directly, or remove the worktree and retry.`,
        }),
        null,
      );
    }
    if (existence[worktreePath] === true) {
      return actionError(
        "conflict",
        `'${worktreePath}' exists on host '${hostId}' but is not a registered worktree. Remove it or register a different checkout.`,
        valid.idempotencyKey,
      );
    }

    let showRef: HostCommandResult;
    try {
      showRef = await runGit(
        hostId,
        repositoryRoot,
        `git -C ${shellQuote(repositoryRoot)} show-ref --verify --quiet refs/heads/${FACTORY_BRANCH}`,
        "factory branch probe",
      );
    } catch (error) {
      return provisionFailure(error, valid.idempotencyKey);
    }
    const branchExisted = showRef.exitCode === 0;

    // A missing branch is based on the repo's default remote branch when it
    // can be identified; otherwise the add falls back to the current HEAD.
    let baseRef: string | null = null;
    if (!branchExisted) {
      const originHead = await runGit(
        hostId,
        repositoryRoot,
        `git -C ${shellQuote(repositoryRoot)} symbolic-ref --quiet --short refs/remotes/origin/HEAD`,
        "factory base probe",
      ).catch(() => null);
      if (originHead !== null && originHead.exitCode === 0 && originHead.output.trim() !== "") {
        baseRef = originHead.output.trim();
      }
    }

    let record: PendingActionIntentRecord;
    try {
      record = options.store.claimPendingActionIntent({ request: valid, target: { kind: "repository" } }).record;
    } catch (error) {
      return claimErrorResult(error, valid.idempotencyKey);
    }
    if (record.status === "completed" || record.status === "reconciliation-required") {
      return consumedResult(record);
    }

    let consumption;
    try {
      consumption = options.store.consumePendingActionIntent(valid.idempotencyKey);
    } catch (error) {
      return claimErrorResult(error, valid.idempotencyKey);
    }
    if (!consumption.consumed) return consumedResult(consumption.record);
    record = consumption.record;
    const store = options.store;
    const complete = (result: FactoryActionResult, observedStatus?: "written" | "conflict" | "verified") =>
      completeIntent(store, record, result, observedStatus === undefined ? undefined : { observedStatus });
    const reconcile = (message: string, observedStatus?: "written" | "conflict" | "verified") =>
      reconcileIntent(store, record, message, observedStatus === undefined ? undefined : { observedStatus });

    const addCommand = branchExisted
      ? `git -C ${shellQuote(repositoryRoot)} worktree add ${shellQuote(worktreePath)} ${FACTORY_BRANCH}`
      : baseRef !== null
        ? `git -C ${shellQuote(repositoryRoot)} worktree add -b ${FACTORY_BRANCH} ${shellQuote(worktreePath)} ${shellQuote(baseRef)}`
        : `git -C ${shellQuote(repositoryRoot)} worktree add -b ${FACTORY_BRANCH} ${shellQuote(worktreePath)}`;

    let added: HostCommandResult;
    try {
      added = await runGit(hostId, repositoryRoot, addCommand, "factory worktree add");
    } catch (error) {
      if (error instanceof HostCommandStartError) {
        return complete(
          actionError("host-unavailable", `The worktree-add terminal could not be created: ${errorMessage(error)}`, valid.idempotencyKey),
          "conflict",
        );
      }
      return reconcile(`The worktree add for '${worktreePath}' could not be verified and may have landed: ${errorMessage(error)}`, "written");
    }
    if (added.exitCode !== 0) {
      // A concurrent provisioner may have won between the preflight list and
      // the add; re-probe before reporting a plain failure.
      const after = await listWorktrees(hostId, repositoryRoot);
      const nowAtTarget = after?.find((candidate) => sameHostPath(candidate.path, worktreePath));
      if (nowAtTarget?.branch === FACTORY_BRANCH) {
        return complete(
          actionSuccess(
            provisionOutcome({
              status: "already-applied",
              outcome: "already-provisioned",
              mode: "worktree",
              checkoutPath: worktreePath,
              branch: FACTORY_BRANCH,
              branchCreated: false,
              branchExisted: true,
              message: `The dedicated factory worktree '${worktreePath}' already exists on '${FACTORY_BRANCH}'; nothing was changed.`,
            }),
            null,
          ),
          "verified",
        );
      }
      return complete(
        actionError("internal", `git worktree add failed for '${worktreePath}': ${added.output || "no terminal output"}`, valid.idempotencyKey),
        "conflict",
      );
    }

    // Post-verify through the host file API; the worktree list is the fallback
    // when the worktree's .git pointer is not readable yet.
    const verifiedBranch = await readCheckoutBranch(sdk, hostId, worktreePath);
    if (verifiedBranch !== FACTORY_BRANCH) {
      const after = await listWorktrees(hostId, repositoryRoot);
      const confirmed = after?.some((candidate) => sameHostPath(candidate.path, worktreePath) && candidate.branch === FACTORY_BRANCH) === true;
      if (!confirmed) {
        return reconcile(`The worktree at '${worktreePath}' was added but its branch could not be verified.`, "written");
      }
    }

    const message = branchExisted
      ? `Created the dedicated factory worktree '${worktreePath}' on the existing '${FACTORY_BRANCH}' branch.`
      : `Created the dedicated factory worktree '${worktreePath}' on a new '${FACTORY_BRANCH}' branch based on ${baseRef ?? "the current HEAD"}.`;
    return complete(
      actionSuccess(
        provisionOutcome({
          status: "accepted",
          outcome: "provisioned",
          mode: "worktree",
          checkoutPath: worktreePath,
          branch: FACTORY_BRANCH,
          branchCreated: !branchExisted,
          branchExisted,
          baseRef,
          message,
        }),
        null,
      ),
      "verified",
    );
  }

  return { execute };
}
