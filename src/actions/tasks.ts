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
} from "../tasks/index.js";
import type {
  OperationalStateStore,
  TasksOperationClass,
} from "../storage/index.js";
import { actionError, actionSuccess } from "./results.js";

export interface TasksActionExecutorOptions {
  readonly tasksClient: TasksClient;
  readonly store: Pick<OperationalStateStore, "createTasksApproval" | "getTasksApproval">;
  readonly repositoryLookup: (repositoryKey: string) => RepositoryConfiguration | null;
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
    return actionError("paused", `Tasks approval is paused: ${message}`, idempotencyKey);
  }
  return actionError("internal", `Could not approve the Tasks task: ${message}`, idempotencyKey);
}

function approvalOutcome(
  request: TasksActionRequest,
  status: "accepted" | "already-applied",
  contentRevision: string,
) {
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
    taskId: request.action.taskId,
    operationClass: request.action.operationClass,
    contentRevision,
  };
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
      return actionError("paused", "Tasks approval is paused because Tasks integration is disabled.", valid.idempotencyKey);
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

    const contentRevision = deriveTasksContentRevision(task);
    const existing = options.store.getTasksApproval({
      repositoryKey: valid.repositoryKey,
      taskId: task.id,
      operationClass: valid.action.operationClass,
      contentRevision,
    });
    if (existing !== null) {
      return actionSuccess(approvalOutcome(valid, "already-applied", contentRevision), null);
    }

    try {
      // This grant is issued only by a guarded Factory action. Phase 0 showed
      // that Tasks comments, labels, and status changes are not authorization.
      options.store.createTasksApproval({
        approvalId: valid.idempotencyKey,
        repositoryKey: valid.repositoryKey,
        taskId: task.id,
        operationClass: valid.action.operationClass,
        contentRevision,
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
    return actionSuccess(approvalOutcome(valid, "accepted", contentRevision), null);
  }

  return { execute };
}
