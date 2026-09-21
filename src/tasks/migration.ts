import { z } from "zod";
import {
  questionSchema,
  queueEntrySchema,
  type Question,
  type QueueEntry,
  type RepositoryKey,
} from "../contracts.js";
import type {
  TasksApprovalRecord,
  TasksBlockerRecord,
  TasksDependencyEdge,
} from "../storage/index.js";
import { deriveTasksContentRevision, type TasksClient, type TasksLabel, type TasksProject, type TasksTask } from "./index.js";

const taskMetadataSchema = z.object({
  dashboardId: z.string().trim().min(1).nullable(),
  priority: z.number().int().min(1).max(5),
  dependsOn: z.array(z.string().trim().min(1)),
  risk: z.enum(["low", "medium", "high"]),
  planPath: z.string().trim().min(1),
  acceptance: z.array(z.string().trim().min(1)),
  validate: z.array(z.string().trim().min(1)),
  notes: z.string().nullable(),
  approvedScopes: z.array(z.string().trim().min(1)),
  approvedText: z.string().trim().min(1).nullable(),
  questionId: z.string().trim().min(1).nullable(),
  questionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  questionText: z.string().trim().min(1).nullable(),
}).strict();

export type FactoryTaskMetadata = z.infer<typeof taskMetadataSchema>;

export interface TasksLedgerReader {
  listTasksApprovals(repositoryKey: RepositoryKey, taskId?: string): TasksApprovalRecord[];
  listTasksDependencyEdges(repositoryKey: RepositoryKey): TasksDependencyEdge[];
  listTasksBlockers(repositoryKey: RepositoryKey, taskId?: string): TasksBlockerRecord[];
}

export interface TasksProjection {
  readonly queue: readonly QueueEntry[];
  readonly questions: readonly Question[];
}

const QUEUE_MARKER = "factory-queue-entry";
const QUESTION_MARKER = "factory-question";

function markerValue(description: string | null | undefined, marker: string): unknown {
  const match = description?.match(new RegExp(`<!-- ${marker} (\\{[^\\n]+\\}) -->`, "u"));
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as unknown;
  } catch {
    return null;
  }
}

function defaultMetadata(task: Pick<TasksTask, "title" | "priority">): FactoryTaskMetadata {
  return {
    dashboardId: null,
    priority: task.priority === "urgent" ? 1 : task.priority === "high" ? 2 : task.priority === "medium" ? 3 : task.priority === "low" ? 4 : 5,
    dependsOn: [],
    risk: "low",
    planPath: "plans/factory/queue.md",
    acceptance: [],
    validate: [],
    notes: null,
    approvedScopes: [],
    approvedText: null,
    questionId: null,
    questionDate: null,
    questionText: null,
  };
}

export function parseFactoryTaskMetadata(task: Pick<TasksTask, "title" | "priority" | "description">): FactoryTaskMetadata {
  const parsed = taskMetadataSchema.safeParse(markerValue(task.description, QUEUE_MARKER));
  return parsed.success ? parsed.data : defaultMetadata(task);
}

export function parseFactoryQuestionMetadata(task: Pick<TasksTask, "description">): Pick<FactoryTaskMetadata, "questionId" | "questionDate" | "questionText"> | null {
  const marker = markerValue(task.description, QUESTION_MARKER);
  if (!marker || typeof marker !== "object") return null;
  const parsed = z.object({
    questionId: z.string().trim().min(1),
    questionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    questionText: z.string().trim().min(1),
  }).safeParse(marker);
  return parsed.success ? parsed.data : null;
}

export function renderFactoryTaskDescription(metadata: FactoryTaskMetadata, body?: string): string {
  const marker = `<!-- ${QUEUE_MARKER} ${JSON.stringify(metadata)} -->`;
  const lines = [
    marker,
    `Factory queue entry: ${metadata.dashboardId ?? "native-task"}`,
    `Priority: ${metadata.priority}`,
    `Depends on: ${metadata.dependsOn.length === 0 ? "none" : metadata.dependsOn.join(", ")}`,
    `Risk: ${metadata.risk}`,
    `Plan: ${metadata.planPath}`,
    `Approved scopes: ${metadata.approvedScopes.length === 0 ? "none" : metadata.approvedScopes.join(", ")}`,
    `Approved text: ${metadata.approvedText ?? "none"}`,
    "",
    "## Acceptance",
    ...(metadata.acceptance.length === 0 ? ["- none"] : metadata.acceptance.map((item) => `- ${item}`)),
    "",
    "## Validation",
    ...(metadata.validate.length === 0 ? ["- none"] : metadata.validate.map((item) => `- ${item}`)),
    "",
    `Notes: ${metadata.notes ?? "none"}`,
  ];
  if (body?.trim()) lines.push("", body.trim());
  return lines.join("\n");
}

