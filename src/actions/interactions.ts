import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  bbInteractionActionRequestSchema,
  type BbInteractionActionRequest,
  type BbInteractionResolution,
  type FactoryActionResult,
  type PendingInteraction,
  type RepositoryKey,
} from "../contracts.js";
import type { BbInteractionActionExecutor, PendingInteractionReader } from "../ports.js";
import type { DispatchEngine } from "../dispatch/index.js";
import {
  type OperationalStateStore,
  type PendingActionIntentRecord,
  type PendingActionIntentTarget,
} from "../storage/index.js";
import { actionError, actionSuccess, errorMessage } from "./results.js";
import { claimErrorResult, completeIntent, consumedResult, deepEqual, reconcileIntent, recordedIntentResult } from "./intents.js";

type ThreadsApi = BbPluginApi["sdk"]["threads"];
type SdkPendingInteraction = Awaited<ReturnType<ThreadsApi["interactions"]["get"]>>;
type InteractionAnswers = Extract<BbInteractionResolution, { kind: "user_answer" }>["answers"];

export interface InteractionScope {
  readonly projectId: string;
  readonly environmentId: string;
}

export interface BbInteractionActionExecutorOptions {
  readonly threads: ThreadsApi;
  readonly store: OperationalStateStore;
  readonly interactionReader: PendingInteractionReader;
  readonly scopeLookup: (repositoryKey: RepositoryKey) => InteractionScope | null;
  readonly dispatch: DispatchEngine;
  readonly setDispatchMode: (mode: "enabled" | "paused") => Promise<void>;
}

interface LocatedInteraction {
  readonly interaction: SdkPendingInteraction;
  readonly pending: PendingInteraction | null;
}

/** True when the resolved state BB recorded matches the validated intent. */
function resolutionMatches(intent: BbInteractionResolution, observed: SdkPendingInteraction["resolution"]): boolean {
  if (intent.kind === "approval") {
    if (observed === null || typeof observed !== "object" || !("decision" in observed)) return false;
    return (observed as { decision?: unknown }).decision === intent.decision;
  }
  if (intent.kind === "user_answer") {
    if (observed === null || typeof observed !== "object" || (observed as { kind?: unknown }).kind !== "user_answer") return false;
    const answers = (observed as { answers?: unknown }).answers;
    return deepEqual(answers ?? {}, intent.answers);
  }
  return false;
}

function observedContractResolution(observed: SdkPendingInteraction["resolution"]): BbInteractionResolution | null {
  if (observed === null || typeof observed !== "object") return null;
  const record = observed as { kind?: unknown; decision?: unknown; answers?: unknown };
  if (record.kind === "user_answer" && record.answers !== null && typeof record.answers === "object") {
    return { kind: "user_answer", answers: record.answers as InteractionAnswers };
  }
  if (record.decision === "allow_once" || record.decision === "allow_for_session" || record.decision === "deny") {
    return { kind: "approval", decision: record.decision };
  }
  return null;
}

function sdkResolution(resolution: BbInteractionResolution): Parameters<ThreadsApi["interactions"]["resolve"]>[0]["resolution"] {
  if (resolution.kind === "user_answer") {
    return { kind: "user_answer", answers: resolution.answers };
  }
  if (resolution.decision === "deny") {
    return { decision: "deny" };
  }
  return { decision: resolution.decision, grantedPermissions: null };
}

/**
 * Validate the requested resolution against the pending metadata so an
 * invalid resolution is rejected before any external call.
 */
function validateResolution(interaction: PendingInteraction, resolution: BbInteractionResolution): FactoryActionResult | null {
  const metadata = interaction.metadata;
  if (metadata.kind === "approval") {
    if (resolution.kind !== "approval" || !metadata.availableDecisions.includes(resolution.decision)) {
      return actionError(
        "invalid-input",
        `Approval resolution must use one of the offered decisions: ${metadata.availableDecisions.join(", ") || "none"}.`,
      );
    }
    return null;
  }
  if (metadata.kind === "user_question") {
    if (resolution.kind !== "user_answer") {
      return actionError("invalid-input", "A user-question interaction requires a user_answer resolution.");
    }
    for (const [questionId, answer] of Object.entries(resolution.answers)) {
      const question = metadata.questions.find((candidate) => candidate.id === questionId);
      if (!question) {
        return actionError("invalid-input", `Question '${questionId}' is not part of this interaction.`);
      }
      const selected = answer.selected ?? [];
      const optionValues = new Set((question.options ?? []).map((option) => option.value));
      if (!question.multiSelect && selected.length > 1) {
        return actionError("invalid-input", `Question '${questionId}' accepts at most one selected option.`);
      }
      if (selected.some((value) => !optionValues.has(value))) {
        return actionError("invalid-input", `Question '${questionId}' received an option that was not offered.`);
      }
      if (answer.freeText !== undefined && !question.allowFreeText) {
        return actionError("invalid-input", `Question '${questionId}' does not allow free text.`);
      }
      if (selected.length === 0 && answer.freeText === undefined) {
        return actionError("invalid-input", `Question '${questionId}' needs a selected option or free text.`);
      }
    }
    return null;
  }
  return actionError("unsupported", `Interaction kind '${interaction.kind}' cannot be resolved through the factory contract.`);
}

