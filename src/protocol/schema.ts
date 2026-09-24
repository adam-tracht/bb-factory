import {
  queueEntrySchema,
  questionSchema,
  type QueueEntry,
  type Question,
} from "../contracts.js";
import { ProtocolError } from "./errors.js";
import { PROTOCOL_PATHS } from "./paths.js";
import type { ParsedQueueEntry, ParsedQuestion } from "./markdown.js";

export interface QueueEligibility {
  readonly blockingQuestionIds: readonly string[];
  readonly staleBlockingQuestionIds: readonly string[];
  readonly blockedBy: readonly string[];
  readonly eligible: boolean;
  readonly eligibilityReasons: readonly QueueEntry["eligibilityReasons"][number][];
}

function schemaIssue(error: { readonly issues: readonly { readonly message: string }[] }): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

export function questionValue(question: ParsedQuestion): Question {
  const value = {
    id: question.id,
    date: question.date,
    classification: question.classification,
    dashboardId: question.dashboardId,
    question: question.question,
    context: question.context,
    assumed: question.assumed,
    ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
    answer: question.answer,
  };
  const parsed = questionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolError("malformed-protocol", `Question '${question.id}' failed the frozen schema`, {
      path: PROTOCOL_PATHS.questions,
      line: question.line,
      rule: "frozen-question-schema",
      hint: "make the question fields match the protocol schema",
      details: { issue: schemaIssue(parsed.error) },
    });
  }
  return parsed.data;
}

function questionIsOpen(question: ParsedQuestion): boolean {
  return question.classification === "blocking" && question.answer === null;
}

export function deriveQueueEligibility(
  entry: ParsedQueueEntry,
  questions: readonly ParsedQuestion[],
  dependencySatisfied?: readonly boolean[],
): QueueEligibility {
  const referencedQuestionIds = new Set<string>(entry.blockedBy);
  if (entry.status.kind === "blocked-by") {
    referencedQuestionIds.add(entry.status.questionId);
  }
  for (const question of questions) {
    if (question.dashboardId === entry.id && questionIsOpen(question)) {
      referencedQuestionIds.add(question.id);
    }
  }

  const eligibilityReasons: QueueEntry["eligibilityReasons"][number][] = [];
  if (entry.status.kind !== "ready") {
    eligibilityReasons.push("not-ready");
  }
  if (dependencySatisfied?.some((satisfied) => !satisfied)) {
    eligibilityReasons.push("unmet-dependency");
  }
  const openQuestions = questions.filter(
    (question) => referencedQuestionIds.has(question.id) && questionIsOpen(question),
  );
  const openQuestionIds = new Set(openQuestions.map((question) => question.id));
  if (openQuestions.length > 0) {
    eligibilityReasons.push("blocking-question");
  }
  const staleBlockingQuestionIds = [...referencedQuestionIds].filter((id) => !openQuestionIds.has(id));
  if (entry.status.kind === "blocked-by" && !openQuestionIds.has(entry.status.questionId)) {
    eligibilityReasons.push("stale-question-gate");
  }
  if (entry.approved.kind === "none" && entry.status.kind === "ready") {
    eligibilityReasons.push(entry.risk === "high" ? "high-risk-approval-missing" : "missing-authorization");
  }

  return {
    blockingQuestionIds: [...openQuestionIds],
    staleBlockingQuestionIds,
    blockedBy: [...referencedQuestionIds],
    eligible: eligibilityReasons.length === 0,
    eligibilityReasons,
  };
}

export function queueValue(entry: ParsedQueueEntry, eligibility: QueueEligibility): QueueEntry {
  const status = entry.status.kind === "ready"
    ? { kind: "ready" as const }
    : entry.status.kind === "in-progress"
      ? { kind: "in-progress" as const, detail: entry.status.detail }
      : entry.status.kind === "done"
        ? { kind: "done" as const, ...(entry.status.detail ? { detail: entry.status.detail } : {}) }
        : entry.status.kind === "draft"
          ? { kind: "draft" as const }
          : entry.status.kind === "unknown"
            ? { kind: "unknown" as const, raw: entry.status.raw }
            : {
                kind: "blocked-by" as const,
                questionId: entry.status.questionId,
                ...(entry.status.detail ? { detail: entry.status.detail } : {}),
              };
  const value = {
    id: entry.id,
    title: entry.title,
    status,
    priority: entry.priority,
    dependsOn: [...entry.dependsOn],
    risk: entry.risk,
    planPath: entry.planPath,
    approved: entry.approved.kind === "none"
      ? { kind: "none" as const, source: "none" as const }
      : { kind: "explicit" as const, source: "queue.approved" as const, text: entry.approved.text },
    acceptance: [...entry.acceptance],
    validate: [...entry.validate],
    notes: entry.notes,
    blockingQuestionIds: [...eligibility.blockingQuestionIds],
    staleBlockingQuestionIds: [...eligibility.staleBlockingQuestionIds],
    blockedBy: [...eligibility.blockedBy],
    eligible: eligibility.eligible,
    eligibilityReasons: [...eligibility.eligibilityReasons],
  };
  const parsed = queueEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolError("malformed-protocol", `Queue item '${entry.id}' failed the frozen schema`, {
      path: entry.path,
      line: entry.line,
      rule: "frozen-queue-schema",
      hint: "make the queue fields match the protocol schema",
      details: { issue: schemaIssue(parsed.error) },
    });
  }
  return parsed.data;
}
