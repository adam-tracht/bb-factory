import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_REPOSITORY_REVISION, tasksActionRequestSchema } from "../src/contracts.js";
import { createTasksActionExecutor } from "../src/actions/tasks.js";
import { projectTasks, renderFactoryTaskDescription, type FactoryTaskMetadata } from "../src/tasks/migration.js";
import { deriveTasksContentRevision, TasksClient, type TasksRpcCall, type TasksTask } from "../src/tasks/index.js";
import { RepositoryProtocolReader, staticMergeReader, type ProtocolFiles } from "../src/protocol/index.js";
import { makeConfiguration, makeStore, FakeFileSystem, cleanupStorages } from "./fakes.js";

afterEach(cleanupStorages);

const project = { id: "tasks-project", name: "Factory", prefix: "FAC", color: "#123456", linkedBbProjectId: "project-1" } as const;

function metadata(overrides: Partial<FactoryTaskMetadata> = {}): FactoryTaskMetadata {
  return {
    dashboardId: null,
    priority: 2,
    dependsOn: [],
    risk: "low",
    planPath: "plans/factory/plan.md",
    acceptance: ["works"],
    validate: ["pnpm test"],
    notes: null,
    approvedScopes: [],
    approvedText: null,
    questionId: null,
    questionDate: null,
    questionText: null,
    ...overrides,
  };
}

function task(id: string, key: string, status: string, taskMetadata = metadata()): TasksTask {
  return {
    id,
    projectId: project.id,
    key,
    title: key,
    status,
    priority: "high",
    description: renderFactoryTaskDescription(taskMetadata),
    dueDate: null,
    labelIds: [],
    parentTaskId: null,
    position: 1,
  };
}

function clientFor(tasks: TasksTask[], labels: Array<{ id: string; projectId: string; name: string; color: string }> = []) {
  return new TasksClient((async ({ method, input }: Parameters<TasksRpcCall>[0]) => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (method === "listTasks") return { tasks: tasks.filter((candidate) => candidate.projectId === args.projectId), nextCursor: null };
    if (method === "listLabels") return { labels };
    if (method === "createLabel") {
      const label = { id: `label-${labels.length + 1}`, projectId: String(args.projectId), name: String(args.name), color: String(args.color) };
      labels.push(label);
      return { label };
    }
    if (method === "createTask") {
      const created: TasksTask = {
        id: `task-${tasks.length + 1}`,
        projectId: String(args.projectId),
        key: `FAC-${tasks.length + 1}`,
        title: String(args.title),
        status: String(args.status),
        priority: String(args.priority) as TasksTask["priority"],
        description: String(args.description ?? ""),
        dueDate: null,
        labelIds: (args.labelIds as string[] | undefined) ?? [],
        parentTaskId: null,
        position: tasks.length + 1,
      };
      tasks.push(created);
      return { ok: true, task: created };
    }
    if (method === "updateTask") {
      const current = tasks.find((candidate) => candidate.id === args.taskId)!;
      if (args.status !== undefined) current.status = String(args.status);
      if (args.description !== undefined) current.description = String(args.description);
      if (args.labelIds !== undefined) current.labelIds = args.labelIds as string[];
      return { ok: true, task: current };
    }
    if (method === "listProjects") return { projects: [project] };
    throw new Error(`Unexpected Tasks RPC ${method}`);
  }) as never);
}

