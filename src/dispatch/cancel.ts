import { randomUUID } from "node:crypto";
import type { FactoryActionResult, RepositoryKey } from "../contracts.js";
import { actionError, actionSuccess, errorMessage, sameRevision } from "../actions/results.js";
import type { DispatchAttempt, OperationalRunSummary, OwnershipLease } from "../contracts.js";
import { finalizeCancelledRun, releaseQuarantinedOwnership } from "./lifecycle.js";
import { runDispatchUpdate, sameJson, withWorkerOperation, type DispatchContext } from "./types.js";
import type { StopIntent } from "../storage/index.js";

export interface StopRunInput {
  readonly repositoryKey: RepositoryKey;
}

interface StopGeneration {
  readonly intent: StopIntent;
  readonly run: OperationalRunSummary;
  readonly attempt: DispatchAttempt;
  readonly lease: OwnershipLease;
  readonly workerThreadId: string;
}

function ownsQuarantinedWorker(
  ctx: DispatchContext,
  detail: NonNullable<Awaited<ReturnType<DispatchContext["store"]["getRun"]>>["run"]>,
  lease: NonNullable<ReturnType<DispatchContext["store"]["getCurrentOwnership"]>>,
  threadId: string,
): boolean {
  const run = detail.summary;
  const attempt = [...detail.attempts].reverse().find((candidate) => candidate.runId === run.runId);
  if (!attempt) return false;
  return ctx.store.withTransaction((transaction) => {
    const currentRun = transaction.getRunSummary(run.runId);
    const currentLease = transaction.getLeaseForRun(run.runId);
    const currentAttempt = transaction.getDispatchAttempt(attempt.attemptId);
    return currentRun !== null
      && currentRun.runId === run.runId
      && currentRun.repositoryKey === run.repositoryKey
      && currentRun.requestedAt === run.requestedAt
      && currentRun.startedAt === run.startedAt
      && currentRun.finishedAt === run.finishedAt
      && currentRun.providerId === run.providerId
      && currentRun.workerThreadId === run.workerThreadId
      && currentRun.projectId === run.projectId
      && currentRun.environmentId === run.environmentId
      && sameJson(currentRun.queueItemIds, run.queueItemIds)
      && sameRevision(currentRun.repositoryRevision, run.repositoryRevision)
      && sameJson(currentRun.canonicalRecords, run.canonicalRecords)
      && ["completed", "blocked", "failed-safe", "no-op"].includes(currentRun.status)
      && currentAttempt !== null
      && currentAttempt.attemptId === attempt.attemptId
      && currentAttempt.runId === attempt.runId
      && currentAttempt.repositoryKey === attempt.repositoryKey
      && currentAttempt.providerId === attempt.providerId
      && currentAttempt.model === attempt.model
      && currentAttempt.reasoningLevel === attempt.reasoningLevel
      && currentAttempt.workerThreadId === threadId
      && currentAttempt.status === attempt.status
      && currentAttempt.startedAt === attempt.startedAt
      && currentAttempt.finishedAt === attempt.finishedAt
      && currentLease !== null
      && currentLease.leaseId === lease.leaseId
      && currentLease.repositoryKey === lease.repositoryKey
      && currentLease.runId === lease.runId
      && sameJson(currentLease.queueItemIds, lease.queueItemIds)
      && sameJson(currentLease.authorizationProvenance, lease.authorizationProvenance)
      && currentLease.workerThreadId === threadId
      && currentLease.acquiredAt === lease.acquiredAt
      && currentLease.expiresAt === lease.expiresAt
      && currentLease.status === "reconciliation-required";
  });
}

