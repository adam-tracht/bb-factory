import { randomUUID } from "node:crypto";
import type {
  CanonicalFileRecordLink,
  FactoryActionResult,
  ProtocolSnapshot,
  ProviderId,
  ReasoningLevel,
  RepositoryKey,
  RepositoryRevision,
  RunIntent,
} from "../contracts.js";
import { actionError, actionSuccess, errorMessage, sameRevision, staleRevisionError } from "../actions/results.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import { repositoryLabel } from "../repository-label.js";
import { GlobalConcurrencyLimitError, IdempotencyConflictError, type OperationalTransaction } from "../storage/index.js";
import { OwnershipHeldError } from "./ownership.js";
import { hostPreflight, selectExplicitProvider, selectProvider, type ProviderSelection } from "./preflight.js";
import { boundedDiagnostic, dispatcherNowSeconds, nightKeyAt, nightState, RECONCILIATION_GRACE_MS, runDispatchUpdate, spawnEnvironment, withWorkerOperation, type DispatchContext } from "./types.js";

export interface StartRunInput {
  readonly repositoryKey: RepositoryKey;
  readonly trigger: RunIntent["trigger"];
  readonly idempotencyKey: string;
  /**
   * Callers that hold a live snapshot may assert it. Scheduled and recovery
   * dispatch omit it and use the freshly loaded revision instead.
   */
  readonly expectedRevision?: RepositoryRevision;
  readonly preflightedSnapshot?: ProtocolSnapshot;
  /**
   * A manual run-now may pin the execution triple; the action schema delivers
   * it all-or-none. Omitting it keeps the preference/rotation path.
   */
  readonly providerOverride?: {
    readonly providerId: ProviderId;
    readonly model: string;
    readonly reasoningLevel: ReasoningLevel;
  };
  readonly serviceTier?: "default" | "fast";
}

export interface StartRunResult {
  readonly result: FactoryActionResult;
  readonly runId: string | null;
  readonly leaseId: string | null;
}

export const FOREMAN_PROMPT =
  "Factory run. Read plans/factory/foreman.md first, then plans/factory/repo.md, and execute one run following the protocol. Your thread id is in $BB_THREAD_ID.";

function runTitle(repositoryKey: string, displayName: string | undefined, providerId: string): string {
  return `factory foreman: ${repositoryLabel(repositoryKey, displayName)} ${providerId}`;
}

function noSpawn(
  result: FactoryActionResult,
): StartRunResult {
  return { result, runId: null, leaseId: null };
}

