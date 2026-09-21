import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { ProtocolFiles } from "../protocol/files.js";
import { parseQueue, parseQuestions } from "../protocol/markdown.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import { readTextFile } from "../protocol/files.js";
import { ProtocolError } from "../protocol/errors.js";
import {
  tasksActionRequestSchema,
  type FactoryActionResult,
  type TasksActionRequest,
  type RepositoryConfiguration,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import {
  deriveTasksContentRevision,
  TasksClient,
  TasksIntegrationError,
  type TasksProject,
  type TasksTask,
} from "../tasks/index.js";
import {
  dashboardIdFromDescription,
  factoryQuestionBlockerId,
  metadataForQueueEntry,
  priorityToTaskPriority,
  queueStatusToTaskStatus,
  renderFactoryQuestionDescription,
  renderFactoryTaskDescription,
} from "../tasks/migration.js";
import type {
  OperationalStateStore,
  TasksOperationClass,
} from "../storage/index.js";
import { actionError, actionSuccess } from "./results.js";

export interface TasksActionExecutorOptions {
  readonly tasksClient: TasksClient;
  readonly store: Pick<OperationalStateStore, "createTasksApproval" | "getTasksApproval" | "claimQuestionAnswer" | "completeQuestionAnswer" | "getQuestionAnswer" | "getTasksBlocker" | "updateTasksBlocker" | "listTasksBlockers" | "listTasksDependencyEdges" | "listTasksApprovals" | "createTasksDependencyEdge" | "createTasksBlocker">;
  readonly repositoryLookup: (repositoryKey: string) => RepositoryConfiguration | null;
  readonly files?: ProtocolFiles;
  readonly projectIdLookup?: (repositoryKey: string) => string | null;
  readonly tasksProjectLookup?: (repositoryKey: string) => Promise<TasksProject | null>;
  readonly now?: () => Date;
}

export interface CurrentTasksApprovalInput {
  readonly repositoryKey: string;
  readonly taskId: string;
  readonly operationClass: TasksOperationClass;
}

/**
 * Re-read the task and compare its current content revision to the ledger
 * grant. Status changes and comments are not part of that revision.
 */
export async function hasCurrentTasksApproval(
  tasksClient: TasksClient,
  store: Pick<OperationalStateStore, "getTasksApproval">,
  input: CurrentTasksApprovalInput,
): Promise<boolean> {
  if (!tasksClient.enabled) return false;
  const task = await tasksClient.getTask(input.taskId);
  if (task === null) return false;
  const contentRevision = deriveTasksContentRevision(task);
  return store.getTasksApproval({
    repositoryKey: input.repositoryKey,
    taskId: task.id,
    operationClass: input.operationClass,
    contentRevision,
  }) !== null;
}

function tasksFailure(error: unknown, idempotencyKey: TasksActionRequest["idempotencyKey"]): FactoryActionResult {
  const message = errorMessage(error);
  if (error instanceof TasksIntegrationError && error.code === "tasks_unavailable") {
    return actionError("paused", `Tasks action is paused: ${message}`, idempotencyKey);
  }
  return actionError("internal", `Could not apply the Tasks action: ${message}`, idempotencyKey);
}

function approvalOutcome(
  request: TasksActionRequest,
  status: "accepted" | "already-applied",
  contentRevision: string,
) {
  const action = request.action as { readonly taskId: string; readonly operationClass: string };
  return {
    status,
    message: status === "already-applied"
      ? "The current Tasks approval was already recorded."
      : "The Tasks approval was recorded against the current task content.",
    revision: null,
    runId: null,
    leaseId: null,
    queueItemId: null,
    action: "approve-task" as const,
    taskId: action.taskId,
    operationClass: action.operationClass,
    contentRevision,
  };
}

function recordTasksApproval(input: {
  readonly store: Pick<OperationalStateStore, "createTasksApproval" | "getTasksApproval">;
  readonly repositoryKey: TasksActionRequest["repositoryKey"];
  readonly task: TasksTask;
  readonly approvalId: string;
  readonly operationClass: TasksOperationClass;
  readonly provenance: JsonValue;
  readonly createdAt: string;
}): { readonly contentRevision: string; readonly alreadyApplied: boolean } {
  const contentRevision = deriveTasksContentRevision(input.task);
  const existing = input.store.getTasksApproval({
    repositoryKey: input.repositoryKey,
    taskId: input.task.id,
    operationClass: input.operationClass,
    contentRevision,
  });
  if (existing !== null) return { contentRevision, alreadyApplied: true };
  input.store.createTasksApproval({
    approvalId: input.approvalId,
    repositoryKey: input.repositoryKey,
    taskId: input.task.id,
    operationClass: input.operationClass,
    contentRevision,
    provenance: input.provenance,
    createdAt: input.createdAt,
  });
  return { contentRevision, alreadyApplied: false };
}

function taskFromMutation(result: Awaited<ReturnType<TasksClient["createTask"]>>): TasksTask {
  if (result.ok) return result.task;
  throw new Error(result.error.message);
}

async function readOptionalFile(files: ProtocolFiles, configuration: RepositoryConfiguration, relativePath: string) {
  try {
    return await readTextFile(files, {
      hostId: configuration.connectedHostId,
      rootPath: configuration.checkoutPath,
      relativePath,
      repositoryKey: configuration.repositoryKey,
    });
  } catch (error) {
    if ((error instanceof ProtocolError && error.code === "file-not-found") || (error instanceof Error && /not found|no such file|path_not_found|path does not exist/iu.test(error.message))) return null;
    throw error;
  }
}

function importApprovalId(repositoryKey: string, taskId: string): string {
  return `import:${repositoryKey}:${taskId}:execute`;
}

async function ensureProject(options: TasksActionExecutorOptions, repositoryKey: string): Promise<TasksProject> {
  const existing = await options.tasksProjectLookup?.(repositoryKey);
  if (existing) return existing;
  const linkedBbProjectId = options.projectIdLookup?.(repositoryKey);
  if (!linkedBbProjectId) throw new Error(`No BB project is linked to repository '${repositoryKey}'.`);
  const existingByLink = (await options.tasksClient.listProjects()).find((project) => project.linkedBbProjectId === linkedBbProjectId);
  if (existingByLink) return existingByLink;
  return options.tasksClient.createProject({
    name: `Factory, ${repositoryKey}`,
    prefix: repositoryKey.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 10) || "FACTORY",
    linkedBbProjectId,
  });
}