describe("native Tasks migration projection", () => {
  it("maps native statuses and gates on ledger dependencies, blockers, and current approvals", async () => {
    const tasks = [
      task("task-draft", "FAC-1", "backlog"),
      task("task-ready", "FAC-2", "todo"),
      task("task-progress", "FAC-3", "in_progress"),
      task("task-done", "FAC-4", "done"),
      task("task-unknown", "FAC-5", "custom_status"),
      task("task-dependent", "FAC-6", "todo"),
      task("task-blocked", "FAC-7", "todo"),
      task("task-resolved", "FAC-8", "todo"),
      task("task-approved", "FAC-9", "todo", metadata({ approvedScopes: ["execute"] })),
      task("task-stale", "FAC-10", "todo", metadata({ approvedScopes: ["execute"] })),
      {
        ...task("task-run", "FAC-11", "todo"),
        description: "Factory run id: run-1\nQueue entry id: FAC-6",
      },
      {
        ...task("task-question-card", "FAC-12", "todo"),
        description: "<!-- factory-question {\"questionId\":\"Q-card\",\"questionDate\":\"2026-09-21\",\"questionText\":\"Which provider?\"} -->\nQuestion Q-card",
      },
    ];
    const store = makeStore();
    store.createTasksDependencyEdge({ repositoryKey: "monorepo", taskId: "task-dependent", dependsOnTaskId: "task-done", provenance: { source: "test" } });
    store.createTasksDependencyEdge({ repositoryKey: "monorepo", taskId: "task-ready", dependsOnTaskId: "task-dependent", provenance: { source: "test" } });
    for (const taskId of ["task-dependent", "task-resolved"]) {
      store.createTasksApproval({
        approvalId: `approval-${taskId}`,
        repositoryKey: "monorepo",
        taskId,
        operationClass: "execute",
        contentRevision: deriveTasksContentRevision(tasks.find((candidate) => candidate.id === taskId)!),
        provenance: { source: "test" },
      });
    }
    store.createTasksBlocker({ blockerId: "Q-open", repositoryKey: "monorepo", taskId: "task-blocked", kind: "blocking-question", questionText: "Open?", provenance: { source: "test" } });
    const resolved = store.createTasksBlocker({ blockerId: "Q-resolved", repositoryKey: "monorepo", taskId: "task-resolved", kind: "blocking-question", questionText: "Resolved?", provenance: { source: "test" } });
    store.updateTasksBlocker({ blockerId: resolved.blockerId, state: "resolved", answerText: "yes" });
    store.createTasksApproval({
      approvalId: "approval-current",
      repositoryKey: "monorepo",
      taskId: "task-approved",
      operationClass: "execute",
      contentRevision: deriveTasksContentRevision(tasks[8]!),
      provenance: { source: "test" },
    });
    store.createTasksApproval({
      approvalId: "approval-stale",
      repositoryKey: "monorepo",
      taskId: "task-stale",
      operationClass: "execute",
      contentRevision: "old-content-revision",
      provenance: { source: "test" },
    });
    const projection = await projectTasks(clientFor(tasks), store, { repositoryKey: "monorepo", project });
    const byKey = new Map(projection.queue.map((entry) => [entry.id, entry]));
    expect(byKey.get("FAC-1")?.status).toEqual({ kind: "draft" });
    expect(byKey.get("FAC-2")?.eligibilityReasons).toContain("unmet-dependency");
    expect(byKey.get("FAC-3")?.status.kind).toBe("in-progress");
    expect(byKey.get("FAC-4")?.status.kind).toBe("done");
    expect(byKey.get("FAC-5")?.status).toEqual({ kind: "unknown", raw: "custom_status" });
    expect(byKey.get("FAC-6")?.eligible).toBe(true);
    expect(byKey.get("FAC-7")?.eligibilityReasons).toContain("blocking-question");
    expect(byKey.get("FAC-8")?.eligible).toBe(true);
    expect(byKey.get("FAC-9")?.eligible).toBe(true);
    expect(byKey.get("FAC-10")?.eligibilityReasons).toContain("missing-authorization");
    expect(byKey.has("FAC-11")).toBe(false);
    expect(byKey.has("FAC-12")).toBe(false);
  });

  it("imports queue and questions idempotently by the embedded dashboard id", async () => {
    const files = new FakeFileSystem();
    files.seedProtocol({
      "plans/factory/queue.md": `# Queue\n\n## T1 Imported task\nstatus: ready\npriority: 2\ndepends_on: none\nrisk: low\nplan: plans/factory/plan.md\napproved: none\nacceptance:\n- works\nvalidate:\n- pnpm test\nnotes: none\n`,
      "plans/factory/questions.md": `# Questions\n\n## Q1 2026-09-21 blocking T1\nquestion: Which provider?\ncontext: Choose one.\nanswer:\n`,
    });
    const tasks: TasksTask[] = [];
    const labels: Array<{ id: string; projectId: string; name: string; color: string }> = [];
    const store = makeStore();
    const executor = createTasksActionExecutor({
      tasksClient: clientFor(tasks, labels),
      store,
      repositoryLookup: () => makeConfiguration(),
      files,
      projectIdLookup: () => "project-1",
      tasksProjectLookup: async () => project,
    });
    const request = tasksActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "import-tasks" },
      idempotencyKey: "bbf:v1:monorepo:import-tasks:123e4567-e89b-42d3-a456-426614174000",
      expectedRevision: EMPTY_REPOSITORY_REVISION,
    });
    await expect(executor.execute(request)).resolves.toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(tasks).toHaveLength(1);
    expect(store.getTasksBlocker("factory:monorepo:question:Q1")).toMatchObject({ taskId: tasks[0]!.id, state: "open" });
    expect(tasks[0]!.description).toContain("Which provider?");
    await expect(executor.execute(request)).resolves.toMatchObject({ ok: true, result: { status: "already-applied" } });
    expect(tasks).toHaveLength(1);
    expect(store.listTasksBlockers("monorepo")).toHaveLength(1);
  });

  it("does not read queue, questions, current, or lock files in enabled mode", async () => {
    const files = new FakeFileSystem();
    files.seedProtocol();
    const taskValue = task("task-1", "FAC-1", "todo");
    const client = clientFor([taskValue]);
    const store = makeStore();
    const reads: string[] = [];
    const protocolFiles: ProtocolFiles = {
      read: async (args) => {
        const relative = args.path.replace(`${makeConfiguration().checkoutPath}/`, "");
        reads.push(relative);
        if (["plans/factory/queue.md", "plans/factory/questions.md", "plans/factory/current.md", "plans/factory/lock"].includes(relative)) {
          throw new Error(`disabled protocol file was read: ${relative}`);
        }
        return files.read(args);
      },
      listPaths: (args) => files.listPaths(args),
    };
    const reader = new RepositoryProtocolReader(protocolFiles, {
      tasksIntegration: "enabled",
      tasksClient: client,
      tasksLedger: store,
      tasksProjectLookup: async () => project,
      mergeReader: staticMergeReader({ gitCommit: "abcdef1", factoryAhead: 0, mainBehind: 0, taskCommits: [], safeFastForward: true }),
      now: () => new Date("2026-09-21T00:00:00Z"),
    });
    const snapshot = await reader.loadSnapshot(makeConfiguration());
    expect(snapshot.queue.map((entry) => entry.id)).toEqual(["FAC-1"]);
    expect(reads).toEqual(expect.arrayContaining(["plans/factory/foreman.md", "plans/factory/repo.md", "plans/README.md"]));
    expect(reads).not.toEqual(expect.arrayContaining(["plans/factory/queue.md", "plans/factory/questions.md", "plans/factory/current.md", "plans/factory/lock"]));
  });

  it("keeps the disabled reader projection byte-equivalent to the legacy reader", async () => {
    const files = new FakeFileSystem();
    files.seedProtocol();
    const protocolFiles: ProtocolFiles = {
      read: (args) => files.read(args),
      listPaths: (args) => files.listPaths(args),
    };
    const options = {
      mergeReader: staticMergeReader({ gitCommit: "abcdef1", factoryAhead: 0, mainBehind: 0, taskCommits: [], safeFastForward: true }),
      now: () => new Date("2026-09-21T00:00:00Z"),
    };
    const legacy = await new RepositoryProtocolReader(protocolFiles, options).loadSnapshot(makeConfiguration());
    const disabled = await new RepositoryProtocolReader(protocolFiles, { ...options, tasksIntegration: "disabled" }).loadSnapshot(makeConfiguration());
    expect(disabled).toEqual(legacy);
  });
});
