import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_REPOSITORY_REVISION, tasksActionRequestSchema } from "../src/contracts.js";
import {
  createTasksActionExecutor,
  hasCurrentTasksApproval,
} from "../src/actions/tasks.js";
import { TasksClient, type TasksRpcCall, type TasksTask } from "../src/tasks/index.js";
import {
  cleanupStorages,
  makeConfiguration,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

describe("Tasks approval action", () => {
  it("fences bound content while ignoring status and comments", async () => {
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
    await expect(hasCurrentTasksApproval(tasksClient, store, {
      repositoryKey: "monorepo",
      taskId: task.id,
      operationClass: "execute",
    })).resolves.toBe(true);

    task = { ...task, title: "Ship the changed migration" };
    await expect(hasCurrentTasksApproval(tasksClient, store, {
      repositoryKey: "monorepo",
      taskId: task.id,
      operationClass: "execute",
    })).resolves.toBe(false);

    task = { ...task, title: "Ship the migration", status: "done" };
    await expect(hasCurrentTasksApproval(tasksClient, store, {
      repositoryKey: "monorepo",
      taskId: task.id,
      operationClass: "execute",
    })).resolves.toBe(true);
    await tasksClient.createComment({ taskId: task.id, body: "Progress update" });
    await expect(hasCurrentTasksApproval(tasksClient, store, {
      repositoryKey: "monorepo",
      taskId: task.id,
      operationClass: "execute",
    })).resolves.toBe(true);
  });
});