function transitionToCancelRequested(
  ctx: DispatchContext,
  detail: NonNullable<Awaited<ReturnType<DispatchContext["store"]["getRun"]>>["run"]>,
  lease: NonNullable<ReturnType<DispatchContext["store"]["getCurrentOwnership"]>>,
  expectedRunStatus: "pending" | "started",
  expectedAttemptStatus: "pending" | "started",
  workerThreadId: string | null,
): StopGeneration | null {
  const run = detail.summary;
  const attempt = [...detail.attempts].reverse().find((candidate) =>
    candidate.runId === run.runId
      && ["pending", "started"].includes(candidate.status),
  );
  if (!attempt || workerThreadId === null) return null;
  return ctx.store.withTransaction((transaction) => {
    const currentRun = transaction.getRunSummary(run.runId);
    if (!currentRun
      || currentRun.repositoryKey !== run.repositoryKey
      || currentRun.requestedAt !== run.requestedAt
      || currentRun.startedAt !== run.startedAt
      || currentRun.finishedAt !== run.finishedAt
      || currentRun.workerThreadId !== run.workerThreadId
      || currentRun.status !== expectedRunStatus) return null;
    const currentAttempt = transaction.getActiveAttempt(run.runId);
    const currentLease = transaction.getLeaseForRun(run.runId);
    if (!currentAttempt
      || currentAttempt.attemptId !== attempt.attemptId
      || currentAttempt.runId !== attempt.runId
      || currentAttempt.repositoryKey !== attempt.repositoryKey
      || currentAttempt.providerId !== attempt.providerId
      || currentAttempt.model !== attempt.model
      || currentAttempt.reasoningLevel !== attempt.reasoningLevel
      || currentAttempt.status !== expectedAttemptStatus
      || currentAttempt.workerThreadId !== workerThreadId
      || currentAttempt.startedAt !== attempt.startedAt
      || currentAttempt.finishedAt !== attempt.finishedAt
      || !currentLease
      || currentLease.leaseId !== lease.leaseId
      || currentLease.repositoryKey !== run.repositoryKey
      || currentLease.runId !== run.runId
      || sameJson(currentLease.queueItemIds, lease.queueItemIds) === false
      || sameJson(currentLease.authorizationProvenance, lease.authorizationProvenance) === false
      || currentLease.acquiredAt !== lease.acquiredAt
      || currentLease.expiresAt !== lease.expiresAt
      || currentLease.status !== "held"
      || currentLease.workerThreadId !== workerThreadId) return null;
    if (currentRun.providerId !== run.providerId
      || currentRun.projectId !== run.projectId
      || currentRun.environmentId !== run.environmentId
      || !sameJson(currentRun.queueItemIds, run.queueItemIds)
      || !sameRevision(currentRun.repositoryRevision, run.repositoryRevision)
      || !sameJson(currentRun.canonicalRecords, run.canonicalRecords)) return null;
    transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
      status: "cancel-requested",
      finishedAt: null,
      workerThreadId,
    }));
    transaction.updateDispatchAttempt({ ...currentAttempt, status: "cancel-requested" });
    transaction.updateOwnershipLease({ ...currentLease, status: "release-requested" });
    const intent: StopIntent = {
      token: randomUUID(),
      runId: run.runId,
      attemptId: currentAttempt.attemptId,
      leaseId: currentLease.leaseId,
      repositoryKey: run.repositoryKey,
      workerThreadId,
      createdAt: new Date().toISOString(),
    };
    transaction.createStopIntent(intent);
    return { intent, run: currentRun, attempt: currentAttempt, lease: currentLease, workerThreadId };
  });
}

