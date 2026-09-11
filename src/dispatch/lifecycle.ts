import type {
  CanonicalFileRecordLink,
  OperationalRunDetail,
  OperationalRunSummary,
  RepositoryKey,
  RepositoryRevision,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import { ProtocolError } from "../protocol/errors.js";
import { readTextFile } from "../protocol/files.js";
import { parseCurrentState } from "../protocol/markdown.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import { confirmRelease, flagLeaseForReconciliation } from "./ownership.js";
import {
  PENDING_RUN_GRACE_MS,
  PROVIDER_LIMIT_SECONDS,
  dispatcherNowSeconds,
  nightKeyAt,
  nightState,
  runDispatchUpdate,
  type DispatchContext,
} from "./types.js";

type ThreadStatusValue = "active" | "error" | "idle" | "pending" | "starting" | "stopping";
type ForemanState = "success" | "blocked" | "failed-safe" | "no-op";

function outcomeToStatus(state: ForemanState): "completed" | "blocked" | "failed-safe" | "no-op" {
  return state === "success" ? "completed" : state;
}

function isTerminalThreadStatus(status: ThreadStatusValue): boolean {
  return status === "idle" || status === "error";
}

interface CurrentStateRead {
  readonly state: ForemanState | null;
  readonly fresh: boolean;
}

async function readCurrentState(
  ctx: DispatchContext,
  repositoryKey: RepositoryKey,
  startedAtMs: number,
): Promise<CurrentStateRead> {
  const entry = ctx.repositoryLookup(repositoryKey);
  if (!entry) return { state: null, fresh: false };
  try {
    const file = await readTextFile(
      { read: (args) => ctx.sdk.files.read(args), listPaths: (args) => ctx.sdk.files.listPaths(args) },
      {
        hostId: entry.configuration.connectedHostId,
        rootPath: entry.configuration.checkoutPath,
        relativePath: PROTOCOL_PATHS.current,
        repositoryKey,
      },
    );
    const parsed = parseCurrentState(file.content, PROTOCOL_PATHS.current);
    const fresh = file.modifiedAtMs !== undefined && startedAtMs > 0 && file.modifiedAtMs >= startedAtMs;
    return { state: parsed.state, fresh };
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "file-not-found") {
      return { state: null, fresh: false };
    }
    throw error;
  }
}

async function postRunRecords(
  ctx: DispatchContext,
  run: OperationalRunSummary,
): Promise<{ revision: RepositoryRevision; canonicalRecords: CanonicalFileRecordLink[] }> {
  const entry = ctx.repositoryLookup(run.repositoryKey);
  const records: CanonicalFileRecordLink[] = [...run.canonicalRecords];
  if (!entry) return { revision: run.repositoryRevision, canonicalRecords: records };
  try {
    const snapshot = await ctx.protocolReader.loadSnapshot(entry.configuration);
    const revision = snapshot.revision;
    const latestRunPath = snapshot.currentRun.latestRunPath;
    if (latestRunPath && !records.some((record) => record.relativePath === latestRunPath)) {
      records.push({
        relativePath: latestRunPath,
        recordType: "immutable-run",
        recordId: latestRunPath.split("/").pop() ?? run.runId,
        repositoryRevision: revision,
      });
    }
    if (!records.some((record) => record.recordType === "current-run")) {
      records.push({
        relativePath: PROTOCOL_PATHS.current,
        recordType: "current-run",
        recordId: run.runId,
        repositoryRevision: revision,
      });
    }
    return { revision, canonicalRecords: records };
  } catch {
    return { revision: run.repositoryRevision, canonicalRecords: records };
  }
}