export function createBbInteractionActionExecutor(options: BbInteractionActionExecutorOptions): BbInteractionActionExecutor {
  const { threads, store, interactionReader, scopeLookup, dispatch, setDispatchMode } = options;

  /**
   * Reads the local pending-interaction projection. A read failure is kept as
   * an error string instead of null so a caller can distinguish "not pending"
   * from "could not verify"; unresolved interactions fail closed on it.
   */
  async function findPending(repositoryKey: RepositoryKey, interactionId: string): Promise<{ interaction: PendingInteraction | null; readError: string | null }> {
    try {
      const projection = await interactionReader.listPendingInteractions(repositoryKey);
      return { interaction: projection.interactions.find((candidate) => candidate.interactionId === interactionId) ?? null, readError: null };
    } catch (error) {
      return { interaction: null, readError: errorMessage(error) };
    }
  }

  /** Locate a (possibly already-resolved) interaction by scanning project threads. */
  async function locateInteraction(scope: InteractionScope, interactionId: string): Promise<LocatedInteraction | null> {
    const listed = await threads.list({ projectId: scope.projectId, archived: false, includeHidden: true });
    for (const thread of listed) {
      if (thread.environmentId !== scope.environmentId) continue;
      const interactions = await threads.interactions.list({ threadId: thread.id });
      const found = interactions.find((candidate) => candidate.id === interactionId);
      if (found) return { interaction: found, pending: null };
    }
    return null;
  }

  async function guarded(
    request: BbInteractionActionRequest,
    target: PendingActionIntentTarget,
    perform: (record: PendingActionIntentRecord) => Promise<FactoryActionResult>,
  ): Promise<FactoryActionResult> {
    let record: PendingActionIntentRecord;
    try {
      record = store.claimPendingActionIntent({ request, target }).record;
    } catch (error) {
      return claimErrorResult(error, request.idempotencyKey);
    }
    if (record.status === "completed" || record.status === "reconciliation-required") {
      return consumedResult(record);
    }
    let consumption;
    try {
      consumption = store.consumePendingActionIntent(request.idempotencyKey);
    } catch (error) {
      return claimErrorResult(error, request.idempotencyKey);
    }
    if (!consumption.consumed) return consumedResult(consumption.record);
    try {
      return await perform(consumption.record);
    } catch (error) {
      // The external side effect may already have happened. Do not let an
      // ambiguous failure leave the intent resolving or get retried blindly.
      reconcileIntent(store, consumption.record, `Unhandled executor failure: ${errorMessage(error)}`);
      return actionError("internal", `The action failed after claiming intent '${request.idempotencyKey}': ${errorMessage(error)}`, request.idempotencyKey);
    }
  }

  async function answerInteraction(
    request: BbInteractionActionRequest,
  ): Promise<FactoryActionResult> {
    const action = request.action as Extract<BbInteractionActionRequest["action"], { kind: "answer-question" }>;
    const scope = scopeLookup(request.repositoryKey);
    if (!scope) {
      return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
    }
    const { interaction: pending, readError: pendingReadError } = await findPending(request.repositoryKey, action.interactionId);
    if (pending) {
      const invalid = validateResolution(pending, action.resolution);
      if (invalid) return invalid;
    }

    let located: LocatedInteraction | null;
    if (pending) {
      const interaction = await threads.interactions.get({ threadId: pending.threadId, interactionId: pending.interactionId });
      located = { interaction, pending };
    } else {
      located = await locateInteraction(scope, action.interactionId);
    }
    if (!located) {
      return actionError("not-found", `BB interaction '${action.interactionId}' was not found in the configured scope.`, request.idempotencyKey);
    }

    const target: PendingActionIntentTarget = {
      kind: "bb-interaction",
      interactionId: action.interactionId,
      threadId: located.interaction.threadId,
      turnId: located.interaction.turnId,
    };

    return guarded(request, target, async (record) => {
      const resolution = action.resolution;
      const describe = `interaction '${action.interactionId}' on thread '${located!.interaction.threadId}'`;
      const accept = (message: string) => actionSuccess({
        status: "accepted",
        message,
        revision: request.expectedRevision ?? null,
        runId: null,
        leaseId: null,
        queueItemId: null,
        action: "answer-question",
        source: "bb-interaction" as const,
        questionId: null,
        interactionId: action.interactionId,
      }, request.expectedRevision ?? null);

      const finishIfResolved = (interaction: SdkPendingInteraction): FactoryActionResult | null => {
        if (interaction.status === "resolved") {
          if (resolutionMatches(resolution, interaction.resolution)) {
            return completeIntent(store, record, accept(`Resolved ${describe}.`), {
              observedStatus: "resolved",
              observedResolution: observedContractResolution(interaction.resolution),
            });
          }
          return reconcileIntent(store, record, `Resolved ${describe} with a different value than requested.`, {
            observedStatus: "resolved",
            observedResolution: observedContractResolution(interaction.resolution),
          });
        }
        return null;
      };

      const resolvedNow = finishIfResolved(located!.interaction);
      if (resolvedNow) return resolvedNow;
      if (located!.interaction.status === "interrupted") {
        return reconcileIntent(store, record, `Cannot resolve ${describe}: it is interrupted (${located!.interaction.statusReason ?? "no reason recorded"}).`, {
          observedStatus: "interrupted",
        });
      }
      if (located!.interaction.status === "resolving") {
        return reconcileIntent(store, record, `Cannot resolve ${describe}: it is already resolving.`, {
          observedStatus: "resolving",
        });
      }

      if (pendingReadError) {
        // The interaction is still pending but its metadata could not be
        // verified, so the resolution cannot be validated. Fail closed rather
        // than submit an unvalidated answer to BB.
        return completeIntent(store, record, actionError(
          "internal",
          `Cannot validate the resolution for ${describe}: the pending-interaction read failed: ${pendingReadError}`,
          request.idempotencyKey,
        ));
      }

      let resolved: SdkPendingInteraction;
      try {
        resolved = await threads.interactions.resolve({
          threadId: located!.interaction.threadId,
          interactionId: located!.interaction.id,
          resolution: sdkResolution(resolution),
        });
      } catch (error) {
        try {
          const again = await threads.interactions.get({ threadId: located!.interaction.threadId, interactionId: located!.interaction.id });
          const done = finishIfResolved(again);
          if (done) return done;
          if (again.status === "resolving") {
            return reconcileIntent(store, record, `Resolve of ${describe} failed while it was resolving: ${errorMessage(error)}.`, {
              observedStatus: "resolving",
            });
          }
          if (again.status === "interrupted") {
            return reconcileIntent(store, record, `Resolve of ${describe} raced with an interruption: ${errorMessage(error)}.`, {
              observedStatus: "interrupted",
            });
          }
          return completeIntent(store, record, actionError("internal", `Resolve of ${describe} failed before it applied: ${errorMessage(error)}`, request.idempotencyKey), {
            observedStatus: "pending",
          });
        } catch (verifyError) {
          return reconcileIntent(store, record, `Resolve of ${describe} failed and the result could not be observed: ${errorMessage(verifyError)}.`);
        }
      }

      const done = finishIfResolved(resolved);
      if (done) return done;
      if (resolved.status === "resolving") {
        try {
          const again = await threads.interactions.get({ threadId: located!.interaction.threadId, interactionId: located!.interaction.id });
          const rechecked = finishIfResolved(again);
          if (rechecked) return rechecked;
        } catch {
          // falls through to reconciliation below
        }
        return reconcileIntent(store, record, `Resolve of ${describe} is still resolving; reconcile before submitting again.`, {
          observedStatus: "resolving",
        });
      }
      return reconcileIntent(store, record, `Resolve of ${describe} returned an unexpected status '${resolved.status}'.`);
    });
  }

  async function execute(request: BbInteractionActionRequest): Promise<FactoryActionResult> {
    const parsed = bbInteractionActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return actionError("invalid-input", `Invalid BB action request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const valid = parsed.data;
    const action = valid.action;

    const recorded = recordedIntentResult(store, valid);
    if (recorded) return recorded;

    if (action.kind === "answer-question") {
      try {
        return await answerInteraction(valid);
      } catch (error) {
        return actionError("internal", `Could not answer the BB interaction: ${errorMessage(error)}`, valid.idempotencyKey);
      }
    }

    const target: PendingActionIntentTarget = action.kind === "retry"
      ? { kind: "attempt", attemptId: action.attemptId }
      : { kind: "repository" };

    return guarded(valid, target, async (record) => {
      let result: FactoryActionResult;
      switch (action.kind) {
        case "run-now":
          result = await dispatch.requestRun({
            repositoryKey: valid.repositoryKey,
            trigger: "manual",
            idempotencyKey: valid.idempotencyKey,
            expectedRevision: valid.expectedRevision,
          });
          break;
        case "pause":
        case "resume": {
          try {
            await setDispatchMode(action.kind === "pause" ? "paused" : "enabled");
            result = actionSuccess({
              status: "accepted",
              message: action.kind === "pause"
                ? "Dispatch paused. Active runs keep running; no new runs start until resumed."
                : "Dispatch enabled.",
              revision: valid.expectedRevision ?? null,
              runId: null,
              leaseId: null,
              queueItemId: null,
              action: action.kind,
              questionId: null,
              interactionId: null,
            }, valid.expectedRevision ?? null);
          } catch (error) {
            result = actionError("internal", `Could not update dispatch mode: ${errorMessage(error)}`, valid.idempotencyKey);
          }
          break;
        }
        case "retry":
          result = await dispatch.requestRetry({
            repositoryKey: valid.repositoryKey,
            attemptId: action.attemptId,
            expectedRevision: valid.expectedRevision,
          });
          break;
        case "stop":
          result = await dispatch.requestStop(valid.repositoryKey);
          break;
      }
      return completeIntent(store, record, result);
    });
  }

  return { execute };
}