function ownsPendingSpawnGeneration(
  transaction: OperationalTransaction,
  generation: {
    readonly repositoryKey: RepositoryKey;
    readonly runId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly requestedAt: string;
    readonly providerId: string;
    readonly model: string;
    readonly reasoningLevel: string;
    readonly projectId: string | null;
    readonly environmentId: string | null;
    readonly repositoryRevision: RepositoryRevision;
    readonly canonicalRecords: readonly CanonicalFileRecordLink[];
    readonly queueItemIds: readonly string[];
    readonly leaseAuthorizationProvenance: readonly string[];
    readonly acquiredAt: string;
    readonly expiresAt: string;
  },
): boolean {
  const run = transaction.getRunSummary(generation.runId);
  const attempt = transaction.getActiveAttempt(generation.runId);
  const lease = transaction.getLeaseForRun(generation.runId);
  const matched = run?.runId === generation.runId
    && run.repositoryKey === generation.repositoryKey
    && run.requestedAt === generation.requestedAt
    && run.status === "pending"
    && run.startedAt === null
    && run.finishedAt === null
    && run.workerThreadId === null
    && run.providerId === null
    && run.projectId === generation.projectId
    && run.environmentId === generation.environmentId
    && sameRevision(run.repositoryRevision, generation.repositoryRevision)
    && sameJson(run.canonicalRecords, generation.canonicalRecords)
    && sameJson(run.queueItemIds, generation.queueItemIds)
    && attempt?.attemptId === generation.attemptId
    && attempt.runId === generation.runId
    && attempt.repositoryKey === generation.repositoryKey
    && attempt.status === "pending"
    && attempt.workerThreadId === null
    && attempt.providerId === generation.providerId
    && attempt.model === generation.model
    && attempt.reasoningLevel === generation.reasoningLevel
    && lease?.leaseId === generation.leaseId
    && lease.repositoryKey === generation.repositoryKey
    && lease.runId === generation.runId
    && sameJson(lease.queueItemIds, generation.queueItemIds)
    && sameJson(lease.authorizationProvenance, generation.leaseAuthorizationProvenance)
    && lease.acquiredAt === generation.acquiredAt
    && lease.expiresAt === generation.expiresAt
    && lease.status === "held"
    && lease.workerThreadId === null;
  return matched;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function quarantineLateSpawn(
  ctx: DispatchContext,
  input: {
    readonly repositoryKey: RepositoryKey;
    readonly runId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly threadId: string;
    readonly requestedAt: string;
    readonly providerId: string;
    readonly model: string;
    readonly reasoningLevel: string;
    readonly repositoryRevision: RepositoryRevision;
    readonly canonicalRecords: readonly CanonicalFileRecordLink[];
    readonly queueItemIds: readonly string[];
    readonly leaseAuthorizationProvenance: readonly string[];
    readonly projectId: string;
    readonly environmentId: string | null;
    readonly acquiredAt: string;
    readonly expiresAt: string;
  },
): Promise<void> {
  let attached = false;
  const detail = (await ctx.store.getRun({ repositoryKey: input.repositoryKey, runId: input.runId })).run;
  if (detail) {
    attached = ctx.store.withTransaction((transaction) => {
      const currentRun = transaction.getRunSummary(input.runId);
      const status = currentRun?.status ?? null;
      const attempt = transaction.getDispatchAttempt(input.attemptId);
      const lease = transaction.getLeaseForRun(input.runId);
      const terminalStatus = status === "no-op" || status === "failed-safe";
      const cancellableStatus = status === "cancel-requested";
      const reconcilingStatus = status === "reconciliation-required";
      const expectedAttemptStatus = terminalStatus
        ? status
        : cancellableStatus
          ? "cancel-requested"
          : reconcilingStatus
            ? "reconciliation-required"
            : null;
      const allowedLeaseStatus = terminalStatus || reconcilingStatus
        ? "reconciliation-required"
        : cancellableStatus
          ? "release-requested"
          : null;
      const leaseWorkerIsUnresolved = lease?.workerThreadId === null
        || lease?.workerThreadId === "unknown-thread"
        || lease?.workerThreadId === "spawn-ambiguous"
        || lease?.workerThreadId === "never-dispatched";
      if (!status || status === "pending" || !expectedAttemptStatus || !allowedLeaseStatus
        || !currentRun
        || currentRun.repositoryKey !== input.repositoryKey
        || currentRun.requestedAt !== input.requestedAt
        || currentRun.startedAt !== null
        || !sameRevision(currentRun.repositoryRevision, input.repositoryRevision)
        || !sameJson(currentRun.canonicalRecords, input.canonicalRecords)
        || !sameJson(currentRun.queueItemIds, input.queueItemIds)
        || !attempt
        || attempt.runId !== input.runId
        || attempt.attemptId !== input.attemptId
        || attempt.repositoryKey !== input.repositoryKey
        || attempt.providerId !== input.providerId
        || attempt.model !== input.model
        || attempt.reasoningLevel !== input.reasoningLevel
        || attempt.status !== expectedAttemptStatus
        || attempt.workerThreadId !== null
        || !lease
        || lease.leaseId !== input.leaseId
        || lease.repositoryKey !== input.repositoryKey
        || lease.runId !== input.runId
        || !sameJson(lease.queueItemIds, input.queueItemIds)
        || !sameJson(lease.authorizationProvenance, input.leaseAuthorizationProvenance)
        || lease.status !== allowedLeaseStatus
        || !leaseWorkerIsUnresolved) return false;
      transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
        status,
        finishedAt: currentRun.finishedAt,
        workerThreadId: input.threadId,
      }));
      transaction.updateDispatchAttempt({ ...attempt, workerThreadId: input.threadId });
      transaction.updateOwnershipLease({ ...lease, workerThreadId: input.threadId });
      return true;
    });
  }

  const safeToStop = ctx.store.withTransaction((transaction) => {
    const currentOwner = transaction.getCurrentOwnership(input.repositoryKey);
    if (!currentOwner) return true;
    if (currentOwner.workerThreadId !== input.threadId) return true;
    if (currentOwner.runId !== input.runId || currentOwner.leaseId !== input.leaseId) return false;
    const currentRun = transaction.getRunSummary(input.runId);
    const currentAttempt = transaction.getDispatchAttempt(input.attemptId);
    const currentLease = transaction.getLeaseForRun(input.runId);
    const terminalStatus = currentRun?.status === "no-op" || currentRun?.status === "failed-safe";
    const expectedAttemptStatus = terminalStatus
      ? currentRun?.status
      : currentRun?.status === "cancel-requested"
        ? "cancel-requested"
        : currentRun?.status === "reconciliation-required"
          ? "reconciliation-required"
          : null;
    const expectedLeaseStatus = terminalStatus || currentRun?.status === "reconciliation-required"
      ? "reconciliation-required"
      : currentRun?.status === "cancel-requested"
        ? "release-requested"
        : null;
    return expectedAttemptStatus !== null
      && expectedLeaseStatus !== null
      && currentRun !== null
      && currentRun.repositoryKey === input.repositoryKey
      && currentRun.requestedAt === input.requestedAt
      && currentRun.startedAt === null
      && (currentRun.providerId === input.providerId || currentRun.providerId === "unknown")
      && currentRun.workerThreadId === input.threadId
      && (currentRun.projectId === input.projectId || currentRun.projectId === "unknown")
      && (currentRun.environmentId === input.environmentId || currentRun.environmentId === null)
      && sameRevision(currentRun.repositoryRevision, input.repositoryRevision)
      && sameJson(currentRun.canonicalRecords, input.canonicalRecords)
      && sameJson(currentRun.queueItemIds, input.queueItemIds)
      && currentAttempt !== null
      && currentAttempt.attemptId === input.attemptId
      && currentAttempt.runId === input.runId
      && currentAttempt.repositoryKey === input.repositoryKey
      && currentAttempt.providerId === input.providerId
      && currentAttempt.model === input.model
      && currentAttempt.reasoningLevel === input.reasoningLevel
      && currentAttempt.workerThreadId === input.threadId
      && currentAttempt.status === expectedAttemptStatus
      && currentLease !== null
      && currentLease.leaseId === input.leaseId
      && currentLease.repositoryKey === input.repositoryKey
      && currentLease.runId === input.runId
      && sameJson(currentLease.queueItemIds, input.queueItemIds)
      && sameJson(currentLease.authorizationProvenance, input.leaseAuthorizationProvenance)
      && currentLease.acquiredAt === input.acquiredAt
      && currentLease.expiresAt === input.expiresAt
      && currentLease.workerThreadId === input.threadId
      && currentLease.status === expectedLeaseStatus;
  });
  if (!safeToStop) {
    ctx.log?.(`run ${input.runId}: did not stop late spawn '${input.threadId}' because a newer lease owns that worker id`);
    return;
  }

  try {
    await withWorkerOperation(ctx, input.threadId, "stop", () => ctx.sdk.threads.stop({ threadId: input.threadId }));
    ctx.log?.(`run ${input.runId}: stopped late spawn '${input.threadId}' after generation ${input.attemptId} became stale${attached ? "; lease remains quarantined" : ""}`);
  } catch (error) {
    ctx.log?.(`run ${input.runId}: late spawn '${input.threadId}' could not be stopped: ${errorMessage(error)}${attached ? "; lease remains quarantined" : "; no durable lease was available"}`);
  }
}

