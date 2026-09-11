import { randomUUID } from "node:crypto";
import type {
  FactoryActionResult,
  ProtocolSnapshot,
  RepositoryKey,
  RepositoryRevision,
  RunIntent,
} from "../contracts.js";
import { actionError, actionSuccess, errorMessage, sameRevision, staleRevisionError } from "../actions/results.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import { IdempotencyConflictError } from "../storage/index.js";
import { OwnershipHeldError } from "./ownership.js";
import { hostPreflight, selectProvider, type ProviderSelection } from "./preflight.js";
import { dispatcherNowSeconds, nightKeyAt, nightState, spawnEnvironment, type DispatchContext } from "./types.js";

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
}

export interface StartRunResult {
  readonly result: FactoryActionResult;
  readonly runId: string | null;
  readonly leaseId: string | null;
}

export const FOREMAN_PROMPT =
  "Factory run. Read plans/factory/foreman.md first, then plans/factory/repo.md, and execute one run following the protocol. Your thread id is in $BB_THREAD_ID.";

function runTitle(repositoryKey: string, providerId: string): string {
  return `factory foreman: ${repositoryKey} ${providerId}`;
}

function noSpawn(
  result: FactoryActionResult,
): StartRunResult {
  return { result, runId: null, leaseId: null };
}

async function markSpawnAmbiguous(
  ctx: DispatchContext,
  input: {
    repositoryKey: RepositoryKey;
    runId: string;
    leaseId: string;
    attemptId: string;
    provider: ProviderSelection;
    revision: RepositoryRevision;
    projectId: string;
    environmentId: string | null;
  },
  error: unknown,
): Promise<StartRunResult> {
  const message = `Worker spawn for run '${input.runId}' failed ambiguously: ${errorMessage(error)}. The thread may exist; the run was marked for reconciliation instead of retried.`;
  ctx.log?.(message);
  ctx.store.withTransaction((transaction) => {
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
    const lease = ctx.store.getCurrentOwnership(input.repositoryKey);
    if (lease && lease.runId === input.runId) {
      transaction.updateOwnershipLease({ ...lease, status: "reconciliation-required" });
    }
  });
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
  const provider = selectProvider(providers, dispatcherState, ctx.settings.providerPreference, nightKey, dispatcherNowSeconds(ctx.now));
  if (!provider) {
    return noSpawn(actionError(
      "provider-unavailable",
      "No factory provider is available right now. Both providers are unavailable or marked limited.",
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
  try {
    const spawned = await ctx.sdk.threads.spawn({
      projectId: entry.projectId,
      environment: spawnEnvironment(entry),
      prompt: FOREMAN_PROMPT,
      providerId: provider.providerId,
      model: provider.model,
      reasoningLevel: provider.reasoningLevel,
      permissionMode: "full",
      title: runTitle(input.repositoryKey, provider.providerId),
    });
    threadId = spawned.id;
    environmentId = entry.environmentId ?? spawned.environmentId;
  } catch (error) {
    return markSpawnAmbiguous(ctx, {
      repositoryKey: input.repositoryKey,
      runId,
      leaseId,
      attemptId,
      provider,
      revision: snapshot.revision,
      projectId: entry.projectId,
      environmentId: entry.environmentId ?? null,
    }, error);
  }

  const startedAt = ctx.now().toISOString();
  ctx.store.withTransaction((transaction) => {
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
    const lease = ctx.store.getCurrentOwnership(input.repositoryKey);
    if (lease && lease.runId === runId) {
      transaction.updateOwnershipLease({ ...lease, workerThreadId: threadId });
    }
    const state = ctx.store.getDispatcherState(input.repositoryKey);
    transaction.saveDispatcherState({
      ...nightState(state, nightKey),
      lastStartAt: dispatcherNowSeconds(ctx.now),
      lastStartProvider: provider.providerId,
    });
  });

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
