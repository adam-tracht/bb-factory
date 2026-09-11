import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  approvalDecisionSchema,
  pendingInteractionsProjectionSchema,
  repositoryKeySchema,
  type ApprovalDecision,
  type PendingInteraction,
  type PendingInteractionsProjection,
  type PendingInteractionQuestion,
  type PendingInteractionQuestionOption,
  type RepositoryKey,
} from "../contracts.js";

type BbSdk = BbPluginApi["sdk"];
type SdkThreads = BbSdk["threads"];
type SdkPendingInteraction = Awaited<ReturnType<SdkThreads["interactions"]["list"]>>[number];
type ApprovalInteractionMetadata = Extract<PendingInteraction, { kind: "approval" }>["metadata"];
type UserQuestionInteractionMetadata = Extract<PendingInteraction, { kind: "user-question" }>["metadata"];
type PluginInteractionMetadata = Extract<PendingInteraction, { kind: "plugin" }>["metadata"];
const THREAD_PAGE_SIZE = 100;

/** The frozen P1 port for the BB-backed pending-interaction projection. */
export interface PendingInteractionReader {
  listPendingInteractions(repositoryKey: RepositoryKey): Promise<PendingInteractionsProjection>;
}

/** The BB scope needed to keep a read inside one configured repository. */
export interface PendingInteractionRepositoryScope {
  readonly repositoryKey: RepositoryKey;
  readonly projectId: string;
  /** Null when the entry has no pinned environment; scoping falls back to the project. */
  readonly environmentId: string | null;
}

export type PendingInteractionRepositoryConfigLookup = (
  repositoryKey: RepositoryKey,
) => PendingInteractionRepositoryScope | null | undefined | Promise<PendingInteractionRepositoryScope | null | undefined>;

/** Only the public SDK reads used by this adapter are injectable. */
export type PendingInteractionSdk = {
  readonly threads: Pick<SdkThreads, "list"> & {
    readonly interactions: Pick<SdkThreads["interactions"], "list">;
  };
};

export interface PendingInteractionReaderOptions {
  readonly sdk: PendingInteractionSdk;
  readonly repositoryConfigLookup: PendingInteractionRepositoryConfigLookup;
}

export type PendingInteractionReaderErrorCode =
  | "invalid-input"
  | "repository-not-found"
  | "invalid-sdk-response"
  | "sdk-failure";

export class PendingInteractionReaderError extends Error {
  readonly code: PendingInteractionReaderErrorCode;

  constructor(code: PendingInteractionReaderErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PendingInteractionReaderError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an invalid pending interaction ${field}.`);
  }
  return value.trim();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:entication)?|password|secret|token)\s*[:=]\s*(['"]?)[^\s,'";]+\2/giu,
      "$1: [redacted]",
    )
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]-)[a-z0-9_-]{8,}\b/giu, "[redacted]");
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an invalid pending interaction ${field}.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an invalid pending interaction ${field}.`);
  }
  return timestamp.toISOString();
}

function normalizeExpiration(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, "expiration");
}

function requiredSdkString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an invalid pending interaction ${field}.`);
  }
  return value;
}

function optionalSdkString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredSdkString(value, field);
}

function nullableSdkString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredSdkString(value, field);
}

function requiredSdkBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an invalid pending interaction ${field}.`);
  }
  return value;
}

function normalizeQuestionOption(value: unknown): PendingInteractionQuestionOption {
  if (!isRecord(value)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned invalid pending question choices.");
  }
  const option: PendingInteractionQuestionOption = {
    label: requiredSdkString(value.label, "choice label"),
    value: requiredSdkString(value.value, "choice value"),
  };
  if (value.description !== undefined) {
    option.description = requiredSdkString(value.description, "choice description");
  }
  return option;
}

function normalizeQuestion(value: unknown): PendingInteractionQuestion {
  if (!isRecord(value)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid pending user question.");
  }
  const question: PendingInteractionQuestion = {
    allowFreeText: requiredSdkBoolean(value.allowFreeText, "free-text setting"),
    id: requiredSdkString(value.id, "question id"),
    multiSelect: requiredSdkBoolean(value.multiSelect, "multi-select setting"),
    prompt: requiredSdkString(value.prompt, "question prompt"),
  };
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) {
      throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned invalid pending question choices.");
    }
    question.options = value.options.map(normalizeQuestionOption);
  }
  if (value.shortLabel !== undefined) {
    question.shortLabel = requiredSdkString(value.shortLabel, "question short label");
  }
  return question;
}

