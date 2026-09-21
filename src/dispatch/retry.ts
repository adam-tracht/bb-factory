import { randomUUID } from "node:crypto";
import type { FactoryActionResult, OperationalRunSummary, RepositoryKey, RepositoryRevision } from "../contracts.js";
import { actionError, actionSuccess, errorMessage, sameRevision, staleRevisionError } from "../actions/results.js";
import { GlobalConcurrencyLimitError, type OperationalTransaction } from "../storage/index.js";
import { boundedDiagnostic, MAX_RUN_ATTEMPTS, RECONCILIATION_GRACE_MS, runDispatchUpdate, sameJson, withWorkerOperation, type DispatchContext } from "./types.js";

export interface RetryAttemptInput {
  readonly repositoryKey: RepositoryKey;
  readonly attemptId: string;
  readonly expectedRevision?: RepositoryRevision;
}

function ownsPendingRetryGeneration(
  transaction: OperationalTransaction,
  generation: {
    readonly repositoryKey: RepositoryKey;
    readonly runId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerThreadId: string;
    readonly runRequestedAt: string;
    readonly runStartedAt: string | null;
    readonly runProviderId: string | null;
    readonly runProjectId: string | null;
    readonly runEnvironmentId: string | null;
    readonly runQueueItemIds: readonly string[];
    readonly runRepositoryRevision: OperationalRunSummary["repositoryRevision"];
    readonly runCanonicalRecords: OperationalRunSummary["canonicalRecords"];
    readonly attemptStartedAt: string;
    readonly attemptProviderId: string;
    readonly attemptModel: string;
    readonly attemptReasoningLevel: string;
    readonly leaseAcquiredAt: string;
    readonly leaseExpiresAt: string;
    readonly leaseQueueItemIds: readonly string[];
    readonly leaseAuthorizationProvenance: readonly string[];
  },
): boolean {
  const run = transaction.getRunSummary(generation.runId);
  const attempt = transaction.getActiveAttempt(generation.runId);
  const lease = transaction.getLeaseForRun(generation.runId);
  return run?.runId === generation.runId
    && run.repositoryKey === generation.repositoryKey
    && run.status === "started"
    && run.requestedAt === generation.runRequestedAt
    && run.startedAt === generation.runStartedAt
    && run.finishedAt === null
    && run.providerId === generation.runProviderId
    && run.workerThreadId === generation.workerThreadId
    && run.projectId === generation.runProjectId
    && run.environmentId === generation.runEnvironmentId
    && sameJson(run.queueItemIds, generation.runQueueItemIds)
    && sameRevision(run.repositoryRevision, generation.runRepositoryRevision)
    && sameJson(run.canonicalRecords, generation.runCanonicalRecords)
    && attempt?.attemptId === generation.attemptId
    && attempt.runId === generation.runId
    && attempt.repositoryKey === generation.repositoryKey
    && attempt.status === "pending"
    && attempt.providerId === generation.attemptProviderId
    && attempt.model === generation.attemptModel
    && attempt.reasoningLevel === generation.attemptReasoningLevel
    && attempt.workerThreadId === generation.workerThreadId
    && attempt.startedAt === generation.attemptStartedAt
    && attempt.finishedAt === null
    && lease?.leaseId === generation.leaseId
    && lease.repositoryKey === generation.repositoryKey
    && lease.runId === generation.runId
    && lease.status === "held"
    && sameJson(lease.queueItemIds, generation.leaseQueueItemIds)
    && sameJson(lease.authorizationProvenance, generation.leaseAuthorizationProvenance)
    && lease.workerThreadId === generation.workerThreadId
    && lease.acquiredAt === generation.leaseAcquiredAt
    && lease.expiresAt === generation.leaseExpiresAt;
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
  if (detail.attempts.some((candidate) => ["pending", "started", "cancel-requested", "reconciliation-required"].includes(candidate.status))) {
    return actionError("conflict", `Run '${run.runId}' already has an active retry attempt.`);
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
  if (existingLease.status !== "released") {
    return actionError("conflict", `Run '${run.runId}' cannot be retried while its repository lease is quarantined.`);
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

  const retryAttemptId = `attempt-${randomUUID()}`;
  const retryGenerationStartedAt = ctx.now().toISOString();
  const pendingAttempt = {
    attemptId: retryAttemptId,
    runId: run.runId,
    repositoryKey: input.repositoryKey,
    providerId: attempt.providerId,
    model: attempt.model,
    reasoningLevel: attempt.reasoningLevel,
    workerThreadId: threadId,
    status: "pending" as const,
    // This is the generation fence timestamp, not proof that the provider
    // already accepted the retry. The pending status remains the in-flight
    // guard while the external call is unresolved.
    startedAt: retryGenerationStartedAt,
    finishedAt: null,
  };

  // Fence stale reconciliation passes before the external retry. The pending
  // attempt is the new generation, so an old pass cannot finalize it.
  const resumedExpiresAt = new Date(ctx.now().getTime() + ctx.settings.runtimeCapSeconds * 1000).toISOString();
  const retryGeneration = {
    repositoryKey: input.repositoryKey,
    runId: run.runId,
    attemptId: retryAttemptId,
    leaseId: existingLease.leaseId,
    workerThreadId: threadId,
    runRequestedAt: run.requestedAt,
    runStartedAt: run.startedAt,
    runProviderId: run.providerId,
    runProjectId: run.projectId,
    runEnvironmentId: run.environmentId,
    runQueueItemIds: run.queueItemIds,
    runRepositoryRevision: run.repositoryRevision,
    runCanonicalRecords: run.canonicalRecords,
    attemptStartedAt: retryGenerationStartedAt,
    attemptProviderId: pendingAttempt.providerId,
    attemptModel: pendingAttempt.model,
    attemptReasoningLevel: pendingAttempt.reasoningLevel,
    leaseAcquiredAt: existingLease.acquiredAt,
    leaseExpiresAt: resumedExpiresAt,
    leaseQueueItemIds: existingLease.queueItemIds,
    leaseAuthorizationProvenance: existingLease.authorizationProvenance,
  };
  try {
    ctx.store.withTransaction((transaction) => {
      const currentLease = transaction.getLeaseForRun(run.runId);
      const currentRun = transaction.getRunSummary(run.runId);
      if (!currentLease
        || currentLease.leaseId !== existingLease.leaseId
        || currentLease.repositoryKey !== existingLease.repositoryKey
        || currentLease.runId !== existingLease.runId
        || currentLease.status !== existingLease.status
        || !sameJson(currentLease.queueItemIds, existingLease.queueItemIds)
        || !sameJson(currentLease.authorizationProvenance, existingLease.authorizationProvenance)
        || currentLease.workerThreadId !== existingLease.workerThreadId
        || currentLease.acquiredAt !== existingLease.acquiredAt
        || currentLease.expiresAt !== existingLease.expiresAt) {
        throw new Error(`ownership for run '${run.runId}' changed before retry`);
      }
      if (!currentRun
        || currentRun.repositoryKey !== run.repositoryKey
        || currentRun.requestedAt !== run.requestedAt
        || currentRun.startedAt !== run.startedAt
        || currentRun.finishedAt !== run.finishedAt
        || currentRun.providerId !== run.providerId
        || currentRun.workerThreadId !== run.workerThreadId
        || currentRun.projectId !== run.projectId
        || currentRun.environmentId !== run.environmentId
        || !sameJson(currentRun.queueItemIds, run.queueItemIds)
        || !sameRevision(currentRun.repositoryRevision, run.repositoryRevision)
        || !sameJson(currentRun.canonicalRecords, run.canonicalRecords)
        || currentRun.status !== "failed-safe") {
        throw new Error(`run '${run.runId}' changed before retry`);
      }
      if (transaction.getActiveAttempt(run.runId) !== null) {
        throw new Error(`run '${run.runId}' already has an active retry attempt`);
      }
      transaction.assertGlobalCapacity(ctx.settings.concurrencyLimit, run.runId);
      transaction.resetReconciliation(run.runId);
      transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
        status: "started",
        finishedAt: null,
        workerThreadId: threadId,
      }));
      transaction.createDispatchAttempt(pendingAttempt);
      transaction.updateOwnershipLease({
        ...currentLease,
        workerThreadId: threadId,
        expiresAt: resumedExpiresAt,
        status: "held",
      });
    });
  } catch (error) {
    if (error instanceof GlobalConcurrencyLimitError) {
      return actionError("conflict", errorMessage(error));
    }
    return actionError("conflict", `Could not re-acquire ownership for run '${run.runId}': ${errorMessage(error)}`);
  }

  try {
    await withWorkerOperation(ctx, threadId, "retry", () => ctx.sdk.threads.retry({ threadId, reason: `factory retry of attempt '${input.attemptId}'` }));
  } catch (error) {
    const applied = ctx.store.withTransaction((transaction) => {
      if (!ownsPendingRetryGeneration(transaction, retryGeneration)) return false;
      const currentRun = transaction.getRunSummary(run.runId);
      const currentAttempt = transaction.getActiveAttempt(run.runId);
      const currentLease = transaction.getLeaseForRun(run.runId);
      if (!currentRun || !currentAttempt || !currentLease || currentAttempt.attemptId !== retryAttemptId) return false;
      const detectedAt = ctx.now();
      const detectedAtIso = detectedAt.toISOString();
      transaction.recordReconciliation({
        runId: run.runId,
        firstDetectedAt: detectedAtIso,
        deadlineAt: new Date(detectedAt.getTime() + RECONCILIATION_GRACE_MS).toISOString(),
        reasonCode: "retry-ambiguous",
        rawObservation: boundedDiagnostic(`retry of '${threadId}' failed ambiguously: ${errorMessage(error)}`, 512),
      });
      transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
        status: "reconciliation-required",
        finishedAt: detectedAtIso,
        workerThreadId: threadId,
      }));
      transaction.updateDispatchAttempt({ ...currentAttempt, status: "reconciliation-required", finishedAt: detectedAtIso });
      transaction.updateOwnershipLease({ ...currentLease, status: "reconciliation-required" });
      return true;
    });
    if (!applied) {
      ctx.log?.(`run ${run.runId}: ignored stale retry failure for generation ${retryAttemptId}`);
    }
    return actionError("internal", boundedDiagnostic(`Retry of worker thread '${threadId}' failed: ${errorMessage(error)}`, 512));
  }

  const startedAt = ctx.now().toISOString();
  const applied = ctx.store.withTransaction((transaction) => {
    if (!ownsPendingRetryGeneration(transaction, retryGeneration)) return false;
    const currentAttempt = transaction.getActiveAttempt(run.runId);
    if (!currentAttempt || currentAttempt.attemptId !== retryAttemptId) return false;
    transaction.updateDispatchAttempt({ ...currentAttempt, status: "started", startedAt });
    const currentRun = transaction.getRunSummary(run.runId);
    if (!currentRun) return false;
    transaction.updateRunDispatch(runDispatchUpdate(currentRun, { status: "started", finishedAt: null, workerThreadId: threadId }));
    return true;
  });
  if (!applied) {
    ctx.log?.(`run ${run.runId}: ignored stale retry success for generation ${retryAttemptId}`);
    return actionError("conflict", `The retry result for run '${run.runId}' was stale and was ignored.`);
  }

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