function finalizeRun(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  input: {
    status: "completed" | "blocked" | "failed-safe" | "no-op" | "reconciliation-required";
    providerId: string;
    workerThreadId: string;
    projectId: string;
    environmentId: string | null;
    revision: RepositoryRevision;
    canonicalRecords: CanonicalFileRecordLink[];
    finishedAt: string;
    lastState: string;
    bumpFailed: boolean;
    bumpNoop: boolean;
    limitProviderSeconds?: number;
  },
): void {
  const run = detail.summary;
  ctx.store.withTransaction((transaction) => {
    transaction.updateRunDispatch(runDispatchUpdate(run, {
      status: input.status,
      finishedAt: input.finishedAt,
      providerId: input.providerId,
      workerThreadId: input.workerThreadId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      repositoryRevision: input.revision,
      canonicalRecords: input.canonicalRecords,
    }));
    for (const attempt of detail.attempts) {
      if (attempt.status === "started" || attempt.status === "cancel-requested" || attempt.status === "pending") {
        transaction.updateDispatchAttempt({ ...attempt, status: input.status, finishedAt: input.finishedAt });
      }
    }
    const lease = detail.lease ?? ctx.store.getCurrentOwnership(run.repositoryKey);
    if (lease && lease.status !== "released") {
      transaction.updateOwnershipLease({ ...lease, workerThreadId: input.workerThreadId, status: "released" });
    }
    const state = nightState(
      ctx.store.getDispatcherState(run.repositoryKey),
      nightKeyAt(ctx.now(), ctx.settings.nightWindowEndHour),
    );
    const limits = { ...state.limits };
    if (input.limitProviderSeconds !== undefined) {
      limits[input.providerId] = dispatcherNowSeconds(ctx.now) + input.limitProviderSeconds;
    }
    transaction.saveDispatcherState({
      ...state,
      lastState: input.lastState,
      failedCount: state.failedCount + (input.bumpFailed ? 1 : 0),
      noopCount: state.noopCount + (input.bumpNoop ? 1 : 0),
      limits,
    });
  });
}

function markRunForReconciliation(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  reason: string,
): void {
  ctx.log?.(`run ${detail.summary.runId}: ${reason}`);
  const run = detail.summary;
  const entry = ctx.repositoryLookup(run.repositoryKey);
  const finishedAt = ctx.now().toISOString();
  ctx.store.withTransaction((transaction) => {
    transaction.updateRunDispatch(runDispatchUpdate(run, {
      status: "reconciliation-required",
      finishedAt: run.finishedAt ?? finishedAt,
      projectId: run.projectId ?? entry?.projectId ?? "unknown",
      environmentId: run.environmentId ?? entry?.environmentId ?? null,
    }));
    for (const attempt of detail.attempts) {
      if (attempt.status === "started" || attempt.status === "cancel-requested" || attempt.status === "pending") {
        transaction.updateDispatchAttempt({ ...attempt, status: "reconciliation-required", finishedAt: attempt.finishedAt ?? finishedAt });
      }
    }
    const lease = detail.lease ?? ctx.store.getCurrentOwnership(run.repositoryKey);
    if (lease && lease.status !== "released") {
      transaction.updateOwnershipLease({ ...lease, status: "reconciliation-required" });
    }
  });
}