export function renderFactoryQuestionDescription(input: {
  readonly questionId: string;
  readonly date: string;
  readonly question: string;
  readonly context: string;
}): string {
  const marker = `<!-- ${QUESTION_MARKER} ${JSON.stringify({
    questionId: input.questionId,
    questionDate: input.date,
    questionText: input.question,
  })} -->`;
  return [marker, `Question ${input.questionId}`, "", input.question, "", input.context].join("\n");
}

export function factoryQuestionBlockerId(repositoryKey: RepositoryKey, questionId: string): string {
  return `factory:${repositoryKey}:question:${questionId}`;
}

function taskPriority(task: TasksTask, metadata: FactoryTaskMetadata): number {
  return metadata.dashboardId === null
    ? task.priority === "urgent" ? 1 : task.priority === "high" ? 2 : task.priority === "medium" ? 3 : task.priority === "low" ? 4 : 5
    : metadata.priority;
}

function taskStatus(task: TasksTask, openBlockers: readonly TasksBlockerRecord[], labelNames: ReadonlySet<string>, threadDetail?: string): QueueEntry["status"] {
  if (task.status === "backlog") return { kind: "draft" };
  if (task.status === "todo") {
    const blocker = openBlockers[0];
    if (blocker) return { kind: "blocked-by", questionId: blocker.blockerId };
    return { kind: "ready" };
  }
  if (task.status === "in_progress") return { kind: "in-progress", detail: threadDetail ?? (labelNames.has("thread") ? "attached Tasks thread" : "Tasks card in progress") };
  if (task.status === "done") return { kind: "done" };
  return { kind: "unknown", raw: task.status };
}

function dateFromProvenance(blocker: TasksBlockerRecord, fallback: Date): string {
  const provenance = blocker.provenance;
  if (provenance && typeof provenance === "object" && !Array.isArray(provenance) && typeof provenance.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(provenance.date)) {
    return provenance.date;
  }
  return fallback.toISOString().slice(0, 10);
}

function approvalFor(
  task: TasksTask,
  metadata: FactoryTaskMetadata,
  approvals: readonly TasksApprovalRecord[],
): { readonly approved: QueueEntry["approved"]; readonly missing: boolean } {
  const revision = deriveTasksContentRevision(task);
  const current = new Set(
    approvals.filter((approval) => approval.contentRevision === revision).map((approval) => approval.operationClass),
  );
  const requiredScopes = metadata.approvedScopes.length === 0 ? ["execute"] : metadata.approvedScopes;
  const missing = requiredScopes.some((scope) => !current.has(scope));
  return missing
    ? { approved: { kind: "none", source: "none" }, missing: true }
    : {
        approved: {
          kind: "explicit",
          source: "queue.approved",
          text: metadata.approvedText ?? `Factory ledger approval: ${requiredScopes.join(", ")}`,
        },
        missing: false,
      };
}

