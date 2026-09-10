import type { FactoryActionResult, RepositoryKey } from "../contracts.js";
import { actionError, actionSuccess, errorMessage } from "../actions/results.js";
import { runDispatchUpdate, type DispatchContext } from "./types.js";

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
  if (run.status === "reconciliation-required") {
    // The recorded worker state is ambiguous: a thread may exist without a
    // known identity, so the lease must not be released until an operator
    // resolves the run's recorded worker state.
    return actionError(
      "conflict",
      `Run '${run.runId}' is marked for reconciliation; its worker state must be resolved before ownership can be released.`,
    );
  }
  if (run.status !== "started" || !threadId) {
    // The run was never dispatched or already finished: no side effect to undo.
    // A pending run with a recorded worker thread means the start update was
    // lost after spawn; keep ownership and require reconciliation instead.
    if (run.status === "pending" && threadId && threadId !== "spawn-ambiguous") {
      ctx.store.withTransaction((transaction) => {
        transaction.updateRunDispatch(runDispatchUpdate(run, { status: "reconciliation-required", finishedAt: null, workerThreadId: threadId }));
        transaction.updateOwnershipLease({ ...lease, status: "reconciliation-required" });
      });
      return actionError(
        "conflict",
        `Run '${run.runId}' has a recorded worker thread but no confirmed start; it was marked for reconciliation instead of releasing ownership.`,
      );
    }
    ctx.store.withTransaction((transaction) => {
      transaction.updateRunDispatch(runDispatchUpdate(run, {
        status: run.status === "pending" ? "no-op" : run.status,
        finishedAt: ctx.now().toISOString(),
        workerThreadId: threadId ?? "never-dispatched",
      }));
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
    transaction.updateRunDispatch(runDispatchUpdate(run, { status: "cancel-requested", finishedAt: null, workerThreadId: threadId }));
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
