import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";

const TASKS_PLUGIN_ID = "tasks";

export const tasksIntegrationModeSchema = z.enum(["disabled", "enabled"]);
export type TasksIntegrationMode = z.infer<typeof tasksIntegrationModeSchema>;

const taskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
const taskPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
const taskThreadStatusSchema = z.enum(["starting", "working", "idle", "completed", "failed"]);

/**
 * These schemas select only fields the factory needs and tolerate additive
 * fields from newer Tasks releases.
 */
export const tasksProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    prefix: z.string(),
    color: z.string(),
    linkedBbProjectId: z.string().nullable(),
  })
  .passthrough();

export const tasksTaskSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    key: z.string(),
    title: z.string(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    description: z.string().nullable().optional(),
    dueDate: z.string().nullable(),
    labelIds: z.array(z.string()).optional(),
    parentTaskId: z.string().nullable(),
    position: z.number(),
  })
  .passthrough();

export const tasksTaskThreadSchema = z
  .object({
    threadId: z.string().min(1),
    presetName: z.string(),
    title: z.string(),
    liveStatus: taskThreadStatusSchema,
    attachedAt: z.string().nullable().optional(),
    id: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  })
  .passthrough();

export const tasksCommentSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    body: z.string().optional(),
    content: z.string().optional(),
    authorName: z.string().nullable().optional(),
    kind: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const tasksProjectListSchema = z.object({ projects: z.array(tasksProjectSchema) }).passthrough();
const tasksThreadListSchema = z.object({ taskThreads: z.array(tasksTaskThreadSchema) }).passthrough();
const tasksBbProjectListSchema = z
  .object({
    bbProjects: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
  })
  .passthrough();
const tasksGetTaskSchema = z.object({ task: tasksTaskSchema.nullable() }).passthrough();
const tasksCommentListSchema = z.object({ comments: z.array(tasksCommentSchema) }).passthrough();
const tasksDomainErrorSchema = z.object({ code: z.string().min(1), message: z.string() }).passthrough();
const tasksMutationSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: tasksTaskSchema }).passthrough(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).passthrough(),
]);
const tasksCommentResultSchema = z.union([
  tasksCommentSchema,
  z.object({ comment: tasksCommentSchema }).passthrough(),
]);
const tasksDeleteResultSchema = z
  .object({ ok: z.boolean(), error: tasksDomainErrorSchema.optional() })
  .passthrough();

export type TasksProject = z.infer<typeof tasksProjectSchema>;
export type TasksTask = z.infer<typeof tasksTaskSchema>;
export type TasksTaskThread = z.infer<typeof tasksTaskThreadSchema>;
export type TasksComment = z.infer<typeof tasksCommentSchema>;
export type TasksMutationResult = z.infer<typeof tasksMutationSchema>;
export type TasksTaskStatus = z.infer<typeof taskStatusSchema>;
export type TasksWorkStatus = Exclude<TasksTaskStatus, "canceled">;
export type TasksRpcCall = BbPluginApi["sdk"]["plugins"]["callRpc"];

const tasksApprovalContentSchema = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    dueDate: z.string().nullable(),
    labelIds: z.array(z.string()),
    parentTaskId: z.string().nullable(),
  })
  .strict();
export type TasksApprovalContent = z.infer<typeof tasksApprovalContentSchema>;

/**
 * Derive the revision an approval is bound to. Only title, description,
 * dueDate, label ids, and parentTaskId are covered. Status, comments, and
 * updatedAt are intentionally excluded so progress and discussion do not
 * invalidate an approval.
 */
export function deriveTasksContentRevision(
  task: Pick<TasksTask, "title" | "description" | "dueDate" | "labelIds" | "parentTaskId">,
): string {
  const content: TasksApprovalContent = tasksApprovalContentSchema.parse({
    title: task.title,
    description: task.description ?? null,
    dueDate: task.dueDate,
    labelIds: [...(task.labelIds ?? [])].sort(),
    parentTaskId: task.parentTaskId,
  });
  return createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
}

export interface TasksCreateInput {
  readonly projectId: string;
  readonly title: string;
  readonly status: TasksWorkStatus;
  readonly description?: string;
  readonly priority?: Exclude<z.infer<typeof taskPrioritySchema>, "none"> | "none";
  readonly dueDate?: string | null;
  readonly parentTaskId?: string | null;
  readonly labelIds?: readonly string[];
}

