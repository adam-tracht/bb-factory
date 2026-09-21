import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_REPOSITORY_REVISION, tasksActionRequestSchema } from "../src/contracts.js";
import {
  createTasksActionExecutor,
  hasCurrentTasksApproval,
} from "../src/actions/tasks.js";
import {
  deriveTasksContentRevision,
  TasksClient,
  type TasksRpcCall,
  type TasksTask,
} from "../src/tasks/index.js";
import {
  cleanupStorages,
  makeConfiguration,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

describe("Tasks approval action", () => {
  it("recovers approve-queue after a failed status move and reconciles retries", async () => {
    const task: TasksTask = {
      id: "task-partial",
      projectId: "project-1",
      key: "FAC-PARTIAL",
      title: "Recover approval",
      description: "Implement the approved scope.",
      status: "backlog",
      priority: "high",
      dueDate: null,
      labelIds: [],
      parentTaskId: null,
      position: 1,
    };
    let statusMoveAttempts = 0;
    const tasksClient = new TasksClient((async ({ method, input }: Parameters<TasksRpcCall>[0]) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (method === "getTaskByKey") return { task };
      if (method === "updateTask") {
        statusMoveAttempts += 1;
        if (statusMoveAttempts === 1) return { ok: false, error: { code: "conflict", message: "card changed" } };
        task.status = String(args.status);
        return { ok: true, task };
      }
      throw new Error(`Unexpected Tasks RPC ${method}`);
    }) as never);
    const store = makeStore();
    const request = tasksActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "approve-queue", queueItemId: task.key, approvedText: "Approved after recovery." },
      idempotencyKey: "bbf:v1:monorepo:approve-queue:223e4567-e89b-42d3-a456-426614174000",
      expectedRevision: EMPTY_REPOSITORY_REVISION,
    });
    const executor = createTasksActionExecutor({
      tasksClient,
      store,
      repositoryLookup: (key) => key === "monorepo" ? makeConfiguration() : null,
      now: () => new Date("2026-09-21T16:00:00Z"),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(store.listTasksApprovals("monorepo")).toHaveLength(0);
    await expect(executor.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { status: "accepted", action: "approve-queue", queueItemId: task.key },
    });
    await expect(executor.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { status: "already-applied", action: "approve-queue", queueItemId: task.key },
    });
    expect(statusMoveAttempts).toBe(3);
    expect(task.status).toBe("todo");
    expect(store.listTasksApprovals("monorepo", task.id)).toHaveLength(1);
  });

  it("routes approve-queue through the revision-bound grant path", async () => {
    let task: TasksTask = {
      id: "task-queue",
      projectId: "project-1",
      key: "FAC-QUEUE",
      title: "Approve the queued task",
      description: "Implement the approved scope.",
      status: "backlog",
      priority: "high",
      dueDate: null,
      labelIds: [],
      parentTaskId: null,
      position: 1,
    };
    const tasksClient = new TasksClient((async ({ method, input }: Parameters<TasksRpcCall>[0]) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (method === "getTaskByKey") return { task };
      if (method === "updateTask") {
        task = { ...task, status: String(args.status) };
        return { ok: true, task };
      }
      throw new Error(`Unexpected Tasks RPC ${method}`);
    }) as never);
    const store = makeStore();
    const request = tasksActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "approve-queue", queueItemId: task.key, approvedText: "Approved by the operator." },
      idempotencyKey: "bbf:v1:monorepo:approve-queue:123e4567-e89b-42d3-a456-426614174000",
      expectedRevision: EMPTY_REPOSITORY_REVISION,
    });
    const executor = createTasksActionExecutor({
      tasksClient,
      store,
      repositoryLookup: (key) => key === "monorepo" ? makeConfiguration() : null,
      now: () => new Date("2026-09-21T16:00:00Z"),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { status: "accepted", action: "approve-queue", queueItemId: task.key },
    });
    expect(store.listTasksApprovals("monorepo", task.id)).toMatchObject([{
      taskId: task.id,
      operationClass: "execute",
      contentRevision: deriveTasksContentRevision(task),
      provenance: {
        source: "factory-guarded-action",
        action: "approve-queue",
        approvedText: "Approved by the operator.",
      },
    }]);
    expect(task.status).toBe("todo");
  });

  it("fences every bound field while ignoring normalized and excluded changes", async () => {
    let task: TasksTask = {
      id: "task-1",
      projectId: "project-1",
      key: "FAC-1",
      title: "Ship the migration",
      description: "Implement the approved scope.",
      status: "todo",
      priority: "high" as const,
      dueDate: null,
      labelIds: ["label-a", "label-b"],
      parentTaskId: null,
      position: 1,
    };
    const baseTask = { ...task };
    const tasksClient = new TasksClient((async ({ method }: Parameters<TasksRpcCall>[0]) => {
      if (method === "getTask") return { task };
      if (method === "createComment") {
        return {
          comment: {
            id: "comment-1",
            taskId: task.id,
            body: "Progress update",
          },
        };
      }
      throw new Error(`Unexpected Tasks RPC ${method}`);
    }) as never);
    const store = makeStore();
    const request = tasksActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "approve-task", taskId: task.id, operationClass: "execute" },
      idempotencyKey: "bbf:v1:monorepo:approve-task:123e4567-e89b-42d3-a456-426614174000",
      expectedRevision: EMPTY_REPOSITORY_REVISION,
    });
    const executor = createTasksActionExecutor({
      tasksClient,
      store,
      repositoryLookup: (key) => key === "monorepo" ? makeConfiguration() : null,
      now: () => new Date("2026-09-21T16:00:00Z"),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { status: "accepted", action: "approve-task", taskId: task.id },
    });
    const hasCurrentApproval = () => hasCurrentTasksApproval(tasksClient, store, {
      repositoryKey: "monorepo",
      taskId: task.id,
      operationClass: "execute",
    });
    await expect(hasCurrentApproval()).resolves.toBe(true);

    const expectBoundChangeToInvalidate = async (
      change: Partial<Pick<TasksTask, "title" | "description" | "dueDate" | "labelIds" | "parentTaskId">>,
    ) => {
      task = { ...baseTask, ...change };
      await expect(hasCurrentApproval()).resolves.toBe(false);
      task = { ...baseTask };
      await expect(hasCurrentApproval()).resolves.toBe(true);
    };

    await expectBoundChangeToInvalidate({ title: "Ship the changed migration" });
    await expectBoundChangeToInvalidate({ description: "A changed implementation scope." });
    await expectBoundChangeToInvalidate({ dueDate: "2026-10-01" });
    await expectBoundChangeToInvalidate({ labelIds: ["label-c"] });
    await expectBoundChangeToInvalidate({ parentTaskId: "task-parent" });

    task = { ...baseTask, labelIds: ["label-b", "label-a"] };
    await expect(hasCurrentApproval()).resolves.toBe(true);

    const missingOptionalFields = {
      title: baseTask.title,
      dueDate: baseTask.dueDate,
      parentTaskId: baseTask.parentTaskId,
    };
    expect(deriveTasksContentRevision(missingOptionalFields)).toBe(deriveTasksContentRevision({
      ...missingOptionalFields,
      description: undefined,
      labelIds: undefined,
    }));

    await tasksClient.createComment({ taskId: task.id, body: "Progress update" });
    task = {
      ...baseTask,
      status: "done",
      priority: "urgent",
      updatedAt: "2026-09-21T17:00:00Z",
      comments: [{ id: "comment-1", body: "Progress update" }],
    };
    await expect(hasCurrentApproval()).resolves.toBe(true);
  });
});
