import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  bbInteractionActionRequestSchema,
  type BbInteractionActionRequest,
  type BbInteractionResolution,
  type FactoryActionResult,
  type PendingInteraction,
  type ProtocolSnapshot,
  type Question,
  type RepositoryConfiguration,
  type RepositoryKey,
  type RepositoryRegistryEntry,
} from "../contracts.js";
import type { BbInteractionActionExecutor, PendingInteractionReader, ProtocolReader } from "../ports.js";
import type { DispatchEngine } from "../dispatch/index.js";
import { spawnEnvironment } from "../dispatch/types.js";
import { repositoryLabel } from "../repository-label.js";
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
  /** Null when the entry has no pinned environment; thread matching falls back to the project. */
  readonly environmentId: string | null;
}

export interface BbInteractionActionExecutorOptions {
  readonly threads: ThreadsApi;
  readonly store: OperationalStateStore;
  readonly interactionReader: PendingInteractionReader;
  readonly protocolReader: ProtocolReader;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
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

/** Queue items a question gates, resolved via blockedBy and blocked-by status. */
function questionGates(snapshot: ProtocolSnapshot, questionId: string): string[] {
  return snapshot.queue
    .filter(
      (entry) =>
        entry.blockedBy.includes(questionId) ||
        (entry.status.kind === "blocked-by" && entry.status.questionId === questionId),
    )
    .map((entry) => entry.id);
}

function recommendationPrompt(
  configuration: RepositoryConfiguration,
  question: Question,
  gates: readonly string[],
): string {
  const lines = [
    `The factory operator asked for a recommendation on question ${question.id} in repository "${configuration.repositoryKey}".`,
    "",
    `Question (${question.date}, ${question.classification}): ${question.question}`,
    "",
    "Context:",
    question.context,
  ];
  if (question.assumed) lines.push("", `Working assumption: ${question.assumed}`);
  if (gates.length > 0) lines.push("", `Answering this unblocks queue items: ${gates.join(", ")}.`);
  lines.push(
    "",
    `The repository checkout is at ${configuration.checkoutPath} on the "factory" branch. Read plans/factory/questions.md for the full question record and plans/factory/repo.md for repository protocol rules before answering.`,
    "",
    "Reply with (1) the recommended answer, (2) the reasoning, and (3) the main risk or tradeoff. Advisory only: do not edit files and do not record the answer in questions.md; the operator records it.",
  );
  return lines.join("\n");
}

function approvalPrompt(configuration: RepositoryConfiguration, entry: ProtocolSnapshot["queue"][number]): string {
  const list = (items: readonly string[]) => items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
  return [
    `The factory operator asked for a draft approval for queue entry ${entry.id} in repository "${configuration.repositoryKey}".`,
    "",
    `Queue entry: ${entry.id}`,
    `Title: ${entry.title}`,
    `Status: ${entry.status.kind === "blocked-by" ? `blocked by ${entry.status.questionId}` : entry.status.kind}`,
    `Risk: ${entry.risk}`,
    `Plan: ${entry.planPath}`,
    "",
    "Acceptance criteria:",
    list(entry.acceptance),
    "",
    "Validate commands:",
    list(entry.validate),
    "",
    `Notes: ${entry.notes ?? "none"}`,
    "",
    "The approved: line can permit these gated actions only: merges, deploys, migrations, adding or upgrading dependencies, touching secrets, deleting data, customer-facing changes.",
    "",
    `The operator must write an approved: line on the ${entry.id} queue entry and asked you to draft it. The repository checkout is at ${configuration.checkoutPath} on the "factory" branch. Read plans/factory/queue.md for the full queue record and plans/factory/repo.md for repository protocol rules before drafting.`,
    "",
    "Reply with (1) the recommended approved: line text, (2) the reasoning, and (3) what stays excluded. Advisory only: do not edit files; the operator records the approval.",
  ].join("\n");
}

export function createBbInteractionActionExecutor(options: BbInteractionActionExecutorOptions): BbInteractionActionExecutor {
  const { threads, store, interactionReader, protocolReader, repositoryLookup, dispatch, setDispatchMode } = options;

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
      if (scope.environmentId !== null && thread.environmentId !== scope.environmentId) continue;
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
    const entry = repositoryLookup(request.repositoryKey);
    if (!entry) {
      return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
    }
    const scope: InteractionScope = { projectId: entry.projectId, environmentId: entry.environmentId ?? null };
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

  /**
   * Spawns an advisory thread for a repository question. The question text is
   * re-read from the canonical protocol snapshot at execution time; a spawn
   * that fails ambiguously goes to reconciliation rather than a blind retry,
   * which could orphan a second thread.
   */
  async function recommendQuestion(request: BbInteractionActionRequest): Promise<FactoryActionResult> {
    const action = request.action as Extract<BbInteractionActionRequest["action"], { kind: "recommend-question" }>;
    const entry = repositoryLookup(request.repositoryKey);
    if (!entry) {
      return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
    }
    const target: PendingActionIntentTarget = { kind: "repository-question", questionId: action.questionId };
    return guarded(request, target, async (record) => {
      let snapshot: ProtocolSnapshot;
      try {
        snapshot = await protocolReader.loadSnapshot(entry.configuration);
      } catch (error) {
        return completeIntent(store, record, actionError(
          "internal",
          `Could not read the repository protocol: ${errorMessage(error)}`,
          request.idempotencyKey,
        ));
      }
      const question = snapshot.questions.find((candidate) => candidate.id === action.questionId);
      if (!question) {
        return completeIntent(store, record, actionError(
          "not-found",
          `Question '${action.questionId}' is not in plans/factory/questions.md.`,
          request.idempotencyKey,
        ));
      }

      let spawned: { id: string };
      try {
        spawned = await threads.spawn({
          projectId: entry.projectId,
          environment: spawnEnvironment(entry),
          prompt: recommendationPrompt(entry.configuration, question, questionGates(snapshot, question.id)),
          providerId: action.providerId,
          model: action.model,
          reasoningLevel: action.reasoningLevel,
          ...(action.serviceTier === undefined ? {} : { serviceTier: action.serviceTier }),
          permissionMode: "auto",
          title: `factory recommend: ${repositoryLabel(entry.configuration.repositoryKey, entry.displayName)} ${question.id}`,
          // Marks the picked values caller-explicit so the server does not
          // re-derive the project's stored execution defaults over them.
          executionInputSources: {
            providerId: "explicit",
            model: "explicit",
            reasoningLevel: "explicit",
            ...(action.serviceTier === undefined ? {} : { serviceTier: "explicit" as const }),
          },
        });
      } catch (error) {
        return reconcileIntent(store, record, `Recommendation thread spawn for ${question.id} failed ambiguously: ${errorMessage(error)}. The thread may exist.`);
      }

      return completeIntent(store, record, actionSuccess({
        status: "accepted",
        message: `Started a recommendation chat for ${question.id} on ${action.providerId} (${action.model}).`,
        revision: request.expectedRevision ?? null,
        runId: null,
        leaseId: null,
        queueItemId: null,
        action: "recommend-question",
        questionId: question.id,
        interactionId: null,
        threadId: spawned.id,
      }, request.expectedRevision ?? null));
    });
  }

  /** Spawns an advisory thread that drafts an approval for a queue item. */
  async function recommendApproval(request: BbInteractionActionRequest): Promise<FactoryActionResult> {
    const action = request.action as Extract<BbInteractionActionRequest["action"], { kind: "recommend-approval" }>;
    const entry = repositoryLookup(request.repositoryKey);
    if (!entry) {
      return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
    }
    const target: PendingActionIntentTarget = { kind: "queue-item", queueItemId: action.queueItemId };
    return guarded(request, target, async (record) => {
      let snapshot: ProtocolSnapshot;
      try {
        snapshot = await protocolReader.loadSnapshot(entry.configuration);
      } catch (error) {
        return completeIntent(store, record, actionError(
          "internal",
          `Could not read the repository protocol: ${errorMessage(error)}`,
          request.idempotencyKey,
        ));
      }
      const queueEntry = snapshot.queue.find((candidate) => candidate.id === action.queueItemId);
      if (!queueEntry) {
        return completeIntent(store, record, actionError(
          "not-found",
          `Queue item '${action.queueItemId}' is not in plans/factory/queue.md.`,
          request.idempotencyKey,
        ));
      }

      let spawned: { id: string };
      try {
        spawned = await threads.spawn({
          projectId: entry.projectId,
          environment: spawnEnvironment(entry),
          prompt: approvalPrompt(entry.configuration, queueEntry),
          providerId: action.providerId,
          model: action.model,
          reasoningLevel: action.reasoningLevel,
          ...(action.serviceTier === undefined ? {} : { serviceTier: action.serviceTier }),
          permissionMode: "auto",
          title: `factory recommend: ${repositoryLabel(entry.configuration.repositoryKey, entry.displayName)} ${queueEntry.id}`,
          executionInputSources: {
            providerId: "explicit",
            model: "explicit",
            reasoningLevel: "explicit",
            ...(action.serviceTier === undefined ? {} : { serviceTier: "explicit" as const }),
          },
        });
      } catch (error) {
        return reconcileIntent(store, record, `Approval-drafting thread spawn for ${queueEntry.id} failed ambiguously: ${errorMessage(error)}. The thread may exist.`);
      }

      return completeIntent(store, record, actionSuccess({
        status: "accepted",
        message: `Started an approval-drafting chat for ${queueEntry.id} on ${action.providerId} (${action.model}).`,
        revision: request.expectedRevision ?? null,
        runId: null,
        leaseId: null,
        queueItemId: queueEntry.id,
        action: "recommend-approval",
        interactionId: null,
        threadId: spawned.id,
      }, request.expectedRevision ?? null));
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

    if (action.kind === "recommend-question") {
      try {
        return await recommendQuestion(valid);
      } catch (error) {
        return actionError("internal", `Could not spawn the recommendation thread: ${errorMessage(error)}`, valid.idempotencyKey);
      }
    }

    if (action.kind === "recommend-approval") {
      try {
        return await recommendApproval(valid);
      } catch (error) {
        return actionError("internal", `Could not spawn the approval-drafting thread: ${errorMessage(error)}`, valid.idempotencyKey);
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