export interface TasksUpdateInput {
  readonly taskId: string;
  readonly title?: string;
  readonly description?: string;
  readonly status?: TasksTaskStatus;
  readonly priority?: z.infer<typeof taskPrioritySchema>;
  readonly dueDate?: string | null;
  readonly parentTaskId?: string | null;
  readonly labelIds?: readonly string[];
}

export interface TasksCreateCommentInput {
  readonly taskId: string;
  readonly body: string;
}

export type TasksIntegrationErrorCode =
  | "tasks_unavailable"
  | "tasks_contract_incompatible"
  | "tasks_pagination_unstable"
  | "tasks_rpc_failed";

export class TasksIntegrationError extends Error {
  public constructor(
    public readonly code: TasksIntegrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TasksIntegrationError";
  }
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current === null || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      pending.push(current.cause);
    }
    if (typeof current === "object") {
      const value = current as {
        body?: unknown;
        cause?: unknown;
        code?: unknown;
        error?: unknown;
        message?: unknown;
        status?: unknown;
        statusCode?: unknown;
      };
      if (typeof value.code === "string") parts.push(value.code);
      if (typeof value.message === "string" && !(current instanceof Error)) parts.push(value.message);
      if (typeof value.status === "number" || typeof value.status === "string") parts.push(String(value.status));
      if (typeof value.statusCode === "number" || typeof value.statusCode === "string") parts.push(String(value.statusCode));
      pending.push(value.body, value.error, value.cause);
    } else {
      parts.push(String(current));
    }
  }
  return parts.join(" ");
}

function hasHttpStatus(error: unknown, status: number, detail: string): boolean {
  if (new RegExp(`\\bHTTP\\s+${status}\\b`, "i").test(detail)) return true;
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current === null || visited.has(current)) continue;
    visited.add(current);
    if (typeof current === "object") {
      const value = current as { status?: unknown; statusCode?: unknown; body?: unknown; error?: unknown; cause?: unknown };
      if (value.status === status || value.statusCode === status) return true;
      if (String(value.status ?? "") === String(status) || String(value.statusCode ?? "") === String(status)) return true;
      pending.push(value.body, value.error, value.cause);
    }
  }
  return false;
}

function classifyRpcFailure(method: string, error: unknown): TasksIntegrationError {
  if (error instanceof TasksIntegrationError) return error;
  if (error instanceof z.ZodError) {
    return new TasksIntegrationError(
      "tasks_contract_incompatible",
      `Tasks ${method} returned data the factory cannot understand. Update Tasks and Factory, then refresh.`,
      { cause: error },
    );
  }
  const detail = errorText(error);
  const lower = detail.toLowerCase();
  const unknownRpcMethod = hasHttpStatus(error, 404, detail) && lower.includes("no rpc method");
  const pluginUnavailable = /\bplugin(?:\s+is)?\s+(?:not found|not running|disabled)\b/i.test(detail);
  if (unknownRpcMethod || pluginUnavailable) {
    return new TasksIntegrationError(
      "tasks_unavailable",
      `Tasks ${method} is unavailable. Enable a compatible Tasks plugin and refresh Factory. ${detail}`.trim(),
      { cause: error },
    );
  }
  const rpcInputValidation = hasHttpStatus(error, 400, detail) && lower.includes("rpc input validation");
  if (rpcInputValidation
    || lower.includes("invalid_output")
    || lower.includes("output validation")
    || lower.includes("contract")
    || lower.includes("zod")) {
    return new TasksIntegrationError(
      "tasks_contract_incompatible",
      `Tasks ${method} is incompatible with this Factory build. Update Tasks and Factory, then refresh. ${detail}`.trim(),
      { cause: error },
    );
  }
  return new TasksIntegrationError(
    "tasks_rpc_failed",
    `Tasks ${method} failed. Retry from Factory; if it persists, check the Tasks plugin status. ${detail}`.trim(),
    { cause: error },
  );
}

function unwrap<T extends TasksComment>(value: T | { comment: T }): T {
  if ("comment" in value) return (value as { comment: T }).comment;
  return value as T;
}