async function ensureLabel(
  client: TasksClient,
  projectId: string,
  labels: Map<string, string>,
  name: string,
): Promise<string> {
  const normalized = name.toLowerCase();
  const existing = labels.get(normalized);
  if (existing) return existing;
  const created = await client.createLabel({ projectId, name, color: name === "question" ? "yellow" : "red" });
  labels.set(normalized, created.id);
  return created.id;
}

async function importProtocol(options: TasksActionExecutorOptions, repositoryKey: string, configuration: RepositoryConfiguration): Promise<{ created: number; blockers: number }> {
  if (!options.files || !options.projectIdLookup || !options.tasksProjectLookup) {
    throw new Error("Tasks import is unavailable because its repository and project adapters are not configured.");
  }
  const [queueFile, doneFile, questionsFile] = await Promise.all([
    readTextFile(options.files, { hostId: configuration.connectedHostId, rootPath: configuration.checkoutPath, relativePath: PROTOCOL_PATHS.queue, repositoryKey }),
    readOptionalFile(options.files, configuration, PROTOCOL_PATHS.done),
    readTextFile(options.files, { hostId: configuration.connectedHostId, rootPath: configuration.checkoutPath, relativePath: PROTOCOL_PATHS.questions, repositoryKey }),
  ]);
  const entries = [...parseQueue(queueFile.content, PROTOCOL_PATHS.queue), ...(doneFile ? parseQueue(doneFile.content, PROTOCOL_PATHS.done) : [])];
  const questions = parseQuestions(questionsFile.content, PROTOCOL_PATHS.questions);
  const project = await ensureProject(options, repositoryKey);
  const existingTasks = await options.tasksClient.listAllTasks({ projectId: project.id });
  const byDashboardId = new Map<string, TasksTask>();
  for (const task of existingTasks) {
    const dashboardId = dashboardIdFromDescription(task.description);
    if (dashboardId) byDashboardId.set(dashboardId, task);
  }
  const labels = new Map((await options.tasksClient.listLabels(project.id)).map((label) => [label.name.toLowerCase(), label.id]));
  const taskByDashboardId = new Map<string, TasksTask>();
  const importNow = options.now ?? (() => new Date());
  let created = 0;
  for (const entry of entries) {
    let task = byDashboardId.get(entry.id);
    const metadata = metadataForQueueEntry(entry);
    const labelIds: string[] = [];
    if (entry.status.kind === "blocked-by") labelIds.push(await ensureLabel(options.tasksClient, project.id, labels, "blocked"));
    if (!task) {
      task = taskFromMutation(await options.tasksClient.createTask({
        projectId: project.id,
        title: entry.title,
        description: renderFactoryTaskDescription(metadata),
        status: queueStatusToTaskStatus(entry.status.kind),
        priority: priorityToTaskPriority(entry.priority),
        labelIds,
      }));
      created += 1;
      byDashboardId.set(entry.id, task);
    }
    taskByDashboardId.set(entry.id, task);
  }
  for (const entry of entries) {
    const task = taskByDashboardId.get(entry.id);
    if (!task) continue;
    for (const dependency of entry.dependsOn) {
      const dependedOn = taskByDashboardId.get(dependency) ?? byDashboardId.get(dependency);
      options.store.createTasksDependencyEdge({
        repositoryKey,
        taskId: task.id,
        dependsOnTaskId: dependedOn?.id ?? dependency,
        provenance: { source: "queue-import", dashboardId: entry.id, dependency },
        createdAt: importNow().toISOString(),
      });
    }
  }
  const existingBlockers = new Map(options.store.listTasksBlockers(repositoryKey).map((blocker) => [blocker.blockerId, blocker]));
  let blockerCount = 0;
  for (const question of questions.filter((candidate) => candidate.classification === "blocking")) {
    let task = taskByDashboardId.get(question.dashboardId) ?? byDashboardId.get(question.dashboardId);
    const questionLabel = await ensureLabel(options.tasksClient, project.id, labels, "question");
    const questionDescription = renderFactoryQuestionDescription({
      questionId: question.id,
      date: question.date,
      question: question.question,
      context: question.context,
    });
    if (!task) {
      task = taskFromMutation(await options.tasksClient.createTask({
        projectId: project.id,
        title: `Question: ${question.question}`,
        description: questionDescription,
        status: "todo",
        priority: "high",
        labelIds: [questionLabel],
      }));
      created += 1;
    } else {
      const labelIds = (task.labelIds ?? []).includes(questionLabel)
        ? task.labelIds
        : [...(task.labelIds ?? []), questionLabel];
      const description = task.description?.includes(questionDescription)
        ? task.description
        : `${task.description?.trim() ?? ""}\n\n${questionDescription}`.trim();
      if (labelIds !== task.labelIds || description !== task.description) {
        await options.tasksClient.updateTask({ taskId: task.id, labelIds, description });
      }
    }
    const blockerId = factoryQuestionBlockerId(repositoryKey, question.id);
    if (!existingBlockers.has(blockerId)) {
      const blocker = options.store.createTasksBlocker({
        blockerId,
        repositoryKey,
        taskId: task.id,
        kind: "blocking-question",
        questionText: question.question,
        provenance: { source: "question-import", date: question.date, dashboardId: question.dashboardId },
        createdAt: importNow().toISOString(),
      });
      existingBlockers.set(blockerId, blocker);
      blockerCount += 1;
      if (question.answer) {
        options.store.updateTasksBlocker({ blockerId, state: "resolved", answerText: question.answer, updatedAt: importNow().toISOString() });
        const answerKey = `bbf:v1:${repositoryKey}:answer-question:${randomUUID()}`;
        options.store.claimQuestionAnswer({
          repositoryKey,
          idempotencyKey: answerKey,
          source: "repository-question",
          targetId: blockerId,
          requestFingerprint: createHash("sha256").update(JSON.stringify({ questionId: question.id, answer: question.answer }), "utf8").digest("hex"),
          submittedAt: importNow().toISOString(),
        });
        options.store.completeQuestionAnswer(answerKey, { status: "resolved", blockerId } satisfies JsonValue, importNow().toISOString());
      }
    }
  }
  for (const entry of entries) {
    const task = taskByDashboardId.get(entry.id);
    if (!task) continue;
    const questionIds = new Set(entry.blockedBy);
    if (entry.status.kind === "blocked-by") questionIds.add(entry.status.questionId);
    for (const questionId of questionIds) {
      const blockerId = factoryQuestionBlockerId(repositoryKey, questionId);
      if (existingBlockers.has(blockerId)) continue;
      const questionLabel = await ensureLabel(options.tasksClient, project.id, labels, "question");
      const questionText = `Blocked by question ${questionId}.`;
      const questionDescription = renderFactoryQuestionDescription({
        questionId,
        date: importNow().toISOString().slice(0, 10),
        question: questionText,
        context: entry.status.kind === "blocked-by" && entry.status.detail ? entry.status.detail : "Imported queue blocker",
      });
      const labelIds = (task.labelIds ?? []).includes(questionLabel)
        ? task.labelIds
        : [...(task.labelIds ?? []), questionLabel];
      const description = task.description?.includes(questionDescription)
        ? task.description
        : `${task.description?.trim() ?? ""}\n\n${questionDescription}`.trim();
      if (labelIds !== task.labelIds || description !== task.description) {
        await options.tasksClient.updateTask({ taskId: task.id, labelIds, description });
      }
      const blocker = options.store.createTasksBlocker({
        blockerId,
        repositoryKey,
        taskId: task.id,
        kind: "blocking-question",
        questionText,
        provenance: { source: "queue-import", dashboardId: entry.id, questionId },
        createdAt: importNow().toISOString(),
      });
      existingBlockers.set(blockerId, blocker);
      blockerCount += 1;
    }
  }
  const finalTasks = await options.tasksClient.listAllTasks({ projectId: project.id });
  const finalByDashboardId = new Map(finalTasks.map((candidate) => [dashboardIdFromDescription(candidate.description), candidate]));
  for (const entry of entries.filter((candidate) => candidate.approved.kind === "explicit")) {
    const task = finalByDashboardId.get(entry.id);
    if (!task) continue;
    recordTasksApproval({
      store: options.store,
      approvalId: importApprovalId(repositoryKey, task.id),
      repositoryKey,
      task,
      operationClass: "execute",
      provenance: {
        source: "imported-from-markdown-approval",
        approvedText: entry.approved.kind === "explicit" ? entry.approved.text : "",
      },
      createdAt: importNow().toISOString(),
    });
  }
  return { created, blockers: blockerCount };
}