async function markSpawnAmbiguous(
  ctx: DispatchContext,
  input: {
    repositoryKey: RepositoryKey;
    runId: string;
    leaseId: string;
    attemptId: string;
    requestedAt: string;
    expiresAt: string;
    provider: ProviderSelection;
    revision: RepositoryRevision;
    projectId: string;
    environmentId: string | null;
    canonicalRecords: readonly CanonicalFileRecordLink[];
    queueItemIds: readonly string[];
    leaseAuthorizationProvenance: readonly string[];
  },
  error: unknown,
): Promise<StartRunResult> {
  const message = `Worker spawn for run '${input.runId}' failed ambiguously: ${errorMessage(error)}. The thread may exist; the run was marked for reconciliation instead of retried.`;
  ctx.log?.(message);
  const detectedAt = ctx.now();
  const applied = ctx.store.withTransaction((transaction) => {
    if (!ownsPendingSpawnGeneration(transaction, {
      ...input,
      requestedAt: input.requestedAt,
      providerId: input.provider.providerId,
      model: input.provider.model,
      reasoningLevel: input.provider.reasoningLevel,
      projectId: null,
      environmentId: null,
      repositoryRevision: input.revision,
      canonicalRecords: input.canonicalRecords,
      queueItemIds: input.queueItemIds,
      leaseAuthorizationProvenance: input.leaseAuthorizationProvenance,
      acquiredAt: input.requestedAt,
      expiresAt: input.expiresAt,
    })) return false;
    transaction.recordReconciliation({
      runId: input.runId,
      firstDetectedAt: detectedAt.toISOString(),
      deadlineAt: new Date(detectedAt.getTime() + RECONCILIATION_GRACE_MS).toISOString(),
      reasonCode: "ambiguous-worker-spawn",
      rawObservation: boundedDiagnostic(message, 512),
    });
    transaction.updateRunDispatch({
      repositoryKey: input.repositoryKey,
      runId: input.runId,
      status: "reconciliation-required",
      startedAt: null,
      finishedAt: null,
      providerId: input.provider.providerId,
      workerThreadId: "spawn-ambiguous",
      projectId: input.projectId,
      environmentId: input.environmentId,
      repositoryRevision: input.revision,
    });
    transaction.updateDispatchAttempt({
      attemptId: input.attemptId,
      runId: input.runId,
      repositoryKey: input.repositoryKey,
      providerId: input.provider.providerId,
      model: input.provider.model,
      reasoningLevel: input.provider.reasoningLevel,
      workerThreadId: "spawn-ambiguous",
      status: "reconciliation-required",
      startedAt: null,
      finishedAt: ctx.now().toISOString(),
    });
    const lease = transaction.getLeaseForRun(input.runId);
    if (!lease || lease.leaseId !== input.leaseId) return false;
    transaction.updateOwnershipLease({ ...lease, workerThreadId: "spawn-ambiguous", status: "reconciliation-required" });
    return true;
  });
  if (!applied) {
    ctx.log?.(`run ${input.runId}: ignored stale ambiguous spawn result for generation ${input.attemptId}`);
    return {
      result: actionError("conflict", `The ambiguous spawn result for run '${input.runId}' was stale and was ignored.`),
      runId: input.runId,
      leaseId: input.leaseId,
    };
  }
  return {
    result: actionError("internal", message),
    runId: input.runId,
    leaseId: input.leaseId,
  };
}