function optionalFields(input: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

export class TasksClient {
  public constructor(
    private readonly callRpc: TasksRpcCall | undefined,
    private readonly integration: TasksIntegrationMode = "enabled",
  ) {}

  public get enabled(): boolean {
    return this.integration === "enabled";
  }

  private async call<T>(method: string, input: JsonValue | undefined, outputSchema: z.ZodType<T>): Promise<T> {
    if (!this.enabled) {
      throw new TasksIntegrationError("tasks_unavailable", "Tasks integration is disabled in Factory settings.");
    }
    if (!this.callRpc) {
      throw new TasksIntegrationError("tasks_unavailable", "The host does not expose the Tasks RPC surface.");
    }
    try {
      const output = await this.callRpc({
        pluginId: TASKS_PLUGIN_ID,
        method,
        ...(input === undefined ? {} : { input }),
        outputSchema,
      });
      return outputSchema.parse(output);
    } catch (error) {
      throw classifyRpcFailure(method, error);
    }
  }

  /** Health probe only. Project management stays deferred to cutover. */
  public async listProjects(): Promise<TasksProject[]> {
    return (await this.call("listProjects", {}, tasksProjectListSchema)).projects;
  }

  public async listBbProjects(): Promise<Array<{ id: string; name: string }>> {
    return (await this.call("listBbProjects", null, tasksBbProjectListSchema)).bbProjects;
  }

  public async listTaskThreads(taskId: string): Promise<TasksTaskThread[]> {
    return (await this.call("listTaskThreads", { taskId }, tasksThreadListSchema)).taskThreads;
  }

  public async getTask(taskId: string): Promise<TasksTask | null> {
    return (await this.call("getTask", { taskId }, tasksGetTaskSchema)).task;
  }

  public async getTaskByKey(taskKey: string): Promise<TasksTask | null> {
    return (await this.call("getTaskByKey", { taskKey }, tasksGetTaskSchema)).task;
  }

  public async createTask(input: TasksCreateInput): Promise<TasksMutationResult> {
    return this.call(
      "createTask",
      optionalFields({
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? "",
        status: input.status,
        priority: input.priority ?? "none",
        dueDate: input.dueDate ?? null,
        parentTaskId: input.parentTaskId ?? null,
        labelIds: input.labelIds === undefined ? [] : [...input.labelIds],
      }),
      tasksMutationSchema,
    );
  }

  public async updateTask(input: TasksUpdateInput): Promise<TasksMutationResult> {
    return this.call(
      "updateTask",
      optionalFields({
        taskId: input.taskId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate,
        parentTaskId: input.parentTaskId,
        labelIds: input.labelIds === undefined ? undefined : [...input.labelIds],
      }),
      tasksMutationSchema,
    );
  }

  public async deleteTask(taskId: string): Promise<{ ok: boolean; error?: z.infer<typeof tasksDomainErrorSchema> }> {
    return this.call("deleteTask", { taskId }, tasksDeleteResultSchema);
  }

  public async createComment(input: TasksCreateCommentInput): Promise<TasksComment> {
    return unwrap(await this.call("createComment", { taskId: input.taskId, body: input.body }, tasksCommentResultSchema));
  }

  public async listComments(taskId: string): Promise<TasksComment[]> {
    return (await this.call("listComments", { taskId }, tasksCommentListSchema)).comments;
  }
}

export interface TasksAvailability {
  readonly enabled: boolean;
  readonly status: "available" | "disabled-or-unavailable" | "contract-incompatible";
  readonly message: string;
}

export async function probeTasksAvailability(client: TasksClient): Promise<TasksAvailability> {
  if (!client.enabled) {
    return { enabled: false, status: "disabled-or-unavailable", message: "Tasks integration is disabled in Factory settings." };
  }
  try {
    await client.listProjects();
    return { enabled: true, status: "available", message: "Tasks is available." };
  } catch (error) {
    const integrationError = error instanceof TasksIntegrationError
      ? error
      : new TasksIntegrationError("tasks_rpc_failed", String(error), { cause: error });
    return {
      enabled: true,
      status: integrationError.code === "tasks_contract_incompatible"
        ? "contract-incompatible"
        : "disabled-or-unavailable",
      message: integrationError.message,
    };
  }
}