export function createTasksActionExecutor(options: TasksActionExecutorOptions) {
  const now = options.now ?? (() => new Date());

  async function execute(request: TasksActionRequest): Promise<FactoryActionResult> {
    const parsed = tasksActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return actionError("invalid-input", `Invalid Tasks action request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const valid = parsed.data;
    const configuration = options.repositoryLookup(valid.repositoryKey);
    if (!configuration) {
      return actionError("not-found", `Repository '${valid.repositoryKey}' is not configured.`, valid.idempotencyKey);
    }
    if (!options.tasksClient.enabled) {
      return actionError("paused", "Tasks action is paused because Tasks integration is disabled.", valid.idempotencyKey);
    }

    if (valid.action.kind === "import-tasks") {
      try {
        const result = await importProtocol(options, valid.repositoryKey, configuration);
        return actionSuccess({
          status: result.created === 0 && result.blockers === 0 ? "already-applied" : "accepted",
          message: result.created === 0 && result.blockers === 0
            ? "The repository protocol was already imported into Tasks."
            : `Imported ${result.created} Tasks card(s) and ${result.blockers} blocker record(s).`,
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: null,
          action: "import-tasks" as const,
        }, null);
      } catch (error) {
        return tasksFailure(error, valid.idempotencyKey);
      }
    }

    if (valid.action.kind === "set-task-status") {
      try {
        const task = await options.tasksClient.getTask(valid.action.taskId)
          ?? await options.tasksClient.getTaskByKey(valid.action.taskId);
        if (!task) return actionError("not-found", `Tasks task '${valid.action.taskId}' was not found.`, valid.idempotencyKey);
        const result = await options.tasksClient.updateTask({ taskId: task.id, status: valid.action.status });
        if (!result.ok) return actionError("conflict", `Tasks rejected the status move: ${result.error.message}`, valid.idempotencyKey);
        return actionSuccess({
          status: "accepted",
          message: `Moved Tasks card ${task.key} to ${valid.action.status}.`,
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: task.key,
          action: "set-task-status" as const,
        }, null);
      } catch (error) {
        return tasksFailure(error, valid.idempotencyKey);
      }
    }

    if (valid.action.kind === "answer-question") {
      try {
        const blocker = options.store.getTasksBlocker(valid.action.questionId);
        if (!blocker || blocker.repositoryKey !== valid.repositoryKey) {
          return actionError("not-found", `Tasks blocker '${valid.action.questionId}' was not found.`, valid.idempotencyKey);
        }
        const requestFingerprint = createHash("sha256").update(JSON.stringify({ questionId: valid.action.questionId, answer: valid.action.answer }), "utf8").digest("hex");
        const claim = options.store.claimQuestionAnswer({
          repositoryKey: valid.repositoryKey,
          idempotencyKey: valid.idempotencyKey,
          source: "repository-question",
          targetId: blocker.blockerId,
          requestFingerprint,
          submittedAt: now().toISOString(),
        });
        if (claim.record.result !== null || blocker.state === "resolved") {
          if (claim.created && claim.record.result === null) {
            options.store.completeQuestionAnswer(valid.idempotencyKey, { status: "already-applied", blockerId: blocker.blockerId } satisfies JsonValue, now().toISOString());
          }
          return actionSuccess({
            status: "already-applied",
            message: "The Tasks blocker already has an answer.",
            revision: null,
            runId: null,
            leaseId: null,
            queueItemId: null,
            action: "answer-question" as const,
            source: "repository-question" as const,
            questionId: blocker.blockerId,
            interactionId: null,
          }, null);
        }
        options.store.updateTasksBlocker({
          blockerId: blocker.blockerId,
          state: "resolved",
          answerText: valid.action.answer,
          updatedAt: now().toISOString(),
        });
        try {
          await options.tasksClient.createComment({ taskId: blocker.taskId, body: `Factory answer: ${valid.action.answer}` });
        } catch {
          // The ledger is the authority. A comment is a display aid only.
        }
        options.store.completeQuestionAnswer(valid.idempotencyKey, { status: "resolved", blockerId: blocker.blockerId } satisfies JsonValue, now().toISOString());
        return actionSuccess({
          status: "accepted",
          message: "Recorded the answer and resolved the Tasks blocker.",
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: null,
          action: "answer-question" as const,
          source: "repository-question" as const,
          questionId: blocker.blockerId,
          interactionId: null,
        }, null);
      } catch (error) {
        return tasksFailure(error, valid.idempotencyKey);
      }
    }

    if (valid.action.kind === "approve-queue") {
      try {
        const task = await options.tasksClient.getTaskByKey(valid.action.queueItemId);
        if (!task) return actionError("not-found", `Tasks card '${valid.action.queueItemId}' was not found.`, valid.idempotencyKey);
        const grant = recordTasksApproval({
          store: options.store,
          approvalId: valid.idempotencyKey,
          repositoryKey: valid.repositoryKey,
          task,
          operationClass: "execute",
          provenance: { source: "factory-guarded-action", action: "approve-queue", approvedText: valid.action.approvedText },
          createdAt: now().toISOString(),
        });
        if (grant.alreadyApplied) {
          return actionSuccess({
            status: "already-applied",
            message: "The current Tasks approval was already recorded.",
            revision: null,
            runId: null,
            leaseId: null,
            queueItemId: task.key,
            action: "approve-queue" as const,
            questionId: null,
            interactionId: null,
          }, null);
        }
        if (task.status === "backlog") {
          await options.tasksClient.updateTask({ taskId: task.id, status: "todo" });
        }
        return actionSuccess({
          status: "accepted",
          message: "Recorded the Tasks approval in the Factory ledger.",
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: task.key,
          action: "approve-queue" as const,
          questionId: null,
          interactionId: null,
        }, null);
      } catch (error) {
        return tasksFailure(error, valid.idempotencyKey);
      }
    }

    let task;
    try {
      task = await options.tasksClient.getTask(valid.action.taskId);
    } catch (error) {
      return tasksFailure(error, valid.idempotencyKey);
    }
    if (task === null) {
      return actionError("not-found", `Tasks task '${valid.action.taskId}' was not found.`, valid.idempotencyKey);
    }

    let grant: { readonly contentRevision: string; readonly alreadyApplied: boolean };
    try {
      // This grant is issued only by a guarded Factory action. Phase 0 showed
      // that Tasks comments, labels, and status changes are not authorization.
      grant = recordTasksApproval({
        store: options.store,
        approvalId: valid.idempotencyKey,
        repositoryKey: valid.repositoryKey,
        task,
        operationClass: valid.action.operationClass,
        provenance: {
          source: "factory-guarded-action",
          surface: "factory-ui",
          action: valid.action.kind,
          idempotencyKey: valid.idempotencyKey,
        },
        createdAt: now().toISOString(),
      });
    } catch (error) {
      return actionError("conflict", `Could not record the Tasks approval: ${errorMessage(error)}`, valid.idempotencyKey);
    }
    return actionSuccess(approvalOutcome(valid, grant.alreadyApplied ? "already-applied" : "accepted", grant.contentRevision), null);
  }

  return { execute };
}