async function reconcileStartedRun(ctx: DispatchContext, detail: OperationalRunDetail): Promise<void> {
  const run = detail.summary;
  const lease = detail.lease ?? ctx.store.getCurrentOwnership(run.repositoryKey);
  const threadId = run.workerThreadId;
  if (!threadId || threadId === "spawn-ambiguous" || threadId === "unknown-thread") {
    markRunForReconciliation(ctx, detail, "has no recorded worker thread to observe");
    return;
  }

  let threadStatus: ThreadStatusValue;
  try {
    const thread = await ctx.sdk.threads.get({ threadId });
    threadStatus = thread.status as ThreadStatusValue;
  } catch (error) {
    ctx.log?.(`run ${run.runId}: could not read worker thread '${threadId}': ${errorMessage(error)}; retrying next reconcile`);
    return;
  }

  const now = ctx.now();
  const nowMs = now.getTime();
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : 0;

  if (!isTerminalThreadStatus(threadStatus)) {
    const expired = lease !== null && Date.parse(lease.expiresAt) <= nowMs;
    if (run.status === "cancel-requested" || !expired) return;
    try {
      await ctx.sdk.threads.stop({ threadId });
    } catch (error) {
      ctx.log?.(`run ${run.runId}: stop request for '${threadId}' failed: ${errorMessage(error)}; retrying next reconcile`);
      return;
    }
    ctx.store.withTransaction((transaction) => {
      transaction.updateRunDispatch(runDispatchUpdate(run, { status: "cancel-requested", finishedAt: null, workerThreadId: threadId }));
      for (const attempt of detail.attempts) {
        if (attempt.status === "started") {
          transaction.updateDispatchAttempt({ ...attempt, status: "cancel-requested" });
        }
      }
      if (lease) transaction.updateOwnershipLease({ ...lease, status: "release-requested" });
    });
    ctx.log?.(`run ${run.runId}: runtime cap reached; stop requested on '${threadId}'`);
    return;
  }

  let current: CurrentStateRead;
  try {
    current = await readCurrentState(ctx, run.repositoryKey, startedAtMs);
  } catch (error) {
    markRunForReconciliation(ctx, detail, `could not read ${PROTOCOL_PATHS.current}: ${errorMessage(error)}`);
    return;
  }

  const wasCancelRequested = run.status === "cancel-requested";
  const { revision, canonicalRecords } = await postRunRecords(ctx, run);
  const finishedAt = now.toISOString();
  const identity = {
    providerId: run.providerId!,
    workerThreadId: threadId,
    projectId: run.projectId!,
    environmentId: run.environmentId,
    revision,
    canonicalRecords,
    finishedAt,
  };

  if (current.state !== null && current.fresh) {
    finalizeRun(ctx, detail, {
      ...identity,
      status: outcomeToStatus(current.state),
      lastState: current.state,
      bumpFailed: current.state === "failed-safe",
      bumpNoop: current.state === "no-op",
    });
    ctx.log?.(`run ${run.runId}: finished ${current.state}`);
    return;
  }

  // No fresh foreman state: either a dead start (provider-side failure, the
  // thread never wrote a run record) or a stop requested by the operator.
  finalizeRun(ctx, detail, {
    ...identity,
    status: "failed-safe",
    lastState: wasCancelRequested ? "failed-safe" : "dead-start",
    bumpFailed: false,
    bumpNoop: false,
    ...(wasCancelRequested ? {} : { limitProviderSeconds: PROVIDER_LIMIT_SECONDS }),
  });
  ctx.log?.(`run ${run.runId}: ${wasCancelRequested ? "cancelled" : "dead start"} on ${run.providerId}`);
}

export async function reconcileRepository(ctx: DispatchContext, repositoryKey: RepositoryKey): Promise<void> {
  for (const run of ctx.store.listActiveRuns(repositoryKey)) {
    const detail = (await ctx.store.getRun({ repositoryKey, runId: run.runId })).run;
    if (!detail) continue;
    if (run.status === "pending") {
      const ageMs = ctx.now().getTime() - Date.parse(run.requestedAt);
      if (ageMs > PENDING_RUN_GRACE_MS) {
        markRunForReconciliation(ctx, detail, "was never dispatched within the start grace period");
      }
      continue;
    }
    if (run.status === "reconciliation-required") continue;
    await reconcileStartedRun(ctx, detail);
  }

  const lease = ctx.store.getCurrentOwnership(repositoryKey);
  if (lease && lease.status !== "released") {
    const detail = (await ctx.store.getRun({ repositoryKey, runId: lease.runId })).run;
    if (detail === null) {
      flagLeaseForReconciliation(ctx.store, lease);
    } else if (!["pending", "started", "cancel-requested", "reconciliation-required"].includes(detail.summary.status)) {
      confirmRelease(ctx.store, lease);
    }
  }
}
