import type { FactoryActionResult, RepositoryKey } from "../contracts.js";
import { actionError, actionSuccess, errorMessage } from "../actions/results.js";
import type { DispatchContext } from "./types.js";

export interface StopRunInput {
  readonly repositoryKey: RepositoryKey;
}

/**
 * Request cancellation of the repository's active run. Ownership is not
 * cleared here: the lease moves to release-requested and is released only
 * after the reconciler confirms the worker thread is no longer running.
 */
export async function stopRun(ctx: DispatchContext, input: StopRunInput): Promise<FactoryActionResult> {
  const lease = ctx.store.getCurrentOwnership(input.repositoryKey);
  if (!lease || lease.status === "released") {
    return actionSuccess({
      status: "already-applied",
      message: "No active run is holding ownership for this repository.",
      revision: null,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, null);
  }

  const detail = (await ctx.store.getRun({ repositoryKey: input.repositoryKey, runId: lease.runId })).run;
  if (!detail) {
    return actionError("internal", `Run '${lease.runId}' referenced by lease '${lease.leaseId}' is missing.`);
  }
  const run = detail.summary;

  if (run.status === "cancel-requested") {
    return actionSuccess({
      status: "already-applied",
      message: `Cancellation for run '${run.runId}' is already in progress.`,
      revision: run.repositoryRevision,
      runId: run.runId,
      leaseId: lease.leaseId,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, run.repositoryRevision);
  }

  const threadId = run.workerThreadId;
  if (run.status !== "started" || !threadId) {
    // The run was never dispatched or already finished: no side effect to undo.
    ctx.store.withTransaction((transaction) => {
      transaction.updateRunDispatch({
        repositoryKey: run.repositoryKey,
        runId: run.runId,
        status: run.status === "pending" ? "no-op" : run.status,
        startedAt: run.startedAt,
        finishedAt: ctx.now().toISOString(),
        providerId: run.providerId ?? "unknown",
        workerThreadId: threadId ?? "never-dispatched",
        projectId: run.projectId ?? "unknown",
        environmentId: run.environmentId ?? "unknown",
        repositoryRevision: run.repositoryRevision,
      });
      if (lease.status !== "released") {
        transaction.updateOwnershipLease({ ...lease, status: "released" });
      }
    });
    return actionSuccess({
      status: "accepted",
      message: `Run '${run.runId}' had no live worker; its lease was released.`,
      revision: run.repositoryRevision,
      runId: run.runId,
      leaseId: lease.leaseId,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, run.repositoryRevision);
  }

  try {
    await ctx.sdk.threads.stop({ threadId });
  } catch (error) {
    return actionError("internal", `Could not stop worker thread '${threadId}': ${errorMessage(error)}`);
  }

  ctx.store.withTransaction((transaction) => {
    transaction.updateRunDispatch({
      repositoryKey: run.repositoryKey,
      runId: run.runId,
      status: "cancel-requested",
      startedAt: run.startedAt,
      finishedAt: null,
      providerId: run.providerId!,
      workerThreadId: threadId,
      projectId: run.projectId!,
      environmentId: run.environmentId!,
      repositoryRevision: run.repositoryRevision,
    });
    for (const attempt of detail.attempts) {
      if (attempt.status === "started") {
        transaction.updateDispatchAttempt({ ...attempt, status: "cancel-requested" });
      }
    }
    transaction.updateOwnershipLease({ ...lease, status: "release-requested" });
  });

  return actionSuccess({
    status: "accepted",
    message: `Cancellation requested for run '${run.runId}'. Ownership releases when the worker stops.`,
    revision: run.repositoryRevision,
    runId: run.runId,
    leaseId: lease.leaseId,
    queueItemId: null,
    action: "stop",
    questionId: null,
    interactionId: null,
  }, run.repositoryRevision);
}