function normalizeApprovalMetadata(payload: Record<string, unknown>): ApprovalInteractionMetadata {
  if (!Array.isArray(payload.availableDecisions)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned invalid approval decisions.");
  }
  const availableDecisions: ApprovalDecision[] = payload.availableDecisions.map((decision) => {
    const parsed = approvalDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid approval decision.");
    }
    return parsed.data;
  });
  return { availableDecisions, kind: "approval" };
}

function normalizeApprovalPrompt(payload: Record<string, unknown>, metadata: ApprovalInteractionMetadata): string | null {
  const lines: string[] = [];
  const subject = isRecord(payload.subject) ? payload.subject : null;
  const subjectKind = requiredSdkString(subject?.kind, "approval subject kind");
  lines.push(`Approval requested for ${subjectKind}.`);

  const reason = nullableSdkString(payload.reason, "approval reason");
  if (reason) lines.push(reason);

  if (metadata.availableDecisions.length > 0) {
    lines.push(`Choices: ${metadata.availableDecisions.join(", ")}.`);
  }

  return lines.length > 0 ? redactSensitiveText(lines.join("\n")) : null;
}

function normalizeUserQuestionMetadata(payload: Record<string, unknown>): UserQuestionInteractionMetadata {
  if (!Array.isArray(payload.questions)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid pending user question.");
  }
  return { kind: "user_question", questions: payload.questions.map(normalizeQuestion) };
}