function settleStopIntent(ctx: DispatchContext, generation: StopGeneration): boolean {
  return ctx.store.withTransaction((transaction) => {
    const intent = transaction.getStopIntent(generation.run.runId);
    const currentRun = transaction.getRunSummary(generation.run.runId);
    const currentAttempt = transaction.getDispatchAttempt(generation.attempt.attemptId);
    const currentLease = transaction.getLeaseForRun(generation.run.runId);
    const stillOwns = intent?.token === generation.intent.token
      && intent.attemptId === generation.attempt.attemptId
      && intent.leaseId === generation.lease.leaseId
      && intent.repositoryKey === generation.run.repositoryKey
      && intent.workerThreadId === generation.workerThreadId
      && currentRun?.runId === generation.run.runId
      && currentRun.repositoryKey === generation.run.repositoryKey
      && currentRun.requestedAt === generation.run.requestedAt
      && currentRun.startedAt === generation.run.startedAt
      && currentRun.finishedAt === null
      && currentRun.providerId === generation.run.providerId
      && currentRun.workerThreadId === generation.workerThreadId
      && currentRun.projectId === generation.run.projectId
      && currentRun.environmentId === generation.run.environmentId
      && sameJson(currentRun.queueItemIds, generation.run.queueItemIds)
      && sameRevision(currentRun.repositoryRevision, generation.run.repositoryRevision)
      && sameJson(currentRun.canonicalRecords, generation.run.canonicalRecords)
      && currentRun.status === "cancel-requested"
      && currentAttempt?.attemptId === generation.attempt.attemptId
      && currentAttempt.runId === generation.attempt.runId
      && currentAttempt.repositoryKey === generation.attempt.repositoryKey
      && currentAttempt.providerId === generation.attempt.providerId
      && currentAttempt.model === generation.attempt.model
      && currentAttempt.reasoningLevel === generation.attempt.reasoningLevel
      && currentAttempt.workerThreadId === generation.workerThreadId
      && currentAttempt.status === "cancel-requested"
      && currentAttempt.startedAt === generation.attempt.startedAt
      && currentAttempt.finishedAt === null
      && currentLease?.leaseId === generation.lease.leaseId
      && currentLease.repositoryKey === generation.lease.repositoryKey
      && currentLease.runId === generation.lease.runId
      && sameJson(currentLease.queueItemIds, generation.lease.queueItemIds)
      && sameJson(currentLease.authorizationProvenance, generation.lease.authorizationProvenance)
      && currentLease.workerThreadId === generation.workerThreadId
      && currentLease.acquiredAt === generation.lease.acquiredAt
      && currentLease.expiresAt === generation.lease.expiresAt
      && currentLease.status === "release-requested";
    if (!stillOwns) return false;
    transaction.deleteStopIntent(generation.intent.token);
    return true;
  });
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

  if (run.status === "failed-safe" && lease.status === "reconciliation-required") {
    const workerThreadId = lease.workerThreadId;
    if (workerThreadId === null
      || workerThreadId === "spawn-ambiguous"
      || workerThreadId === "unknown-thread"
      || workerThreadId === "never-dispatched") {
      const released = releaseQuarantinedOwnership(ctx, input.repositoryKey);
      if (!released) {
        return actionError(
          "conflict",
          `Run '${run.runId}' is failed-safe but its unknown worker lease can be released only after the durable quarantine timeout while repository dispatch is paused.`,
        );
      }
      return actionSuccess({
        status: "accepted",
        message: `Released the quarantined repository lease for failed-safe run '${run.runId}'.`,
        revision: run.repositoryRevision,
        runId: run.runId,
        leaseId: lease.leaseId,
        queueItemId: null,
        action: "stop",
        questionId: null,
        interactionId: null,
      }, run.repositoryRevision);
    }
    if (!ownsQuarantinedWorker(ctx, detail, lease, workerThreadId)) {
      return actionError("conflict", `The quarantined worker for run '${run.runId}' is no longer owned by this lease.`);
    }
    try {
      await withWorkerOperation(ctx, workerThreadId, "stop", () => ctx.sdk.threads.stop({ threadId: workerThreadId }));
    } catch (error) {
      return actionError("internal", `Could not stop quarantined worker thread '${workerThreadId}': ${errorMessage(error)}`);
    }
    return actionSuccess({
      status: "accepted",
      message: `Stop requested for quarantined worker '${workerThreadId}'. Ownership remains quarantined until termination is observed.`,
      revision: run.repositoryRevision,
      runId: run.runId,
      leaseId: lease.leaseId,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, run.repositoryRevision);
  }

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
  if (run.status === "pending" && !threadId) {
    const applied = finalizeCancelledRun(ctx, detail, { releaseLease: false, workerThreadId: "never-dispatched" });
    if (!applied) {
      return actionError("conflict", `Cancellation for run '${run.runId}' was stale and was not applied.`);
    }
    return actionSuccess({
      status: "accepted",
      message: `Cancellation recorded for run '${run.runId}'; its repository lease remains quarantined until the spawn attempt is settled.`,
      revision: run.repositoryRevision,
      runId: run.runId,
      leaseId: lease.leaseId,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, run.repositoryRevision);
  }

  if ((run.status !== "started" && run.status !== "pending") || !threadId) {
    return actionSuccess({
      status: "already-applied",
      message: `Run '${run.runId}' is already settled; ownership reconciliation will release the lease when safe.`,
      revision: run.repositoryRevision,
      runId: run.runId,
      leaseId: lease.leaseId,
      queueItemId: null,
      action: "stop",
      questionId: null,
      interactionId: null,
    }, run.repositoryRevision);
  }

  const expectedRunStatus = run.status;
  const expectedAttemptStatus = attemptStatusForCancellation(detail);
  const generation = transitionToCancelRequested(
    ctx,
    detail,
    lease,
    expectedRunStatus,
    expectedAttemptStatus,
    threadId,
  );
  if (generation === null) {
    return actionError("conflict", `Cancellation for run '${run.runId}' was stale and was not applied.`);
  }
  let stopError: unknown = null;
  try {
    await withWorkerOperation(ctx, threadId, "stop", () => ctx.sdk.threads.stop({ threadId }));
  } catch (error) {
    stopError = error;
  }

  if (!settleStopIntent(ctx, generation)) {
    return actionError("conflict", `Cancellation for run '${run.runId}' was stale and was not applied.`);
  }
  if (stopError !== null) {
    return actionError("internal", `Could not stop worker thread '${threadId}': ${errorMessage(stopError)}`);
  }

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

function attemptStatusForCancellation(
  detail: NonNullable<Awaited<ReturnType<DispatchContext["store"]["getRun"]>>["run"]>,
): "pending" | "started" {
  const attempt = [...detail.attempts].reverse().find((candidate) =>
    candidate.runId === detail.summary.runId && ["pending", "started"].includes(candidate.status),
  );
  return attempt?.status === "pending" ? "pending" : "started";
}
