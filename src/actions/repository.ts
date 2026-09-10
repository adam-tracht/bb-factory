import {
  repositoryActionRequestSchema,
  type FactoryActionResult,
  type ProtocolSnapshot,
  type RepositoryActionRequest,
  type RepositoryConfiguration,
  type RepositoryRevision,
} from "../contracts.js";
import type { ProtocolReader, RepositoryActionExecutor } from "../ports.js";
import { ProtocolError } from "../protocol/errors.js";
import { confinedPath, digestText, readTextFile, type ProtocolFiles } from "../protocol/files.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import {
  IdempotencyConflictError,
  PendingActionIntentExpiredError,
  type OperationalStateStore,
  type PendingActionFileChange,
  type PendingActionIntentRecord,
  type PendingActionIntentTarget,
} from "../storage/index.js";
import { ActionTargetMissingError, writeQuestionAnswer, writeQueueApproval } from "./markdown.js";
import { recordedIntentResult } from "./intents.js";
import { actionError, actionSuccess, errorMessage, sameRevision, staleRevisionError } from "./results.js";

export interface RepositoryFileWriter {
  write(args: {
    hostId?: string;
    path: string;
    rootPath?: string;
    content: string;
    expectedSha256?: string | null;
  }): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict"; currentSha256: string | null }>;
}

export interface RepositoryActionExecutorOptions {
  readonly files: ProtocolFiles & RepositoryFileWriter;
  readonly store: OperationalStateStore;
  readonly protocolReader: ProtocolReader;
  readonly repositoryLookup: (repositoryKey: string) => RepositoryConfiguration | null;
  readonly now?: () => Date;
}

const INITIAL_READY_TTL_MS = 10 * 60 * 1000;

function protocolFailure(error: unknown, idempotencyKey: RepositoryActionRequest["idempotencyKey"]): FactoryActionResult {
  const message = errorMessage(error);
  if (error instanceof ProtocolError) {
    const category =
      error.code === "file-not-found" ? "not-found"
      : error.code === "host-unavailable" ? "host-unavailable"
      : error.code === "invalid-configuration" ? "checkout-invalid"
      : "internal";
    return actionError(category, message, idempotencyKey);
  }
  if (error instanceof ActionTargetMissingError) {
    return actionError("not-found", message, idempotencyKey);
  }
  return actionError("internal", message, idempotencyKey);
}

interface PlannedRepositoryChange {
  readonly targetPath: string;
  readonly target: PendingActionIntentTarget;
  readonly alreadyApplied: boolean;
  readonly build: (content: string) => string;
}

function planRepositoryAction(snapshot: ProtocolSnapshot, request: RepositoryActionRequest): PlannedRepositoryChange | FactoryActionResult {
  const action = request.action;
  if (action.kind === "answer-question") {
    const question = snapshot.questions.find((candidate) => candidate.id === action.questionId);
    if (!question) {
      return actionError("not-found", `Repository question '${action.questionId}' is not in ${PROTOCOL_PATHS.questions}.`, request.idempotencyKey);
    }
    if (question.answer !== null) {
      return question.answer === action.answer
        ? { targetPath: PROTOCOL_PATHS.questions, target: { kind: "repository-question", questionId: question.id }, alreadyApplied: true, build: (content) => content }
        : actionError("conflict", `Repository question '${question.id}' already has a different answer.`, request.idempotencyKey);
    }
    return {
      targetPath: PROTOCOL_PATHS.questions,
      target: { kind: "repository-question", questionId: question.id },
      alreadyApplied: false,
      build: (content) => writeQuestionAnswer(content, question.id, action.answer),
    };
  }

  const entry = snapshot.queue.find((candidate) => candidate.id === action.queueItemId);
  if (!entry) {
    return actionError("not-found", `Queue item '${action.queueItemId}' is not in ${PROTOCOL_PATHS.queue}.`, request.idempotencyKey);
  }
  if (entry.status.kind === "ready") {
    const authorized = entry.approved.kind === "explicit" && entry.approved.text === action.approvedText;
    return authorized
      ? { targetPath: PROTOCOL_PATHS.queue, target: { kind: "queue-item", queueItemId: entry.id }, alreadyApplied: true, build: (content) => content }
      : actionError("conflict", `Queue item '${entry.id}' is already ready with different authorization.`, request.idempotencyKey);
  }
  if (entry.status.kind === "in-progress") {
    return actionError("conflict", `Queue item '${entry.id}' is already in progress: ${entry.status.detail}`, request.idempotencyKey);
  }
  if (entry.approved.kind === "explicit" && entry.approved.text !== action.approvedText) {
    return actionError(
      "conflict",
      `Queue item '${entry.id}' already records authorization '${entry.approved.text}', which does not match the request.`,
      request.idempotencyKey,
    );
  }
  return {
    targetPath: PROTOCOL_PATHS.queue,
    target: { kind: "queue-item", queueItemId: entry.id },
    alreadyApplied: false,
    build: (content) => writeQueueApproval(content, entry.id, action.approvedText),
  };
}

