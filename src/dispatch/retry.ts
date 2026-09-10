import { randomUUID } from "node:crypto";
import type { FactoryActionResult, RepositoryKey, RepositoryRevision } from "../contracts.js";
import { actionError, actionSuccess, errorMessage, sameRevision, staleRevisionError } from "../actions/results.js";
import { MAX_RUN_ATTEMPTS, type DispatchContext } from "./types.js";

export interface RetryAttemptInput {
  readonly repositoryKey: RepositoryKey;
  readonly attemptId: string;
  readonly expectedRevision?: RepositoryRevision;
}

/**
 * Retry a failed dispatch attempt by re-submitting the worker thread's failed
 * turn through `threads.retry`, which reuses the original message by
 * reference. Bounded by MAX_RUN_ATTEMPTS per run; a new attempt row records
 * the retry so the attempt history stays auditable.
 */
export async function retryAttempt(ctx: DispatchContext, input: RetryAttemptInput): Promise<FactoryActionResult> {
  const attempt = ctx.store.getDispatchAttempt(input.attemptId);
  if (!attempt) {
    return actionError("not-found", `Dispatch attempt '${input.attemptId}' is not recorded.`);
  }
  if (attempt.repositoryKey !== input.repositoryKey) {
    return actionError("invalid-input", `Dispatch attempt '${input.attemptId}' belongs to a different repository.`);
  }
  const detail = (await ctx.store.getRun({ repositoryKey: input.repositoryKey, runId: attempt.runId })).run;
  if (!detail) {
    return actionError("not-found", `Run '${attempt.runId}' for attempt '${input.attemptId}' is not recorded.`);
  }
  const run = detail.summary;
  if (run.status !== "failed-safe") {
    return actionError("conflict", `Run '${run.runId}' is '${run.status}', not failed-safe; only failed runs can be retried.`);
  }
  if (detail.attempts.filter((candidate) => candidate.status !== "pending").length >= MAX_RUN_ATTEMPTS) {
    return actionError("conflict", `Run '${run.runId}' has used its retry budget of ${MAX_RUN_ATTEMPTS} attempts.`);
  }
  const threadId = attempt.workerThreadId;
  if (!threadId || threadId === "spawn-ambiguous") {
    return actionError("conflict", `Attempt '${input.attemptId}' has no worker thread to retry.`);
  }
  const existingLease = ctx.store.getLeaseForRun(run.runId);
  if (!existingLease) {
    return actionError("internal", `Run '${run.runId}' has no ownership lease to resume.`);
  }
  const current = ctx.store.getCurrentOwnership(input.repositoryKey);
  if (current && current.runId !== run.runId) {
    return actionError("conflict", `Repository '${input.repositoryKey}' has an active run '${current.runId}'; retry after it finishes.`);
  }

  if (input.expectedRevision) {
    const entry = ctx.repositoryLookup(input.repositoryKey);
    if (entry) {
      try {
        const snapshot = await ctx.protocolReader.loadSnapshot(entry.configuration);
        if (!sameRevision(snapshot.revision, input.expectedRevision)) {
          return staleRevisionError(
            `Repository '${input.repositoryKey}' changed since the retry was requested.`,
            input.expectedRevision,
            snapshot.revision,
          );
        }
      } catch (error) {
        return actionError("internal", `Could not re-read the repository protocol: ${errorMessage(error)}`);
      }
    }
  }

  let threadStatus: string;
  try {
    threadStatus = (await ctx.sdk.threads.get({ threadId })).status;
  } catch (error) {
    return actionError("internal", `Could not read worker thread '${threadId}': ${errorMessage(error)}`);
  }
  if (threadStatus !== "error") {
    return actionError("conflict", `Worker thread '${threadId}' is '${threadStatus}', not in a retryable error state.`);
  }

  // Re-acquire ownership before the external retry so a concurrent start
  // cannot interleave a second run while this worker resumes.
  const resumedExpiresAt = new Date(ctx.now().getTime() + ctx.settings.runtimeCapSeconds * 1000).toISOString();
  try {
    ctx.store.updateOwnershipLease({
      ...existingLease,
      workerThreadId: threadId,
      expiresAt: resumedExpiresAt,
      status: "held",
    });
  } catch (error) {
    return actionError("conflict", `Could not re-acquire ownership for run '${run.runId}': ${errorMessage(error)}`);
  }

  try {
    await ctx.sdk.threads.retry({ threadId, reason: `factory retry of attempt '${input.attemptId}'` });
  } catch (error) {
    ctx.store.updateOwnershipLease({ ...existingLease, status: "released" });
    return actionError("internal", `Retry of worker thread '${threadId}' failed: ${errorMessage(error)}`);
  }

  const retryAttemptId = `attempt-${randomUUID()}`;
  const startedAt = ctx.now().toISOString();
  ctx.store.withTransaction((transaction) => {
    transaction.createDispatchAttempt({
      attemptId: retryAttemptId,
      runId: run.runId,
      repositoryKey: input.repositoryKey,
      providerId: attempt.providerId,
      model: attempt.model,
      reasoningLevel: attempt.reasoningLevel,
      workerThreadId: threadId,
      status: "started",
      startedAt,
      finishedAt: null,
    });
    transaction.updateRunDispatch({
      repositoryKey: run.repositoryKey,
      runId: run.runId,
      status: "started",
      startedAt: run.startedAt,
      finishedAt: null,
      providerId: run.providerId!,
      workerThreadId: threadId,
      projectId: run.projectId!,
      environmentId: run.environmentId!,
      repositoryRevision: run.repositoryRevision,
    });
  });

  return actionSuccess({
    status: "accepted",
    message: `Retry dispatched on worker thread '${threadId}' as attempt '${retryAttemptId}'.`,
    revision: run.repositoryRevision,
    runId: run.runId,
    leaseId: null,
    queueItemId: null,
    action: "retry",
    questionId: null,
    interactionId: null,
  }, run.repositoryRevision);
}