function normalizeUserQuestionPrompt(metadata: UserQuestionInteractionMetadata): string | null {
  const sections = metadata.questions.map((question, index) => {
    const lines = [metadata.questions.length > 1 ? `Question ${index + 1}: ${question.prompt}` : question.prompt];
    if (question.options !== undefined) {
      const choices = question.options.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`);
      if (choices.length > 0) lines.push("Choices:", ...choices);
    }
    return lines.join("\n");
  });

  const prompt = sections.join("\n\n").trim();
  return prompt ? redactSensitiveText(prompt) : null;
}

function normalizePluginMetadata(): PluginInteractionMetadata {
  return { kind: "plugin" };
}

function isNamespacedInteractionKind(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/u.test(value);
}

function normalizeInteraction(raw: SdkPendingInteraction, expectedThreadId: string): PendingInteraction | null {
  if (!isRecord(raw)) {
    throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid pending interaction.");
  }
  if (raw.status !== "pending") return null;

  const interactionId = requiredText(raw.id, "id");
  const threadId = requiredText(raw.threadId, "thread id");
  if (threadId !== expectedThreadId) {
    throw new PendingInteractionReaderError(
      "invalid-sdk-response",
      `BB returned interaction '${interactionId}' linked to a different thread.`,
    );
  }
  const turnId = raw.turnId === null ? null : requiredText(raw.turnId, "turn id");
  const payload = isRecord(raw.payload) ? raw.payload : null;
  if (!payload) {
    throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned invalid payload for interaction '${interactionId}'.`);
  }

  const createdAt = normalizeTimestamp(raw.createdAt, "creation time");
  const expiresAt = normalizeExpiration(raw.expiresAt);
  switch (payload.kind) {
    case "approval": {
      const metadata = normalizeApprovalMetadata(payload);
      return {
        source: "bb-interaction",
        interactionId,
        threadId,
        turnId,
        status: "pending",
        kind: "approval",
        title: "BB approval required",
        prompt: normalizeApprovalPrompt(payload, metadata),
        metadata,
        createdAt,
        expiresAt,
      };
    }
    case "user_question": {
      const metadata = normalizeUserQuestionMetadata(payload);
      const firstShortLabel = optionalSdkString(metadata.questions[0]?.shortLabel, "question short label");
      return {
        source: "bb-interaction",
        interactionId,
        threadId,
        turnId,
        status: "pending",
        kind: "user-question",
        title: redactSensitiveText(firstShortLabel?.trim() || "BB user question"),
        prompt: normalizeUserQuestionPrompt(metadata),
        metadata,
        createdAt,
        expiresAt,
      };
    }
    case "plugin": {
      const title = requiredText(payload.title, "plugin title");
      return {
        source: "bb-interaction",
        interactionId,
        threadId,
        turnId,
        status: "pending",
        kind: "plugin",
        title: redactSensitiveText(title),
        prompt: null,
        metadata: normalizePluginMetadata(),
        createdAt,
        expiresAt,
      };
    }
    default: {
      if (!isNamespacedInteractionKind(payload.kind)) {
        throw new PendingInteractionReaderError("invalid-sdk-response", `BB returned an unsupported pending interaction '${interactionId}'.`);
      }
      const title = requiredText(payload.title, "plugin title");
      return {
        source: "bb-interaction",
        interactionId,
        threadId,
        turnId,
        status: "pending",
        kind: "plugin",
        title: redactSensitiveText(title),
        prompt: null,
        metadata: normalizePluginMetadata(),
        createdAt,
        expiresAt,
      };
    }
  }
}

function validateScope(repositoryKey: RepositoryKey, scope: PendingInteractionRepositoryScope | null | undefined): PendingInteractionRepositoryScope {
  if (!scope) {
    throw new PendingInteractionReaderError(
      "repository-not-found",
      `No configured BB project and environment were found for repository '${repositoryKey}'.`,
    );
  }
  if (!repositoryKeySchema.safeParse(scope.repositoryKey).success || scope.repositoryKey !== repositoryKey) {
    throw new PendingInteractionReaderError("invalid-input", "Repository configuration lookup returned a mismatched repository key.");
  }
  if (typeof scope.projectId !== "string" || scope.projectId.trim().length === 0) {
    throw new PendingInteractionReaderError("invalid-input", `Repository '${repositoryKey}' has no configured BB project.`);
  }
  return {
    repositoryKey,
    projectId: scope.projectId.trim(),
    environmentId: typeof scope.environmentId === "string" && scope.environmentId.trim().length > 0
      ? scope.environmentId.trim()
      : null,
  };
}

export function createPendingInteractionReader(options: PendingInteractionReaderOptions): PendingInteractionReader {
  return {
    async listPendingInteractions(repositoryKey: RepositoryKey): Promise<PendingInteractionsProjection> {
      const parsedRepositoryKey = repositoryKeySchema.safeParse(repositoryKey);
      if (!parsedRepositoryKey.success) {
        throw new PendingInteractionReaderError("invalid-input", "Repository key is invalid.");
      }

      let scope: PendingInteractionRepositoryScope | null | undefined;
      try {
        scope = await options.repositoryConfigLookup(parsedRepositoryKey.data);
      } catch (error) {
        throw new PendingInteractionReaderError("sdk-failure", `Could not load configuration for repository '${parsedRepositoryKey.data}'.`, error);
      }
      const configuredScope = validateScope(parsedRepositoryKey.data, scope);

      const threads: Awaited<ReturnType<SdkThreads["list"]>> = [];
      let offset = 0;
      while (true) {
        let page: Awaited<ReturnType<SdkThreads["list"]>>;
        try {
          page = await options.sdk.threads.list({
            archived: false,
            includeHidden: true,
            limit: THREAD_PAGE_SIZE,
            offset,
            projectId: configuredScope.projectId,
          });
        } catch (error) {
          throw new PendingInteractionReaderError(
            "sdk-failure",
            `Could not read BB threads for repository '${configuredScope.repositoryKey}'.`,
            error,
          );
        }
        if (!Array.isArray(page)) {
          throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid thread list.");
        }
        threads.push(...page);
        if (page.length < THREAD_PAGE_SIZE) break;
        offset += page.length;
      }

      const interactions: PendingInteraction[] = [];
      for (const thread of threads) {
        if (!isRecord(thread)) {
          throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid thread entry.");
        }
        if (
          thread.projectId !== configuredScope.projectId ||
          (configuredScope.environmentId !== null && thread.environmentId !== configuredScope.environmentId) ||
          thread.hasPendingInteraction !== true
        ) {
          continue;
        }
        const threadId = requiredText(thread.id, "thread id");
        let pending: Awaited<ReturnType<SdkThreads["interactions"]["list"]>>;
        try {
          pending = await options.sdk.threads.interactions.list({ threadId });
        } catch (error) {
          throw new PendingInteractionReaderError(
            "sdk-failure",
            `Could not read BB interactions for repository '${configuredScope.repositoryKey}'.`,
            error,
          );
        }
        if (!Array.isArray(pending)) {
          throw new PendingInteractionReaderError("invalid-sdk-response", "BB returned an invalid interaction list.");
        }
        for (const raw of pending) {
          const normalized = normalizeInteraction(raw, threadId);
          if (normalized) interactions.push(normalized);
        }
      }

      try {
        return pendingInteractionsProjectionSchema.parse({
          repositoryKey: configuredScope.repositoryKey,
          interactions,
        });
      } catch (error) {
        throw new PendingInteractionReaderError("invalid-sdk-response", "The BB pending-interaction projection failed validation.", error);
      }
    },
  };
}