function consumedResult(record: PendingActionIntentRecord): FactoryActionResult {
  if (record.result) return record.result;
  if (record.status === "reconciliation-required") {
    return actionError(
      "conflict",
      `Action '${record.idempotencyKey}' needs reconciliation: ${record.lastError ?? "the external result is ambiguous"}.`,
      record.idempotencyKey,
    );
  }
  return actionError("conflict", `Action '${record.idempotencyKey}' is already being executed.`, record.idempotencyKey);
}

export function createRepositoryActionExecutor(options: RepositoryActionExecutorOptions): RepositoryActionExecutor {
  const now = options.now ?? (() => new Date());

  async function postVerify(
    configuration: RepositoryConfiguration,
    change: PendingActionFileChange,
  ): Promise<{ verified: boolean; currentSha256: string | null }> {
    const target = await readTextFile(options.files, {
      hostId: configuration.connectedHostId,
      rootPath: configuration.checkoutPath,
      relativePath: change.relativePath,
      repositoryKey: configuration.repositoryKey,
    });
    return { verified: target.sha256 === change.intendedSha256, currentSha256: target.sha256 };
  }

  async function reloadRevision(configuration: RepositoryConfiguration): Promise<RepositoryRevision | null> {
    try {
      return (await options.protocolReader.loadSnapshot(configuration)).revision;
    } catch {
      return null;
    }
  }

  async function execute(request: RepositoryActionRequest): Promise<FactoryActionResult> {
    const parsed = repositoryActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return actionError("invalid-input", `Invalid repository action request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const valid = parsed.data;
    const configuration = options.repositoryLookup(valid.repositoryKey);
    if (!configuration) {
      return actionError("not-found", `Repository '${valid.repositoryKey}' is not configured.`, valid.idempotencyKey);
    }

    // A finished intent replays its recorded result even when the repository
    // moved past the request's expected revision.
    const recorded = recordedIntentResult(options.store, valid);
    if (recorded) return recorded;

    let snapshot: ProtocolSnapshot;
    try {
      snapshot = await options.protocolReader.loadSnapshot(configuration);
    } catch (error) {
      return protocolFailure(error, valid.idempotencyKey);
    }
    if (!sameRevision(snapshot.revision, valid.expectedRevision)) {
      return staleRevisionError(
        `Repository '${valid.repositoryKey}' changed since the action was requested.`,
        valid.expectedRevision,
        snapshot.revision,
        valid.idempotencyKey,
      );
    }

    const plan = planRepositoryAction(snapshot, valid);
    if ("ok" in plan) return plan;

    let file: { content: string; sha256: string };
    try {
      file = await readTextFile(options.files, {
        hostId: configuration.connectedHostId,
        rootPath: configuration.checkoutPath,
        relativePath: plan.targetPath,
        repositoryKey: valid.repositoryKey,
      });
    } catch (error) {
      return protocolFailure(error, valid.idempotencyKey);
    }
    const expectedSha256 = valid.expectedRevision.fileDigests[plan.targetPath];
    if (file.sha256 !== expectedSha256) {
      return staleRevisionError(
        `File '${plan.targetPath}' changed since the action was requested.`,
        valid.expectedRevision,
        (await reloadRevision(configuration)) ?? snapshot.revision,
        valid.idempotencyKey,
      );
    }

    let intendedContent: string;
    try {
      intendedContent = plan.build(file.content);
    } catch (error) {
      return protocolFailure(error, valid.idempotencyKey);
    }
    const change: PendingActionFileChange = {
      relativePath: plan.targetPath,
      expectedSha256,
      intendedSha256: digestText(intendedContent),
      intendedContent,
    };

    let record: PendingActionIntentRecord;
    try {
      const claim = valid.action.kind === "approve-queue"
        ? options.store.claimInitialReadyIntent({
          request: valid,
          queueItemId: valid.action.queueItemId,
          intendedChange: change,
          expiresAt: new Date(now().getTime() + INITIAL_READY_TTL_MS).toISOString(),
        })
        : options.store.claimPendingActionIntent({ request: valid, target: plan.target, fileChange: change });
      record = claim.record;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return actionError("idempotency-conflict", errorMessage(error), valid.idempotencyKey);
      }
      if (error instanceof PendingActionIntentExpiredError) {
        return actionError("invalid-input", errorMessage(error), valid.idempotencyKey);
      }
      return actionError("internal", errorMessage(error), valid.idempotencyKey);
    }
    if (record.status === "completed" && record.result) return record.result;
    if (record.status === "reconciliation-required") return consumedResult(record);

    let consumption;
    try {
      consumption = options.store.consumePendingActionIntent(valid.idempotencyKey);
    } catch (error) {
      if (error instanceof PendingActionIntentExpiredError) {
        return actionError("invalid-input", errorMessage(error), valid.idempotencyKey);
      }
      return actionError("internal", errorMessage(error), valid.idempotencyKey);
    }
    if (!consumption.consumed) return consumedResult(consumption.record);

    const applyResult = async (result: FactoryActionResult, observedStatus?: "written" | "conflict" | "verified") => {
      options.store.updatePendingActionIntent({
        idempotencyKey: valid.idempotencyKey,
        status: "completed",
        result,
        ...(observedStatus === undefined ? {} : { observedStatus }),
      });
      return result;
    };
    const reconcile = (message: string, observedStatus?: "written" | "conflict" | "verified") => {
      options.store.updatePendingActionIntent({
        idempotencyKey: valid.idempotencyKey,
        status: "reconciliation-required",
        lastError: message,
        ...(observedStatus === undefined ? {} : { observedStatus }),
      });
      return actionError("conflict", `${message} The action was marked for reconciliation and was not retried.`, valid.idempotencyKey);
    };

    const alreadyApplied = change.intendedSha256 === change.expectedSha256;
    if (alreadyApplied) {
      const revision = await reloadRevision(configuration);
      return applyResult(actionSuccess(outcomeFor(valid, plan, "already-applied", revision), revision), "verified");
    }

    let writeOutcome: Awaited<ReturnType<RepositoryFileWriter["write"]>>;
    try {
      writeOutcome = await options.files.write({
        hostId: configuration.connectedHostId,
        path: confinedPath(configuration.checkoutPath, change.relativePath),
        rootPath: configuration.checkoutPath,
        content: change.intendedContent,
        expectedSha256: change.expectedSha256,
      });
    } catch (error) {
      try {
        const observed = await postVerify(configuration, change);
        if (observed.verified) {
          const revision = await reloadRevision(configuration);
          return applyResult(actionSuccess(outcomeFor(valid, plan, "accepted", revision), revision), "verified");
        }
        if (observed.currentSha256 === change.expectedSha256) {
          return applyResult(
            actionError("internal", `Repository write failed before it was applied: ${errorMessage(error)}`, valid.idempotencyKey),
            "conflict",
          );
        }
        return reconcile(`Repository write failed ambiguously and the target now has an unexpected digest: ${errorMessage(error)}`, "written");
      } catch (verifyError) {
        return reconcile(`Repository write failed and the target could not be re-read: ${errorMessage(verifyError)}`);
      }
    }

    if (writeOutcome.outcome === "conflict") {
      return applyResult(
        actionError(
          "conflict",
          `File '${change.relativePath}' changed after the preflight read; the intended write was not applied.`,
          valid.idempotencyKey,
        ),
        "conflict",
      );
    }
    if (writeOutcome.sha256 !== change.intendedSha256) {
      return reconcile(`Repository write reported an unexpected resulting digest for '${change.relativePath}'.`, "written");
    }

    try {
      const observed = await postVerify(configuration, change);
      if (!observed.verified) {
        return reconcile(`Repository write post-verification failed for '${change.relativePath}'.`, "written");
      }
    } catch (verifyError) {
      return reconcile(`Repository write post-verification could not read '${change.relativePath}': ${errorMessage(verifyError)}`, "written");
    }

    const revision = await reloadRevision(configuration);
    return applyResult(actionSuccess(outcomeFor(valid, plan, "accepted", revision), revision), "verified");
  }

  return { execute };
}

function outcomeFor(
  request: RepositoryActionRequest,
  plan: PlannedRepositoryChange,
  status: "accepted" | "already-applied",
  revision: RepositoryRevision | null,
) {
  const message = plan.alreadyApplied || status === "already-applied"
    ? "The requested repository state was already recorded; no write was needed."
    : "The repository protocol file was updated and verified.";
  if (request.action.kind === "answer-question") {
    return {
      status,
      message,
      revision,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "answer-question" as const,
      source: "repository-question" as const,
      questionId: request.action.questionId,
      interactionId: null,
    };
  }
  return {
    status,
    message,
    revision,
    runId: null,
    leaseId: null,
    queueItemId: request.action.queueItemId,
    action: "approve-queue" as const,
    questionId: null,
    interactionId: null,
  };
}