export async function projectTasks(
  client: TasksClient,
  ledger: TasksLedgerReader,
  input: {
    readonly repositoryKey: RepositoryKey;
    readonly project: TasksProject;
    readonly now?: () => Date;
  },
): Promise<TasksProjection> {
  const [tasks, labels] = await Promise.all([
    client.listAllTasks({ projectId: input.project.id }),
    typeof client.listLabels === "function" ? client.listLabels(input.project.id) : Promise.resolve([] as TasksLabel[]),
  ]);
  const queueTasks = tasks.filter((task) => {
    if (task.description?.includes("Factory run id:")) return false;
    return markerValue(task.description, QUESTION_MARKER) === null || markerValue(task.description, QUEUE_MARKER) !== null;
  });
  const labelNamesByTask = new Map<string, Set<string>>();
  const labelsById = new Map(labels.map((label) => [label.id, label.name.toLowerCase()]));
  for (const task of tasks) {
    labelNamesByTask.set(task.id, new Set((task.labelIds ?? []).map((id) => labelsById.get(id)).filter((name): name is string => name !== undefined)));
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const blockers = ledger.listTasksBlockers(input.repositoryKey);
  const blockersByTask = new Map<string, TasksBlockerRecord[]>();
  for (const blocker of blockers) {
    const current = blockersByTask.get(blocker.taskId) ?? [];
    current.push(blocker);
    blockersByTask.set(blocker.taskId, current);
  }
  const dependenciesByTask = new Map<string, TasksDependencyEdge[]>();
  for (const edge of ledger.listTasksDependencyEdges(input.repositoryKey)) {
    const current = dependenciesByTask.get(edge.taskId) ?? [];
    current.push(edge);
    dependenciesByTask.set(edge.taskId, current);
  }
  const taskKeyById = new Map(tasks.map((task) => [task.id, task.key]));
  const threadDetailByTaskId = new Map<string, string>();
  await Promise.all(tasks.filter((task) => task.status === "in_progress").map(async (task) => {
    try {
      const threads = await client.listTaskThreads(task.id);
      const thread = threads[0];
      if (thread) threadDetailByTaskId.set(task.id, `Tasks thread ${thread.threadId} (${thread.liveStatus})`);
    } catch {
      // A missing optional thread projection never changes queue eligibility.
    }
  }));
  const now = input.now ?? (() => new Date());
  const questions = blockers.map((blocker) => {
    const task = taskById.get(blocker.taskId);
    const metadata = task ? parseFactoryTaskMetadata(task) : null;
    const value = {
      id: blocker.blockerId,
      date: metadata?.questionDate ?? dateFromProvenance(blocker, now()),
      classification: "blocking" as const,
      dashboardId: task?.key ?? blocker.taskId,
      question: blocker.questionText,
      context: metadata?.questionText === blocker.questionText ? "Native Tasks blocker" : "Factory Tasks blocker",
      assumed: null,
      recommended: null,
      answer: blocker.state === "open" ? null : blocker.answerText,
    };
    return questionSchema.parse(value);
  });

  const queue = queueTasks.map((task) => {
    const metadata = parseFactoryTaskMetadata(task);
    const taskBlockers = (blockersByTask.get(task.id) ?? []).filter((blocker) => blocker.state === "open");
    const dependencies = (dependenciesByTask.get(task.id) ?? []).map((edge) => taskKeyById.get(edge.dependsOnTaskId) ?? edge.dependsOnTaskId);
    const dependencyEdges = dependenciesByTask.get(task.id) ?? [];
    const dependenciesSatisfied = dependencyEdges.every((edge) => taskById.get(edge.dependsOnTaskId)?.status === "done");
    const authorization = approvalFor(task, metadata, ledger.listTasksApprovals(input.repositoryKey, task.id));
    const status = taskStatus(task, taskBlockers, labelNamesByTask.get(task.id) ?? new Set(), threadDetailByTaskId.get(task.id));
    const reasons: QueueEntry["eligibilityReasons"] = [];
    if (status.kind !== "ready") reasons.push("not-ready");
    if (!dependenciesSatisfied) reasons.push("unmet-dependency");
    if (taskBlockers.length > 0) reasons.push("blocking-question");
    if (task.status === "todo" && authorization.missing) reasons.push(metadata.risk === "high" ? "high-risk-approval-missing" : "missing-authorization");
    const value = {
      id: task.key,
      title: task.title,
      status,
      priority: taskPriority(task, metadata),
      dependsOn: dependencies,
      risk: metadata.risk,
      planPath: metadata.planPath,
      approved: authorization.approved,
      acceptance: metadata.acceptance,
      validate: metadata.validate,
      notes: metadata.notes,
      blockingQuestionIds: taskBlockers.map((blocker) => blocker.blockerId),
      staleBlockingQuestionIds: [],
      blockedBy: taskBlockers.map((blocker) => blocker.blockerId),
      eligible: task.status === "todo" && reasons.length === 0,
      eligibilityReasons: reasons,
    };
    return queueEntrySchema.parse(value);
  });

  return { queue, questions };
}

export function dashboardIdFromDescription(description: string | null | undefined): string | null {
  const metadata = taskMetadataSchema.safeParse(markerValue(description, QUEUE_MARKER));
  return metadata.success ? metadata.data.dashboardId : null;
}

export function metadataForQueueEntry(entry: {
  readonly id: string;
  readonly priority: number;
  readonly dependsOn: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly planPath: string;
  readonly acceptance: readonly string[];
  readonly validate: readonly string[];
  readonly notes: string | null;
  readonly approved: { readonly kind: "explicit"; readonly text: string } | { readonly kind: "none" };
}): FactoryTaskMetadata {
  return {
    dashboardId: entry.id,
    priority: entry.priority,
    dependsOn: [...entry.dependsOn],
    risk: entry.risk,
    planPath: entry.planPath,
    acceptance: [...entry.acceptance],
    validate: [...entry.validate],
    notes: entry.notes,
    approvedScopes: entry.approved.kind === "explicit" ? ["execute"] : [],
    approvedText: entry.approved.kind === "explicit" ? entry.approved.text : null,
    questionId: null,
    questionDate: null,
    questionText: null,
  };
}

export function queueStatusToTaskStatus(status: string): "backlog" | "todo" | "in_progress" | "done" {
  if (status === "ready") return "todo";
  if (status === "in-progress") return "in_progress";
  if (status === "done") return "done";
  if (status === "blocked-by") return "todo";
  return "backlog";
}

export function priorityToTaskPriority(priority: number): "urgent" | "high" | "medium" | "low" | "none" {
  return priority <= 1 ? "urgent" : priority === 2 ? "high" : priority === 3 ? "medium" : priority === 4 ? "low" : "none";
}