export async function startRun(ctx: DispatchContext, input: StartRunInput): Promise<StartRunResult> {
  const entry = ctx.repositoryLookup(input.repositoryKey);
  if (!entry) {
    return noSpawn(actionError("not-found", `Repository '${input.repositoryKey}' is not configured.`));
  }

  // A recorded run under the same key replays its durable outcome even when
  // dispatch is now paused or the repository has moved on.
  const priorRunId = ctx.store.findRunIdByIdempotencyKey(input.idempotencyKey);
  if (priorRunId !== null) {
    const prior = (await ctx.store.getRun({ repositoryKey: input.repositoryKey, runId: priorRunId })).run;
    return alreadyRecorded(priorRunId, prior?.summary.repositoryRevision ?? null);
  }

  if (ctx.settings.dispatchMode !== "enabled") {
    return noSpawn(actionError("paused", "Dispatch is paused. Set dispatchMode to enabled before starting runs."));
  }
  if (entry.dispatchPaused === true) {
    return noSpawn(actionError("paused", `Dispatch is paused for repository '${input.repositoryKey}'. Resume it in Settings before starting runs.`));
  }
  const configuration = entry.configuration;

  let snapshot: ProtocolSnapshot;
  try {
    snapshot = input.preflightedSnapshot ?? await ctx.protocolReader.loadSnapshot(configuration);
  } catch (error) {
    return noSpawn(actionError("internal", `Could not read the repository protocol: ${errorMessage(error)}`));
  }
  if (input.expectedRevision && !sameRevision(snapshot.revision, input.expectedRevision)) {
    return noSpawn(staleRevisionError(
      `Repository '${input.repositoryKey}' changed since the run was requested.`,
      input.expectedRevision,
      snapshot.revision,
    ));
  }

  const preflight = await hostPreflight(ctx, input.repositoryKey);
  if (!preflight.ok) {
    const category = "status" in preflight && preflight.status === "offline" ? "host-unavailable" : "checkout-invalid";
    return noSpawn(actionError(category, `Dispatch preflight failed: ${preflight.reasons.join(" ")}`));
  }

  let providers;
  try {
    providers = await ctx.healthReader.listProviderStatus(input.repositoryKey);
  } catch (error) {
    return noSpawn(actionError("provider-unavailable", `Could not read provider health: ${errorMessage(error)}`));
  }
  const nightKey = nightKeyAt(ctx.now(), ctx.settings.nightWindowEndHour);
  const dispatcherState = nightState(ctx.store.getDispatcherState(input.repositoryKey), nightKey);
  const nowS = dispatcherNowSeconds(ctx.now);
  const provider = input.providerOverride === undefined
    ? selectProvider(providers, dispatcherState, ctx.settings.providerPreference, nightKey, nowS, ctx.settings.providerModelDefaults, ctx.settings.providerRotation)
    : selectExplicitProvider(providers, dispatcherState, input.providerOverride, nowS);
  if (!provider) {
    return noSpawn(actionError(
      "provider-unavailable",
      input.providerOverride === undefined
        ? "No usable provider is available right now. Reported providers may be unavailable, limited, missing a model, or lack full permissions."
        : `Provider '${input.providerOverride.providerId}' is not usable right now. It may be unavailable, limited, missing a model, or lack full permissions.`,
    ));
  }

  const eligible = snapshot.queue.filter((item) => item.eligible);
  const authorizationProvenance = eligible.map((item) => ({
    queueItemId: item.id,
    source: (item.approved.kind === "explicit" ? "queue.approved" : "none") as "queue.approved" | "none",
    approvedText: item.approved.kind === "explicit" ? item.approved.text : null,
  }));
  const runId = `run-${randomUUID()}`;
  const attemptId = `attempt-${randomUUID()}`;
  const leaseId = `lease-${randomUUID()}`;
  const requestedAt = ctx.now().toISOString();
  const expiresAt = new Date(ctx.now().getTime() + ctx.settings.runtimeCapSeconds * 1000).toISOString();
  const intent: RunIntent = {
    runId,
    repositoryKey: input.repositoryKey,
    trigger: input.trigger,
    idempotencyKey: input.idempotencyKey as RunIntent["idempotencyKey"],
    requestedAt,
    baseRevision: snapshot.revision,
    queueItemIds: eligible.map((item) => item.id),
    authorizationProvenance,
  };
  const canonicalRecords = eligible.map((item) => ({
    relativePath: PROTOCOL_PATHS.queue,
    recordType: "queue-entry" as const,
    recordId: item.id,
    repositoryRevision: snapshot.revision,
  }));

  let created: boolean;
  let persistedRunId = runId;
  try {
    created = ctx.store.withTransaction((transaction) => {
      const inserted = transaction.createRunIntent({ intent, canonicalRecords });
      if (!inserted.created) {
        persistedRunId = inserted.runId;
        return false;
      }
      transaction.assertGlobalCapacity(ctx.settings.concurrencyLimit, runId);
      transaction.createOwnershipLease({
        leaseId,
        repositoryKey: input.repositoryKey,
        runId,
        queueItemIds: intent.queueItemIds,
        workerThreadId: null,
        authorizationProvenance: intent.queueItemIds,
        acquiredAt: requestedAt,
        expiresAt,
        status: "held",
      });
      transaction.createDispatchAttempt({
        attemptId,
        runId,
        repositoryKey: input.repositoryKey,
        providerId: provider.providerId,
        model: provider.model,
        reasoningLevel: provider.reasoningLevel,
        workerThreadId: null,
        status: "pending",
        startedAt: null,
        finishedAt: null,
      });
      return true;
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return noSpawn(actionError("idempotency-conflict", errorMessage(error)));
    }
    if (error instanceof OwnershipHeldError) {
      return noSpawn(actionError("conflict", errorMessage(error)));
    }
    if (error instanceof GlobalConcurrencyLimitError) {
      return noSpawn(actionError("conflict", errorMessage(error)));
    }
    const message = errorMessage(error);
    if (message.includes("UNIQUE") || message.includes("unique")) {
      return noSpawn(actionError("conflict", `Repository '${input.repositoryKey}' already has an active run.`));
    }
    return noSpawn(actionError("internal", `Could not persist the run intent: ${message}`));
  }

  if (!created) {
    return alreadyRecorded(persistedRunId, snapshot.revision);
  }

  let threadId: string;
  // bb registers an unmanaged environment for a host-workspace spawn and
  // returns its id on the thread; a pinned environment id reuses instead.
  let environmentId: string | null;
  // Caller-picked inputs are marked explicit so the server does not re-derive
  // the project's stored execution defaults over them.
  const executionInputSources: {
    providerId?: "explicit";
    model?: "explicit";
    reasoningLevel?: "explicit";
    serviceTier?: "explicit";
  } = {};
  if (input.providerOverride !== undefined) {
    executionInputSources.providerId = "explicit";
    executionInputSources.model = "explicit";
    executionInputSources.reasoningLevel = "explicit";
  }
  if (input.serviceTier !== undefined) executionInputSources.serviceTier = "explicit";
  try {
    const spawned = await ctx.sdk.threads.spawn({
      projectId: entry.projectId,
      environment: spawnEnvironment(entry),
      prompt: FOREMAN_PROMPT,
      providerId: provider.providerId,
      model: provider.model,
      reasoningLevel: provider.reasoningLevel,
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      permissionMode: "full",
      title: runTitle(input.repositoryKey, entry.displayName, provider.providerId),
      ...(Object.keys(executionInputSources).length === 0 ? {} : { executionInputSources }),
    });
    threadId = spawned.id;
    environmentId = entry.environmentId ?? spawned.environmentId;
  } catch (error) {
    return markSpawnAmbiguous(ctx, {
      repositoryKey: input.repositoryKey,
      runId,
      leaseId,
      attemptId,
      requestedAt,
      expiresAt,
      provider,
      revision: snapshot.revision,
      projectId: entry.projectId,
      environmentId: entry.environmentId ?? null,
      canonicalRecords,
      queueItemIds: intent.queueItemIds,
      leaseAuthorizationProvenance: intent.queueItemIds,
    }, error);
  }

  const startedAt = ctx.now().toISOString();
  const applied = ctx.store.withTransaction((transaction) => {
    if (!ownsPendingSpawnGeneration(transaction, {
      repositoryKey: input.repositoryKey,
      runId,
      attemptId,
      leaseId,
      requestedAt,
      providerId: provider.providerId,
      model: provider.model,
      reasoningLevel: provider.reasoningLevel,
      projectId: null,
      environmentId: null,
      repositoryRevision: snapshot.revision,
      canonicalRecords,
      queueItemIds: intent.queueItemIds,
      leaseAuthorizationProvenance: intent.queueItemIds,
      acquiredAt: requestedAt,
      expiresAt,
    })) return false;
    transaction.updateRunDispatch({
      repositoryKey: input.repositoryKey,
      runId,
      status: "started",
      startedAt,
      finishedAt: null,
      providerId: provider.providerId,
      workerThreadId: threadId,
      projectId: entry.projectId,
      environmentId,
      repositoryRevision: snapshot.revision,
    });
    transaction.updateDispatchAttempt({
      attemptId,
      runId,
      repositoryKey: input.repositoryKey,
      providerId: provider.providerId,
      model: provider.model,
      reasoningLevel: provider.reasoningLevel,
      workerThreadId: threadId,
      status: "started",
      startedAt,
      finishedAt: null,
    });
    const lease = transaction.getLeaseForRun(runId)!;
    transaction.updateOwnershipLease({ ...lease, workerThreadId: threadId });
    const state = ctx.store.getDispatcherState(input.repositoryKey);
    transaction.saveDispatcherState({
      ...nightState(state, nightKey),
      lastStartAt: dispatcherNowSeconds(ctx.now),
      // An explicit manual pick still advances the cursor, so the next alternate step skips it.
      lastStartProvider: provider.providerId,
    });
    return true;
  });
  if (!applied) {
    ctx.log?.(`run ${runId}: ignored stale spawn success for generation ${attemptId}`);
    await quarantineLateSpawn(ctx, {
      repositoryKey: input.repositoryKey,
      runId,
      attemptId,
      leaseId,
      threadId,
      requestedAt,
      providerId: provider.providerId,
      model: provider.model,
      reasoningLevel: provider.reasoningLevel,
      repositoryRevision: snapshot.revision,
      canonicalRecords,
      queueItemIds: intent.queueItemIds,
      leaseAuthorizationProvenance: intent.queueItemIds,
      projectId: entry.projectId,
      environmentId: entry.environmentId ?? null,
      acquiredAt: requestedAt,
      expiresAt,
    });
    return {
      result: actionError("conflict", `The spawn result for run '${runId}' was stale and was ignored.`),
      runId,
      leaseId,
    };
  }

  return {
    result: actionSuccess({
      status: "accepted",
      message: `Started foreman run on ${provider.providerId} (${provider.reason}).`,
      revision: snapshot.revision,
      runId,
      leaseId,
      queueItemId: null,
      action: "run-now",
      questionId: null,
      interactionId: null,
    }, snapshot.revision),
    runId,
    leaseId,
  };
}

function alreadyRecorded(runId: string, revision: RepositoryRevision | null): StartRunResult {
  return {
    result: actionSuccess({
      status: "already-applied",
      message: `Run '${runId}' was already recorded for this idempotency key.`,
      revision,
      runId,
      leaseId: null,
      queueItemId: null,
      action: "run-now",
      questionId: null,
      interactionId: null,
    }, revision),
    runId,
    leaseId: null,
  };
}
