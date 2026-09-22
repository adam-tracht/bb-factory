import { afterEach, describe, expect, it } from "vitest";
import type { HostPreflight, ProviderStatus } from "../src/contracts.js";
import { PROTOCOL_PATHS } from "../src/protocol/paths.js";
import { digestText } from "../src/protocol/files.js";
import { createDispatchEngine } from "../src/dispatch/index.js";
import { selectProvider } from "../src/dispatch/preflight.js";
import { ensureTasksRunCard } from "../src/dispatch/tasks.js";
import { projectTasks } from "../src/tasks/migration.js";
import { schedulerTick, cronMatches } from "../src/schedule/index.js";
import { dispatchRunOccupiesSlot, QUARANTINE_ABANDONMENT_GRACE_MS, RECONCILIATION_GRACE_MS } from "../src/dispatch/types.js";
import type { DispatchContext } from "../src/dispatch/types.js";
import { deriveTasksContentRevision, type TasksClient, type TasksTask, type TasksTaskThread } from "../src/tasks/index.js";
import {
  CHECKOUT,
  FakeFileSystem,
  cleanupStorages,
  makeProtocolReader,
  makeRegistryEntry,
  makeSettings,
  makeStore,
  QUEUE_MD,
} from "./fakes.js";

afterEach(cleanupStorages);

type SpawnInput = Parameters<DispatchContext["sdk"]["threads"]["spawn"]>[0];

class FakeThreads {
  public threads = new Map<string, { id: string; status: string; prompt?: string; providerId?: string }>();
  public stopped: string[] = [];
  public retried: string[] = [];
  public spawnError: Error | null = null;
  public stopError: Error | null = null;
  public retryError: Error | null = null;
  public spawnCalls: SpawnInput[] = [];
  /** Returned on spawn results, mirroring bb's auto-registered environment id. */
  public spawnedEnvironmentId: string | null = null;
  private counter = 0;

  async spawn(input: SpawnInput) {
    if (this.spawnError) throw this.spawnError;
    this.counter += 1;
    const id = `thread-${this.counter}`;
    this.spawnCalls.push(input);
    this.threads.set(id, { id, status: "active", prompt: input.prompt, providerId: input.providerId });
    return { id, environmentId: this.spawnedEnvironmentId };
  }

  async get({ threadId }: { threadId: string }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no such thread: ${threadId}`);
    return thread;
  }

  async stop({ threadId }: { threadId: string }) {
    if (this.stopError) throw this.stopError;
    this.stopped.push(threadId);
    const thread = this.threads.get(threadId);
    if (thread) thread.status = "idle";
  }

  async retry({ threadId }: { threadId: string }) {
    if (this.retryError) throw this.retryError;
    this.retried.push(threadId);
    const thread = this.threads.get(threadId);
    if (thread) thread.status = "active";
  }
}

function provider(
  id: string,
  availability: ProviderStatus["availability"] = "available",
  permissionModes?: ProviderStatus["permissionModes"],
): ProviderStatus {
  return {
    providerId: id,
    model: `${id}-model`,
    reasoningLevel: "high",
    availability,
    limitedUntil: null,
    activeThreadCount: 0,
    lastError: null,
    ...(permissionModes === undefined ? {} : { permissionModes }),
  };
}

const OK_PREFLIGHT: HostPreflight = {
  hostId: "host-1",
  status: "online",
  checkoutExists: true,
  branch: "factory",
  requiredTools: { git: true },
  browserAvailable: null,
  dbtStudioAvailable: null,
  ok: true,
  reasons: [],
};

interface HarnessOptions {
  now?: Date;
  settings?: Parameters<typeof makeSettings>[0];
  providers?: ProviderStatus[];
  preflight?: HostPreflight;
  entry?: ReturnType<typeof makeRegistryEntry>;
}

function makeHarness(options: HarnessOptions = {}) {
  const files = new FakeFileSystem();
  files.seedProtocol();
  const store = makeStore();
  const threads = new FakeThreads();
  const clock = { value: options.now ?? new Date("2026-09-10T02:00:00") };
  const providers = options.providers ?? [provider("codex"), provider("claude-code")];
  const entry = options.entry ?? makeRegistryEntry();
  const ctx: DispatchContext = {
    sdk: { threads: threads as never, files: files as never },
    store,
    protocolReader: makeProtocolReader(files),
    healthReader: {
      listProviderStatus: async () => providers,
      getHostPreflight: async () => options.preflight ?? OK_PREFLIGHT,
    },
    repositoryLookup: (key) => (key === "monorepo" ? entry : null),
    settings: makeSettings(options.settings),
    now: () => clock.value,
  };
  const engine = createDispatchEngine(ctx, () => ["monorepo"]);
  return { files, store, threads, clock, ctx, engine, providers, entry };
}

function makeMultiRepositoryHarness(options: HarnessOptions = {}) {
  const harness = makeHarness(options);
  const otherEntry = {
    ...makeRegistryEntry(),
    projectId: "project-other",
    configuration: {
      ...makeRegistryEntry().configuration,
      repositoryKey: "other",
      repositoryRoot: "/repo-other",
      checkoutPath: "/repo-other",
    },
  };
  for (const [path, content] of [
    ["plans/factory/foreman.md", "# Foreman\n"],
    ["plans/factory/repo.md", "# Repo\n"],
    ["plans/factory/current.md", "# Current\n\nstate: no-op\n"],
    ["plans/factory/questions.md", "# Questions\n"],
    ["plans/factory/queue.md", "# Queue\n"],
    ["plans/README.md", "# Dashboard\n\n| id | work item | status | next action | evidence and canonical detail |\n|---|---|---|---|---|\n| T1 | Sample task | open | run | queue |\n"],
  ] as const) harness.files.seed(path, content, "/repo-other");
  const entries = new Map([["monorepo", makeRegistryEntry()], ["other", otherEntry]]);
  const ctx: DispatchContext = {
    ...harness.ctx,
    repositoryLookup: (key) => entries.get(key as "monorepo" | "other") ?? null,
    settings: makeSettings({
      ...harness.ctx.settings,
      repositoryRegistry: { repositories: [...entries.values()], defaultRepositoryKey: "monorepo" },
    }),
  };
  return {
    ...harness,
    ctx,
    engine: createDispatchEngine(ctx, () => ["monorepo", "other"]),
    otherEntry,
  };
}

function seedRunRecord(
  files: FakeFileSystem,
  clock: { value: Date },
  threadId: string,
  state: "success" | "blocked" | "failed-safe" | "no-op",
  at = new Date(clock.value.getTime() + 1_000),
  format: "compact" | "dashed" | "legacy-dashed" = "compact",
): void {
  const iso = at.toISOString();
  const stamp = format === "compact"
    ? iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")
    : format === "dashed"
      ? iso
      : iso.replace(/T/gu, "-").replace(/:/gu, "").replace(/\.\d{3}Z$/u, "");
  files.seed(`plans/factory/runs/${stamp}-${threadId}.md`, `# Run\n\nstate: ${state}\n`);
}

function advancePastReconciliation(clock: { value: Date }): void {
  clock.value = new Date(clock.value.getTime() + RECONCILIATION_GRACE_MS + 1);
}

async function yieldToDispatch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const MANUAL_REQUEST = {
  repositoryKey: "monorepo" as const,
  trigger: "manual" as const,
  idempotencyKey: "bbf:v1:monorepo:run-now:823e4567-e89b-42d3-a456-426614174000" as never,
};

describe("dispatch engine", () => {
  interface TasksClientOptions {
    readonly taskStatus?: TasksTask["status"];
    readonly liveStatus?: TasksTaskThread["liveStatus"];
    readonly taskThreads?: readonly TasksTaskThread[];
    readonly onGetTask?: () => void;
    readonly updateTaskFailures?: number;
  }

  function makeTasksClient(options: TasksClientOptions = {}) {
    const task = {
      id: "task-1",
      projectId: "tasks-project-1",
      key: "MONOREPO-1",
      title: "Sample task",
      status: options.taskStatus ?? "in_review",
      priority: "medium" as const,
      description: "Factory run card",
      dueDate: null,
      labelIds: [],
      parentTaskId: null,
      position: 0,
    };
    const calls = {
      createProject: [] as unknown[],
      createTask: [] as unknown[],
      updateTask: [] as unknown[],
    };
    let updateTaskFailuresRemaining = options.updateTaskFailures ?? 0;
    const client = {
      listProjects: async () => [],
      createProject: async (input: unknown) => {
        calls.createProject.push(input);
        return { id: "tasks-project-1", name: "Factory", prefix: "MONOREPO", color: "#123456", linkedBbProjectId: "project-1" };
      },
      listAllTasks: async () => [task],
      createTask: async (input: unknown) => {
        calls.createTask.push(input);
        return { ok: true as const, task };
      },
      updateTask: async (input: { taskId: string; status?: TasksTask["status"] }) => {
        calls.updateTask.push(input);
        if (updateTaskFailuresRemaining > 0) {
          updateTaskFailuresRemaining -= 1;
          return { ok: false as const, error: { code: "conflict", message: "Tasks card temporarily unavailable" } };
        }
        if (input.status !== undefined) task.status = input.status;
        return { ok: true as const, task };
      },
      getTask: async () => {
        options.onGetTask?.();
        return task;
      },
      getTaskByKey: async () => task,
      listTaskThreads: async () => options.taskThreads ?? [{
        threadId: "thread-1",
        presetName: "factory",
        title: task.title,
        liveStatus: options.liveStatus ?? "idle",
      }],
    } as unknown as TasksClient;
    return { client, calls, clientTask: task };
  }

  function makeTasksReady(harness: ReturnType<typeof makeHarness>): void {
    const queuePath = `${CHECKOUT}/plans/factory/queue.md`;
    const queue = harness.files.content("plans/factory/queue.md")!
      .replace("status: blocked-by: Q6", "status: ready")
      .replace("approved: none", "approved: task scope");
    harness.files.put(queuePath, queue);
    harness.files.put(`${CHECKOUT}/plans/factory/questions.md`, "# Questions\n");
  }

  async function reconcileTasksCase(options: TasksClientOptions = {}) {
    const harness = makeHarness();
    makeTasksReady(harness);
    const tasks = makeTasksClient(options);
    const before = (await harness.ctx.protocolReader.loadSnapshot(harness.entry.configuration)).revision;
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      protocolReader: {
        loadSnapshot: (configuration) => harness.ctx.protocolReader.loadSnapshot(configuration),
        loadRevision: async () => ({ ...before, gitCommit: "def5678" }),
      },
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174096" as never });
    if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
    const runId = result.result.runId!;
    harness.threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(detail.summary.status).toBe("reconciliation-required");
    expect(detail.lease?.runId).toBe(runId);
    expect(harness.store.getCurrentOwnership("monorepo")?.runId).toBe(runId);
    return { detail, harness, runId };
  }

  it("creates and maps a Tasks run card, then includes the self-attach protocol", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const tasks = makeTasksClient();
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: true, result: { status: "accepted" } });
    if (!result.ok) throw new Error("expected success");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(detail.summary.taskId).toBe("task-1");
    expect(detail.attempts[0]?.taskId).toBe("task-1");
    expect(tasks.calls.createProject).toHaveLength(0);
    expect(tasks.calls.createTask).toHaveLength(0);
    expect(harness.threads.spawnCalls[0]?.prompt).toContain("bb tasks attach MONOREPO-1");
    expect(harness.threads.spawnCalls[0]?.prompt).toContain("--status in_progress");
    expect(harness.threads.spawnCalls[0]?.prompt).toContain("--status in_review");
    expect(harness.threads.spawnCalls[0]?.prompt).toContain("Never set this card to done");
  });

  it("reuses an existing Tasks card carrying the run id instead of creating a second card", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const snapshot = await harness.ctx.protocolReader.loadSnapshot(harness.entry.configuration);
    const queueEntry = snapshot.queue.find((item) => item.id === "T1");
    if (!queueEntry) throw new Error("expected the ready queue entry");
    const runId = "run-reuse";
    let createdTask: TasksTask | null = null;
    let createCount = 0;
    const client = {
      listProjects: async () => [{
        id: "tasks-project-1",
        name: "Factory",
        prefix: "MONOREPO",
        color: "#123456",
        linkedBbProjectId: "project-1",
      }],
      listAllTasks: async () => createdTask === null ? [] : [createdTask],
      createTask: async (input: { projectId: string; title: string; description?: string }) => {
        createCount += 1;
        const task: TasksTask = {
          id: "task-reused",
          projectId: input.projectId,
          key: "MONOREPO-2",
          title: input.title,
          status: "todo",
          priority: "medium",
          description: input.description ?? null,
          dueDate: null,
          labelIds: [],
          parentTaskId: null,
          position: 0,
        };
        createdTask = task;
        return { ok: true as const, task };
      },
    } as unknown as TasksClient;
    const first = await ensureTasksRunCard(client, { repositoryKey: "monorepo", entry: harness.entry, queueEntry, runId });
    const second = await ensureTasksRunCard(client, { repositoryKey: "monorepo", entry: harness.entry, queueEntry, runId });
    expect(createCount).toBe(1);
    expect(second).toEqual(first);
  });

  it("settles Tasks runs only with terminal live status and a changed repository revision", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const tasks = makeTasksClient({ taskStatus: "todo" });
    harness.store.createTasksApproval({
      approvalId: "approval-task-1",
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "execute",
      contentRevision: deriveTasksContentRevision(tasks.clientTask),
      provenance: { source: "test" },
    });
    const before = (await harness.ctx.protocolReader.loadSnapshot(harness.entry.configuration)).revision;
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      protocolReader: {
        loadSnapshot: (configuration) => harness.ctx.protocolReader.loadSnapshot(configuration),
        loadRevision: async () => ({ ...before, gitCommit: "def5678" }),
      },
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174099" as never });
    if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
    harness.threads.threads.get("thread-1")!.status = "idle";
    tasks.clientTask.status = "in_review";
    await engine.reconcile("monorepo");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(detail.summary.status).toBe("completed");
    expect(detail.attempts[0]?.tasksLiveStatus).toBe("idle");
    expect(tasks.calls.updateTask).toContainEqual({ taskId: "task-1", status: "done" });
    const projection = await projectTasks(tasks.client, harness.store, {
      repositoryKey: "monorepo",
      project: { id: "tasks-project-1", name: "Factory", prefix: "MONOREPO", color: "#123456", linkedBbProjectId: "project-1" },
    });
    expect(projection.queue.find((entry) => entry.id === "MONOREPO-1")).toMatchObject({ status: { kind: "done" }, eligible: false });
  });

  it("does not settle a completed Tasks card when the repository revision is unchanged", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const tasks = makeTasksClient();
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174098" as never });
    if (!result.ok) throw new Error("expected success");
    harness.threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(detail.summary.status).toBe("reconciliation-required");
    expect(detail.attempts[0]?.tasksLiveStatus).toBe("idle");
  });

  it("retries a failed settlement card projection on the next reconciliation", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const tasks = makeTasksClient({ taskStatus: "todo", updateTaskFailures: 1 });
    harness.store.createTasksApproval({
      approvalId: "approval-task-retry",
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "execute",
      contentRevision: deriveTasksContentRevision(tasks.clientTask),
      provenance: { source: "test" },
    });
    const before = (await harness.ctx.protocolReader.loadSnapshot(harness.entry.configuration)).revision;
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      protocolReader: {
        loadSnapshot: (configuration) => harness.ctx.protocolReader.loadSnapshot(configuration),
        loadRevision: async () => ({ ...before, gitCommit: "def5678" }),
      },
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174097" as never });
    if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
    tasks.clientTask.status = "in_review";
    harness.threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    const pending = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(pending.summary.status).toBe("reconciliation-required");
    expect(tasks.clientTask.status).toBe("in_review");

    await engine.reconcile("monorepo");
    const settled = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(settled.summary.status).toBe("completed");
    expect(tasks.clientTask.status).toBe("done");
    expect(tasks.calls.updateTask).toEqual([
      { taskId: "task-1", status: "done" },
      { taskId: "task-1", status: "done" },
    ]);
  });

  it("keeps ownership in reconciliation when the attached Tasks thread is still working", async () => {
    await reconcileTasksCase({ liveStatus: "working" });
  });

  it("keeps ownership in reconciliation when the worker never attaches", async () => {
    await reconcileTasksCase({ taskThreads: [] });
  });

  it("keeps ownership in reconciliation when the Tasks card is not in review", async () => {
    await reconcileTasksCase({ taskStatus: "todo" });
  });

  it("keeps ownership in reconciliation when the lease changes between evidence reads", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    let runId: string | null = null;
    const tasks = makeTasksClient({
      onGetTask: () => {
        if (runId === null) throw new Error("expected a run id before reading Tasks evidence");
        harness.store.withTransaction((transaction) => {
          const currentRun = transaction.getRunSummary(runId!);
          const currentAttempt = transaction.getActiveAttempt(runId!);
          const currentLease = transaction.getLeaseForRun(runId!);
          if (!currentRun || !currentAttempt || !currentLease) throw new Error("expected current run generations");
          transaction.updateOwnershipLease({
            ...currentLease,
            expiresAt: new Date(harness.clock.value.getTime() + 120_000).toISOString(),
          });
        });
      },
    });
    const before = (await harness.ctx.protocolReader.loadSnapshot(harness.entry.configuration)).revision;
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      tasksClient: tasks.client,
      protocolReader: {
        loadSnapshot: (configuration) => harness.ctx.protocolReader.loadSnapshot(configuration),
        loadRevision: async () => ({ ...before, gitCommit: "def5678" }),
      },
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174097" as never });
    if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
    runId = result.result.runId!;
    harness.threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(detail.summary.status).toBe("reconciliation-required");
    expect(detail.lease?.status).toBe("reconciliation-required");
    expect(harness.store.getCurrentOwnership("monorepo")?.runId).toBe(runId);
  });

  it("refuses to dispatch while paused", async () => {
    const { engine, threads, store } = makeHarness({ settings: { dispatchMode: "paused" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "paused" } });
    expect(threads.threads.size).toBe(0);
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
  });

  it("pauses Tasks-integrated dispatch when the Tasks health check is degraded", async () => {
    const harness = makeHarness();
    const ctx: DispatchContext = {
      ...harness.ctx,
      tasksIntegration: "enabled",
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({
          enabled: true,
          status: "disabled-or-unavailable" as const,
          message: "Tasks is unavailable.",
        }),
      },
    };
    const engine = createDispatchEngine(ctx, () => ["monorepo"]);

    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({
      ok: false,
      error: { category: "paused", message: "Tasks dispatch is paused: Tasks is unavailable." },
    });
    expect(harness.threads.threads.size).toBe(0);
    expect(harness.store.listActiveRuns("monorepo")).toHaveLength(0);
  });

  it("starts a run: durable intent, lease, attempt, and spawned worker", async () => {
    const { engine, threads, store } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "run-now" } });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("started");
    expect(detail.run?.summary.providerId).toBe("codex");
    expect(detail.run?.summary.workerThreadId).toBe("thread-1");
    expect(detail.run?.lease?.status).toBe("held");
    expect(detail.run?.attempts).toHaveLength(1);
    expect(threads.threads.get("thread-1")?.prompt).toContain("foreman.md");
    expect(store.getDispatcherState("monorepo").lastStartProvider).toBe("codex");
  });

  it("starts eligible work without rejecting the canonical spawn generation", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const result = await harness.engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174042" as never,
    });
    expect(result).toMatchObject({ ok: true, result: { status: "accepted" } });
    if (!result.ok) throw new Error("expected success");
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run!;
    expect(detail.summary.status).toBe("started");
    expect(detail.summary.queueItemIds).toEqual(["T1"]);
    expect(harness.threads.threads.get("thread-1")?.status).toBe("active");
  });

  it("atomically enforces global capacity for concurrent manual starts", async () => {
    const { engine, store, threads } = makeMultiRepositoryHarness({ settings: { concurrencyLimit: 1 } });
    const [first, second] = await Promise.all([
      engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:823e4567-e89b-42d3-a456-426614174001" as never }),
      engine.requestRun({
        repositoryKey: "other",
        trigger: "manual",
        idempotencyKey: "bbf:v1:other:run-now:823e4567-e89b-42d3-a456-426614174002" as never,
      }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ error: { category: "conflict" } });
    expect(threads.spawnCalls).toHaveLength(1);
    expect(store.listActiveRuns("monorepo").length + store.listActiveRuns("other").length).toBe(1);
  });

  it("frees capacity after a terminal worker is observed while settlement is pending", async () => {
    const { engine, store, threads, clock } = makeMultiRepositoryHarness({ settings: { concurrencyLimit: 1 } });
    const first = await engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:823e4567-e89b-42d3-a456-426614174003" as never,
    });
    if (!first.ok) throw new Error("expected first dispatch to succeed");
    const runId = first.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";

    await engine.reconcile("monorepo");

    const pendingSettlement = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(pendingSettlement.summary.status).toBe("reconciliation-required");
    expect(pendingSettlement.summary.workerTerminalObservedAt).not.toBeNull();
    expect(dispatchRunOccupiesSlot(pendingSettlement.summary, clock.value.getTime())).toBe(false);

    const second = await engine.requestRun({
      repositoryKey: "other",
      trigger: "manual",
      idempotencyKey: "bbf:v1:other:run-now:823e4567-e89b-42d3-a456-426614174004" as never,
    });
    expect(second).toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(threads.spawnCalls).toHaveLength(2);
  });

  it("runs an explicit provider override with caller-explicit execution inputs", async () => {
    const { engine, threads, store } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun({
      ...MANUAL_REQUEST,
      providerOverride: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "xhigh" },
      serviceTier: "fast",
    });
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "run-now" } });
    if (!result.ok) throw new Error("expected success");
    const spawn = threads.spawnCalls[0]!;
    expect(spawn).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      },
    });
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! });
    expect(detail.run?.attempts[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: "xhigh",
    });
    expect(detail.run?.summary.providerId).toBe("claude-code");
  });

  it("rejects an override naming a provider that fails the usability check", async () => {
    const { engine, threads, store } = makeHarness({
      providers: [provider("codex"), provider("claude-code", "limited")],
    });
    const result = await engine.requestRun({
      ...MANUAL_REQUEST,
      providerOverride: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" },
    });
    expect(result).toMatchObject({ ok: false, error: { category: "provider-unavailable" } });
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("claude-code");
    expect(threads.threads.size).toBe(0);
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
  });

  it("rejects an override naming a provider absent from the live catalog", async () => {
    const { engine, threads } = makeHarness({ providers: [provider("codex")] });
    const result = await engine.requestRun({
      ...MANUAL_REQUEST,
      providerOverride: { providerId: "pi", model: "pi-model", reasoningLevel: "high" },
    });
    expect(result).toMatchObject({ ok: false, error: { category: "provider-unavailable" } });
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("pi");
    expect(threads.threads.size).toBe(0);
  });

  it("keeps the rotation spawn untouched when run-now carries no override", async () => {
    const { engine, threads } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    const spawn = threads.spawnCalls[0]!;
    expect(spawn.providerId).toBe("codex");
    expect("executionInputSources" in spawn).toBe(false);
    expect("serviceTier" in spawn).toBe(false);
  });

  it("marks a lone serviceTier explicit while provider selection still applies", async () => {
    const { engine, threads } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun({ ...MANUAL_REQUEST, serviceTier: "fast" });
    expect(result.ok).toBe(true);
    const spawn = threads.spawnCalls[0]!;
    expect(spawn.providerId).toBe("codex");
    expect(spawn.serviceTier).toBe("fast");
    expect(spawn.executionInputSources).toEqual({ serviceTier: "explicit" });
  });

  it("uses the display name only for the worker thread title", async () => {
    const { engine, threads, store } = makeHarness({
      entry: { ...makeRegistryEntry(), displayName: "Core repo" },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    const detail = await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! });
    expect(threads.spawnCalls[0]?.title).toBe(`factory foreman: Core repo ${detail.run?.summary.providerId}`);
    expect(detail.run?.summary.repositoryKey).toBe("monorepo");
  });

  it("starts a run on a pinned non-factory provider", async () => {
    const { engine, store } = makeHarness({
      settings: { providerPreference: "acp-opencode" },
      providers: [provider("codex"), provider("acp-opencode")],
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const detail = await makeHarnessResult(result.result.runId!, store);
    expect(detail.run?.summary.providerId).toBe("acp-opencode");
  });

  it("reuses the pinned environment when the registry entry carries one", async () => {
    const { engine, threads, store } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(threads.spawnCalls[0]?.environment).toEqual({ type: "reuse", environmentId: "environment-1" });
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! });
    expect(detail.run?.summary.environmentId).toBe("environment-1");
  });

  it("spawns an unmanaged host workspace and records the returned environment id", async () => {
    const { engine, threads, store } = makeHarness({
      entry: { ...makeRegistryEntry(), environmentId: undefined },
    });
    threads.spawnedEnvironmentId = "env-auto-1";
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(threads.spawnCalls[0]?.environment).toEqual({
      type: "host",
      hostId: "host-1",
      workspace: {
        type: "unmanaged",
        path: CHECKOUT,
        branch: { kind: "existing", name: "factory" },
      },
    });
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! });
    expect(detail.run?.summary.status).toBe("started");
    expect(detail.run?.summary.environmentId).toBe("env-auto-1");
  });

  it("records a null environment id when an unmanaged spawn fails ambiguously", async () => {
    const harness = makeHarness({ entry: { ...makeRegistryEntry(), environmentId: undefined } });
    harness.threads.spawnError = new Error("connection reset during spawn");
    const result = await harness.engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    const runs = harness.store.listActiveRuns("monorepo");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("reconciliation-required");
    expect(runs[0]!.environmentId).toBeNull();
    const detail = await harness.store.getRun({ repositoryKey: "monorepo", runId: runs[0]!.runId });
    expect(detail.run?.summary.environmentId).toBeNull();
  });

  it("rejects a second run while one holds ownership", async () => {
    const { engine } = makeHarness();
    const first = await engine.requestRun(MANUAL_REQUEST);
    expect(first.ok).toBe(true);
    const second = await engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174000",
    });
    expect(second).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("replays the recorded run for the same idempotency key", async () => {
    const { engine, threads } = makeHarness();
    await engine.requestRun(MANUAL_REQUEST);
    const second = await engine.requestRun(MANUAL_REQUEST);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.status).toBe("already-applied");
    expect(threads.threads.size).toBe(1);
  });

  it("falls back to the first usable provider when the pinned lead is limited", async () => {
    const { engine, store } = makeHarness({
      settings: { providerPreference: "codex" },
      providers: [provider("codex"), provider("acp-opencode"), provider("claude-code")],
    });
    const state = store.getDispatcherState("monorepo");
    store.saveDispatcherState({
      ...state,
      limits: { codex: Math.floor(Date.parse("2026-09-10T08:00:00Z") / 1000) },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const detail = await makeHarnessResult(result.result.runId!, store);
      expect(detail.run?.summary.providerId).toBe("acp-opencode");
    }
  });

  it("rotates alternate dispatch across three usable providers in catalog order", () => {
    const providers = [provider("codex"), provider("acp-opencode"), provider("acp-devin")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const first = selectProvider(providers, state, "alternate", state.nightKey, 0);
    const second = selectProvider(providers, { ...state, lastStartProvider: first!.providerId }, "alternate", state.nightKey, 0);
    const third = selectProvider(providers, { ...state, lastStartProvider: second!.providerId }, "alternate", state.nightKey, 0);
    const fourth = selectProvider(providers, { ...state, lastStartProvider: third!.providerId }, "alternate", state.nightKey, 0);
    expect([first?.providerId, second?.providerId, third?.providerId, fourth?.providerId]).toEqual([
      "acp-opencode",
      "acp-devin",
      "codex",
      "acp-opencode",
    ]);
    expect(first?.reason).toBe("alternate after codex");
  });

  it("rotates alternate past an unusable previous provider in catalog order", () => {
    const providers = [
      provider("acp-devin"),
      provider("codex", "unavailable"),
      provider("acp-opencode"),
    ];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const picked = selectProvider(providers, state, "alternate", state.nightKey, 0);
    expect(picked?.providerId).toBe("acp-opencode");
    expect(picked?.reason).toBe("alternate after codex");
  });

  it("applies a configured model default to the pinned provider and notes it in the reason", () => {
    const providers = [provider("codex"), provider("claude-code")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "",
      limits: {},
    };
    const picked = selectProvider(providers, state, "codex", state.nightKey, 0, {
      codex: { model: "gpt-5-codex", reasoningLevel: "low" },
    });
    expect(picked).toEqual({
      providerId: "codex",
      model: "gpt-5-codex",
      reasoningLevel: "low",
      reason: "providerPreference=codex + configured default",
    });
  });

  it("applies a configured default during alternate rotation", () => {
    const providers = [provider("codex"), provider("acp-opencode")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const picked = selectProvider(providers, state, "alternate", state.nightKey, 0, {
      "acp-opencode": { model: "opencode-big", reasoningLevel: "max" },
    });
    expect(picked?.providerId).toBe("acp-opencode");
    expect(picked?.model).toBe("opencode-big");
    expect(picked?.reasoningLevel).toBe("max");
    expect(picked?.reason).toBe("alternate after codex + configured default");
  });

  it("advances through a configured rotation in list order and wraps around", () => {
    const providers = [provider("codex"), provider("acp-opencode"), provider("acp-devin")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const rotation = ["codex", "acp-devin"];
    // acp-opencode sits between them in the catalog but is outside the list.
    const first = selectProvider(providers, state, "alternate", state.nightKey, 0, undefined, rotation);
    const second = selectProvider(providers, { ...state, lastStartProvider: first!.providerId }, "alternate", state.nightKey, 0, undefined, rotation);
    expect([first?.providerId, second?.providerId]).toEqual(["acp-devin", "codex"]);
    expect(first?.reason).toBe("rotation after codex");
  });

  it("starts a configured rotation at the head when the last provider is not a member", () => {
    const providers = [provider("codex"), provider("acp-devin")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "acp-opencode",
      limits: {},
    };
    const picked = selectProvider(providers, state, "alternate", state.nightKey, 0, undefined, ["codex", "acp-devin"]);
    expect(picked?.providerId).toBe("codex");
  });

  it("skips unusable and unreported members while holding their slots", () => {
    const providers = [provider("codex"), provider("acp-devin", "unavailable"), provider("acp-opencode")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    // acp-devin unusable and ghost-provider unreported: both are skipped.
    const picked = selectProvider(
      providers,
      state,
      "alternate",
      state.nightKey,
      0,
      undefined,
      ["codex", "acp-devin", "ghost-provider", "acp-opencode"],
    );
    expect(picked?.providerId).toBe("acp-opencode");
    expect(picked?.reason).toBe("rotation after codex");
  });

  it("falls back to a usable provider outside the list when every rotation member is unusable", () => {
    const providers = [provider("codex", "unavailable"), provider("acp-devin", "unavailable"), provider("acp-opencode")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const picked = selectProvider(providers, state, "alternate", state.nightKey, 0, undefined, ["codex", "acp-devin"]);
    expect(picked?.providerId).toBe("acp-opencode");
    expect(picked?.reason).toBe("rotation exhausted, fallback");
  });

  it("applies a configured default to a rotation member and notes it in the reason", () => {
    const providers = [provider("codex"), provider("acp-devin")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "codex",
      limits: {},
    };
    const picked = selectProvider(providers, state, "alternate", state.nightKey, 0, {
      "acp-devin": { model: "devin-large", reasoningLevel: "max" },
    }, ["codex", "acp-devin"]);
    expect(picked).toEqual({
      providerId: "acp-devin",
      model: "devin-large",
      reasoningLevel: "max",
      reason: "rotation after codex + configured default",
    });
  });

  it("dispatches through the configured rotation from settings", async () => {
    const { engine, threads } = makeHarness({
      settings: { providerPreference: "alternate", providerRotation: ["claude-code", "codex"] },
      providers: [provider("codex"), provider("claude-code")],
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    // No last start on record: the run takes the list head, not the catalog head.
    expect(result.result.message).toContain("claude-code");
    expect(threads.spawnCalls[0]).toMatchObject({ providerId: "claude-code" });
  });

  it("never resurrects an unusable provider through a configured default", () => {
    const providers = [provider("codex", "unavailable"), provider("claude-code")];
    const state = {
      repositoryKey: "monorepo" as const,
      nightKey: "2026-09-10",
      lastState: "",
      failedCount: 0,
      noopCount: 0,
      lastStartAt: 0,
      lastStartProvider: "",
      limits: {},
    };
    const picked = selectProvider(providers, state, "codex", state.nightKey, 0, {
      codex: { model: "gpt-5-codex", reasoningLevel: "high" },
    });
    expect(picked?.providerId).toBe("claude-code");
    expect(picked?.model).toBe("claude-code-model");
    expect(picked?.reason).toBe("fallback, codex unusable");
  });

  it("persists the configured model and thinking level on the dispatch attempt", async () => {
    const { engine, threads, store } = makeHarness({
      settings: {
        providerPreference: "codex",
        providerModelDefaults: { codex: { model: "gpt-5-codex", reasoningLevel: "xhigh" } },
      },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.message).toContain("codex (providerPreference=codex + configured default)");
    const spawn = threads.spawnCalls[0]!;
    expect(spawn).toMatchObject({ providerId: "codex", model: "gpt-5-codex", reasoningLevel: "xhigh" });
    // A configured default is not a caller-explicit input; bb may still derive.
    expect("executionInputSources" in spawn).toBe(false);
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! });
    expect(detail.run?.attempts[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5-codex",
      reasoningLevel: "xhigh",
    });
  });

  it("leaves the manual run-now override untouched by configured defaults", async () => {
    const { engine, threads } = makeHarness({
      settings: {
        providerModelDefaults: { "claude-code": { model: "claude-haiku", reasoningLevel: "low" } },
      },
    });
    const result = await engine.requestRun({
      ...MANUAL_REQUEST,
      providerOverride: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "xhigh" },
    });
    expect(result.ok).toBe(true);
    expect(threads.spawnCalls[0]).toMatchObject({ model: "claude-opus-5", reasoningLevel: "xhigh" });
  });

  it("skips a provider without full permission support", async () => {
    const { engine, store } = makeHarness({
      settings: { providerPreference: "acp-opencode" },
      providers: [provider("acp-opencode", "available", ["auto"]), provider("codex", "available", ["full"])],
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const detail = await makeHarnessResult(result.result.runId!, store);
    expect(detail.run?.summary.providerId).toBe("codex");
  });

  it("refuses dispatch when no provider is usable", async () => {
    const { engine } = makeHarness({
      providers: [provider("codex", "unavailable"), provider("claude-code", "unavailable")],
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "provider-unavailable" } });
  });

  it("fails the preflight when the host is offline", async () => {
    const { engine } = makeHarness({
      preflight: { ...OK_PREFLIGHT, ok: false, status: "offline", reasons: ["host offline"] },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "host-unavailable" } });
  });

  it("completes a run when the worker wrote a fresh terminal state", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const startedAt = clock.value.getTime();
    threads.threads.get("thread-1")!.status = "idle";
    files.put(
      `${CHECKOUT}/${PROTOCOL_PATHS.current}`,
      "# Latest run\n\nstate: success\n",
      startedAt + 60_000,
    );
    seedRunRecord(files, clock, "thread-1", "success");
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("completed");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    expect(store.getDispatcherState("monorepo").lastState).toBe("success");
  });

  it("persists the post-run commit with digests from the same evidence snapshot", async () => {
    const harness = makeHarness();
    const { engine, threads, store, files, clock, ctx } = harness;
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174023" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const before = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.summary.repositoryRevision;
    const currentContent = "# Latest run\n\nstate: success\n";
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, currentContent, clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success");
    const originalReader = ctx.protocolReader;
    const postRunRevision = { ...before, gitCommit: "def5678" };
    Object.assign(ctx, {
      protocolReader: {
        ...originalReader,
        loadRevision: async () => postRunRevision,
      },
    });

    await engine.reconcile("monorepo");
    const finalRevision = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.summary.repositoryRevision;
    expect(finalRevision.gitCommit).toBe("def5678");
    expect(finalRevision.fileDigests[PROTOCOL_PATHS.current]).toBe(digestText(currentContent));
    expect(finalRevision.protocolDigest).toBe(digestText(
      Object.entries(finalRevision.fileDigests)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, sha256]) => `${path}\0${sha256}`)
        .join("\n"),
    ));
  });

  it.each([
    ["blocked", "blocked", "compact"],
    ["failed-safe", "failed-safe", "dashed"],
    ["no-op", "no-op", "legacy-dashed"],
  ] as const)("settles a correlated %s outcome", async (state, expected, format) => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: `bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-42661417400${state === "blocked" ? "1" : state === "failed-safe" ? "2" : "3"}` as never,
    });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, `# Latest run\n\nstate: ${state}\n`, clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", state, new Date(clock.value.getTime() + 1_000), format);

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe(expected);
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("accepts a dashed UTC record filename", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174004" as never });
    if (!result.ok) throw new Error("expected success");
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success", clock.value, "dashed");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run?.summary.status).toBe("completed");
  });

  it("rejects current.md freshness within the same filesystem second", async () => {
    const { engine, threads, store, files, clock } = makeHarness({ now: new Date("2026-09-10T02:00:00.500Z") });
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174017" as never });
    if (!result.ok) throw new Error("expected success");
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", new Date("2026-09-10T02:00:00.100Z").getTime());
    seedRunRecord(files, clock, "thread-1", "success", new Date(clock.value.getTime() + 2_000));

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run?.summary.status).toBe("reconciliation-required");
  });

  it("correlates immutable evidence across midnight", async () => {
    const { engine, threads, store, files, clock } = makeHarness({ now: new Date("2026-09-10T23:59:59.500Z") });
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174018" as never });
    if (!result.ok) throw new Error("expected success");
    threads.threads.get("thread-1")!.status = "idle";
    const finishedAt = new Date("2026-09-11T00:00:01Z");
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, `# Latest run\nRun ${finishedAt.toISOString()}\nstate: success\n`, finishedAt.getTime());
    seedRunRecord(files, clock, "thread-1", "success", finishedAt, "dashed");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run?.summary.status).toBe("completed");
  });

  it("uses a bounded worker-targeted lookup for untimestamped current.md and more than 64 same-day records", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174019" as never });
    if (!result.ok) throw new Error("expected success");
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    for (let index = 0; index < 64; index += 1) {
      files.seed(`plans/factory/runs/20260910T020000Z-history-${index}.md`, "# Old run\n\nstate: success\n");
    }
    seedRunRecord(files, clock, "thread-1", "success", new Date(clock.value.getTime() + 3_000));

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run?.summary.status).toBe("completed");
  });

  it("rejects a malformed present immutable filename instead of treating it as absent", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174020" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    files.seed("plans/factory/runs/20260910T020000-thread-1.md", "# Run\n\nstate: success\n");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("filename");
  });

  it("does not treat a date-only descriptive record as attributable evidence", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174022" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    files.seed("plans/factory/runs/2026-09-10-thread-1.md", "# Run\n\nstate: success\n");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("filename");
  });

  it("does not let an errored worker turn an evidence-read outage into dead-start", async () => {
    const { engine, threads, store, files } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174021" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    const read = files.read.bind(files);
    files.read = async (args) => {
      if (args.path.endsWith(`/${PROTOCOL_PATHS.current}`)) throw new Error("current.md read outage");
      return read(args);
    };

    await engine.reconcile("monorepo");
    expect(store.getReconciliation(runId)?.reasonCode).not.toMatch(/^dead-start:/u);
  });

  it("keeps a present current.md with missing mtime retryable even when its state is malformed", async () => {
    const { engine, threads, store, files } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174034" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\nstate: partial\n");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("mtime is unavailable");
    expect(store.getReconciliation(runId)?.reasonCode).not.toContain("malformed");
  });

  it("holds a mismatched terminal record for correction, then finalizes once correlated evidence arrives", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-2", "success");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("worker");

    seedRunRecord(files, clock, "thread-1", "success", new Date(clock.value.getTime() + 2_000));
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("completed");
    expect(store.getReconciliation(runId)?.resolution).toBe("completed");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    const state = store.getDispatcherState("monorepo");
    await engine.reconcile("monorepo");
    expect(store.getDispatcherState("monorepo")).toEqual(state);
  });

  it("does not reopen a terminal run from stale reconciliation detail", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174013" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    let transitioned = false;
    const read = files.read.bind(files);
    files.read = async (args) => {
      const response = await read(args);
      if (!transitioned && args.path.endsWith(`/${PROTOCOL_PATHS.current}`)) {
        transitioned = true;
        const detail = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
        store.updateRunDispatch({
          repositoryKey: "monorepo",
          runId,
          status: "completed",
          startedAt: detail.summary.startedAt,
          finishedAt: clock.value.toISOString(),
          providerId: detail.summary.providerId!,
          workerThreadId: detail.summary.workerThreadId!,
          projectId: detail.summary.projectId!,
          environmentId: detail.summary.environmentId,
          repositoryRevision: detail.summary.repositoryRevision,
        });
      }
      return response;
    };

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("completed");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("retains the final malformed protocol line as bounded reconciliation diagnostics", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: partial\n", clock.value.getTime() + 60_000);

    await engine.reconcile("monorepo");
    expect(store.getReconciliation(runId)).toMatchObject({
      rawObservation: "state: partial",
      detectionCount: 1,
    });
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
  });

  it("rejects stale current state even when the immutable record matches", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174005" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() - 1);
    seedRunRecord(files, clock, "thread-1", "success");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("filesystem-second precision");
  });

  it("does not release an unrelated lease during deadline settlement", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174006" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const leaseId = store.getLeaseForRun(runId)!.leaseId;
    const otherIntent = {
      runId: "run-unrelated-lease",
      repositoryKey: "monorepo" as const,
      trigger: "recovery" as const,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174007" as never,
      requestedAt: new Date(clock.value.getTime() + 60 * 60 * 1000).toISOString(),
      baseRevision: { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} },
      queueItemIds: [],
      authorizationProvenance: [],
    };
    store.createRunIntent({ intent: otherIntent });
    store.db.prepare(`UPDATE ownership_leases SET run_id = ? WHERE lease_id = ?`).run(otherIntent.runId, leaseId);
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success");

    await engine.reconcile("monorepo");
    const metadata = store.getReconciliation(runId)!;
    clock.value = new Date(Date.parse(metadata.deadlineAt) + 1);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getCurrentOwnership("monorepo")).toMatchObject({ runId: otherIntent.runId, status: "held" });
  });

  it("rejects a terminal worker when its active attempt belongs to another thread", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174008" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    store.db.prepare(`UPDATE dispatch_attempts SET worker_thread_id = ? WHERE run_id = ?`).run("thread-2", runId);
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("active attempt");
  });

  it("settles legacy failed-safe evidence without mistaking an older record for this run", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174009" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: failed-safe\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "older-worker", "success", new Date(clock.value.getTime() - 60_000));

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("checks fresh wrong-worker evidence before the legacy failed-safe shortcut", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174011" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\nRun 2026-09-10T02:00:00Z\nstate: failed-safe\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-2", "failed-safe");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("different worker");
  });

  it("rejects an older matching record when a newer immutable record belongs to another worker", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174030" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    const matchingAt = new Date(clock.value.getTime() + 1_000);
    const foreignAt = new Date(clock.value.getTime() + 2_000);
    files.put(
      `${CHECKOUT}/${PROTOCOL_PATHS.current}`,
      `# Latest run\nRun ${matchingAt.toISOString()}\nstate: success\n`,
      clock.value.getTime() + 60_000,
    );
    seedRunRecord(files, clock, "thread-1", "success", matchingAt);
    seedRunRecord(files, clock, "thread-2", "success", foreignAt);

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("latest immutable run record");
  });

  it("does not settle a live worker when the deadline stop request fails", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174010" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: partial\n", clock.value.getTime() + 60_000);
    await engine.reconcile("monorepo");
    const metadata = store.getReconciliation(runId)!;
    threads.threads.get("thread-1")!.status = "active";
    threads.stopError = new Error("stop transport unavailable");
    clock.value = new Date(Date.parse(metadata.deadlineAt) + 1);

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
    threads.stopError = null;
    threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("does not extend the reconciliation deadline when the worker cannot be read", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.delete("thread-1");

    await engine.reconcile("monorepo");
    const first = store.getReconciliation(runId);
    expect(first).not.toBeNull();
    clock.value = new Date(clock.value.getTime() + RECONCILIATION_GRACE_MS / 2);
    await engine.reconcile("monorepo");
    const second = store.getReconciliation(runId);
    expect(second?.deadlineAt).toBe(first?.deadlineAt);
    expect(second?.detectionCount).toBeGreaterThan(first?.detectionCount ?? 0);

    clock.value = new Date(Date.parse(first!.deadlineAt) + 1);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
    threads.threads.set("thread-1", { id: "thread-1", status: "idle" });
    await engine.reconcile("monorepo");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("settles with more than 1000 historical records by targeted lookup", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174014" as never });
    if (!result.ok) throw new Error("expected success");
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\nRun 2026-09-10T02:00:00Z\nstate: success\n", clock.value.getTime() + 60_000);
    for (let index = 0; index < 1001; index += 1) {
      files.seed(`plans/factory/runs/2020-01-01T000000Z-history-${index}.md`, "# Old run\nstate: success\n");
    }
    seedRunRecord(files, clock, "thread-1", "success");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: result.result.runId! })).run?.summary.status).toBe("completed");
  });

  it("does not finalize a stale reconciliation pass over a retry generation", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174015" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    const originalGetRun = store.getRun.bind(store);
    let injected = false;
    store.getRun = async (input) => {
      const projection = await originalGetRun(input);
      if (!injected && projection.run?.summary.status === "started") {
        injected = true;
        const stale = projection.run;
        const oldAttempt = stale.attempts[0]!;
        store.updateDispatchAttempt({ ...oldAttempt, status: "failed-safe", finishedAt: clock.value.toISOString() });
        store.updateRunDispatch({
          repositoryKey: runId === stale.summary.runId ? "monorepo" : stale.summary.repositoryKey,
          runId: stale.summary.runId,
          status: "failed-safe",
          startedAt: stale.summary.startedAt,
          finishedAt: clock.value.toISOString(),
          providerId: stale.summary.providerId!,
          workerThreadId: stale.summary.workerThreadId!,
          projectId: stale.summary.projectId!,
          environmentId: stale.summary.environmentId,
          repositoryRevision: stale.summary.repositoryRevision,
        });
        const releasedLease = store.getLeaseForRun(runId);
        if (!releasedLease) throw new Error("expected a lease");
        store.updateOwnershipLease({ ...releasedLease, status: "released" });
        const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId: oldAttempt.attemptId });
        expect(retried.ok).toBe(true);
        threads.threads.get("thread-1")!.status = "idle";
      }
      return projection;
    };
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest\nRun 2026-09-10T02:00:00Z\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success");

    await engine.reconcile("monorepo");
    const detail = await originalGetRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("started");
    expect(detail.run?.attempts.at(-1)?.status).toBe("started");
  });

  it("uses the newest attempt start and second precision for evidence freshness", async () => {
    const { engine, threads, store, files, clock } = makeHarness({ now: new Date("2026-09-10T02:00:00.500Z") });
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174016" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;
    clock.value = new Date("2026-09-10T02:00:01.500Z");
    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried.ok).toBe(true);
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest\nRun 2026-09-10T02:00:00Z\nstate: success\n", clock.value.getTime() + 60_000);
    seedRunRecord(files, clock, "thread-1", "success", new Date("2026-09-10T02:00:00.900Z"));
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
  });

  it("rejects second-precision evidence that predates a subsecond attempt in the same filesystem second", async () => {
    const { engine, threads, store, files } = makeHarness({ now: new Date("2026-09-10T02:00:00.500Z") });
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174031" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(
      `${CHECKOUT}/${PROTOCOL_PATHS.current}`,
      "# Latest\nRun 2026-09-10T02:00:00Z\nstate: success\n",
      new Date("2026-09-10T02:01:00Z").getTime(),
    );
    seedRunRecord(files, { value: new Date("2026-09-10T02:00:00.500Z") }, "thread-1", "success", new Date("2026-09-10T02:00:00Z"));

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("immutable");
  });

  it("marks a dead start failed-safe and limits the provider", async () => {
    const { engine, threads, store, files, clock } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    // A dead-start classification requires readable, fresh protocol state that
    // is not attributable to a terminal immutable record. Missing mtime is a
    // retryable evidence outage and must not be promoted to dead-start.
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\n\nstate: no-op\n", clock.value.getTime() + 60_000);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    const state = store.getDispatcherState("monorepo");
    expect(state.lastState).toBe("dead-start");
    expect(state.failedCount).toBe(0);
    expect(state.limits["codex"] ?? 0).toBeGreaterThan(0);
    expect(store.getReconciliation(runId)?.reasonCode).toMatch(/^dead-start:/u);
    expect(store.getReconciliation(runId)?.resolutionReason).toBe("dead-start");
  });

  it("stops an expired run via the runtime cap without limiting the provider", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    clock.value = new Date(2026, 8, 10, 6, 0);
    threads.threads.get("thread-1")!.status = "active";
    await engine.reconcile("monorepo");
    expect(threads.stopped).toEqual(["thread-1"]);
    let detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("cancel-requested");
    await engine.reconcile("monorepo");
    detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("no-op");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    expect(store.getDispatcherState("monorepo").limits["codex"] ?? 0).toBe(0);
  });

  it("marks an ambiguous spawn for reconciliation", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    const result = await harness.engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    const runs = harness.store.listActiveRuns("monorepo");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("reconciliation-required");
    await harness.engine.reconcile("monorepo");
    const detail = await harness.store.getRun({ repositoryKey: "monorepo", runId: runs[0]!.runId });
    expect(detail.run?.summary.status).toBe("reconciliation-required");
    advancePastReconciliation(harness.clock);
    await harness.engine.reconcile("monorepo");
    expect((await harness.store.getRun({ repositoryKey: "monorepo", runId: runs[0]!.runId })).run?.summary.status).toBe("failed-safe");
    expect(harness.store.getLeaseForRun(runs[0]!.runId)?.status).toBe("reconciliation-required");
  });

  it("ignores delayed spawn success after the pending generation is terminalized", async () => {
    const harness = makeHarness();
    makeTasksReady(harness);
    const originalSpawn = harness.threads.spawn.bind(harness.threads);
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    harness.threads.spawn = async (input) => {
      const spawned = await originalSpawn(input);
      await spawnGate;
      return spawned;
    };

    const pending = harness.engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174023" as never });
    await yieldToDispatch();
    const runId = harness.store.listActiveRuns("monorepo")[0]!.runId;
    const duplicate = await harness.engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174041" as never,
    });
    expect(duplicate).toMatchObject({ ok: false, error: { category: "conflict" } });
    const stopped = await harness.engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: true, result: { status: "accepted" } });
    releaseSpawn();

    expect(await pending).toMatchObject({ ok: false, error: { category: "conflict" } });
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(detail.summary.status).toBe("no-op");
    expect(detail.attempts[0]?.status).toBe("no-op");
    expect(harness.store.getDispatcherState("monorepo").noopCount).toBe(1);
    expect(harness.threads.stopped).toEqual(["thread-1"]);
    expect(harness.threads.threads.get("thread-1")?.status).toBe("idle");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(harness.store.getLeaseForRun(runId)?.workerThreadId).toBe("thread-1");
    await harness.engine.reconcile("monorepo");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("releases a terminal no-op lease with no possible worker", async () => {
    const harness = makeHarness();
    const started = await harness.engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174040" as never,
    });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    const attempt = detail.attempts[0]!;
    const lease = detail.lease!;
    const finishedAt = harness.clock.value.toISOString();
    harness.store.updateDispatchAttempt({ ...attempt, status: "no-op", workerThreadId: null, finishedAt });
    harness.store.updateRunDispatch({
      repositoryKey: "monorepo",
      runId,
      status: "no-op",
      startedAt: detail.summary.startedAt,
      finishedAt,
      providerId: detail.summary.providerId!,
      workerThreadId: "never-dispatched",
      projectId: detail.summary.projectId!,
      environmentId: detail.summary.environmentId,
      repositoryRevision: detail.summary.repositoryRevision,
    });
    harness.store.updateOwnershipLease({ ...lease, workerThreadId: null, status: "reconciliation-required" });

    await harness.engine.reconcile("monorepo");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("ignores delayed spawn failure after a newer terminal state", async () => {
    const harness = makeHarness();
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    harness.threads.spawn = async () => {
      await spawnGate;
      throw new Error("delayed spawn failure");
    };

    const pending = harness.engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174024" as never });
    await yieldToDispatch();
    const runId = harness.store.listActiveRuns("monorepo")[0]!.runId;
    const stopped = await harness.engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: true, result: { status: "accepted" } });
    releaseSpawn();

    expect(await pending).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect((await harness.store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("no-op");
    expect(harness.store.getReconciliation(runId)).toBeNull();
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
  });

  it("does not let a delayed initial spawn stop a worker reused by a retry generation", async () => {
    const harness = makeHarness();
    const originalSpawn = harness.threads.spawn.bind(harness.threads);
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    harness.threads.spawn = async (input) => {
      const spawned = await originalSpawn(input);
      await spawnGate;
      return spawned;
    };

    const pending = harness.engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174036" as never });
    await yieldToDispatch();
    const runId = harness.store.listActiveRuns("monorepo")[0]!.runId;
    const detail = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    const attempt = detail.attempts[0]!;
    const lease = detail.lease!;
    const finishedAt = harness.clock.value.toISOString();
    harness.store.updateDispatchAttempt({ ...attempt, workerThreadId: "thread-1", status: "failed-safe", finishedAt });
    harness.store.updateRunDispatch({
      repositoryKey: "monorepo",
      runId,
      status: "failed-safe",
      startedAt: detail.summary.startedAt,
      finishedAt,
      providerId: "codex",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: detail.summary.environmentId,
      repositoryRevision: detail.summary.repositoryRevision,
    });
    harness.store.updateOwnershipLease({ ...lease, workerThreadId: "thread-1", status: "released" });
    harness.threads.threads.get("thread-1")!.status = "error";

    const retried = await harness.engine.requestRetry({ repositoryKey: "monorepo", attemptId: attempt.attemptId });
    expect(retried).toMatchObject({ ok: true, result: { action: "retry" } });
    releaseSpawn();

    expect(await pending).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.threads.stopped).not.toContain("thread-1");
    const current = (await harness.store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(current.summary.status).toBe("started");
    expect(current.attempts.at(-1)?.status).toBe("started");
    expect(current.lease?.status).toBe("held");
  });

  it("keeps an ambiguous spawn quarantined even when current.md claims no thread was attached", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    await harness.engine.requestRun(MANUAL_REQUEST);
    const runId = harness.store.listActiveRuns("monorepo")[0]!.runId;
    advancePastReconciliation(harness.clock);
    await harness.engine.reconcile("monorepo");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");

    harness.files.put(
      `${CHECKOUT}/${PROTOCOL_PATHS.current}`,
      "# Operator confirmation\nspawn: no-thread-attached\nstate: failed-safe\n",
      harness.clock.value.getTime() + 1_000,
    );
    await harness.engine.reconcile("monorepo");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");

    harness.clock.value = new Date(harness.clock.value.getTime() + QUARANTINE_ABANDONMENT_GRACE_MS + 1);
    await harness.engine.reconcile("monorepo");
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("releases an unknown-worker quarantine only through the paused, durable operator path", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    await harness.engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174035" as never });
    const runId = harness.store.listActiveRuns("monorepo")[0]!.runId;
    advancePastReconciliation(harness.clock);
    await harness.engine.reconcile("monorepo");
    const metadata = harness.store.getReconciliation(runId)!;
    harness.clock.value = new Date(Date.parse(metadata.deadlineAt) + QUARANTINE_ABANDONMENT_GRACE_MS + 1);
    harness.entry.dispatchPaused = true;

    const released = await harness.engine.requestStop("monorepo");
    expect(released).toMatchObject({ ok: true, result: { status: "accepted", action: "stop" } });
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("refuses to release ownership on a stop request for a reconciliation-required run", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    await harness.engine.requestRun(MANUAL_REQUEST);
    const runs = harness.store.listActiveRuns("monorepo");
    const runId = runs[0]!.runId;

    const stopped = await harness.engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
  });

  it("requests stop on the active run and releases the lease after the worker idles", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    const stopped = await engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: true, result: { status: "accepted", action: "stop" } });
    expect(threads.stopped).toEqual(["thread-1"]);
    let detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("cancel-requested");
    const second = await engine.requestStop("monorepo");
    expect(second.ok && second.result.status).toBe("already-applied");
    await engine.reconcile("monorepo");
    detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("no-op");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("does not let a post-await stop result overwrite a newer cancellation generation", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174028" as never });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    const originalStop = threads.stop.bind(threads);
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => { markStopEntered = resolve; });
    threads.stop = async (input) => {
      markStopEntered();
      await stopGate;
      await originalStop(input);
    };
    const stopping = engine.requestStop("monorepo");
    await stopEntered;

    const detail = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    const attempt = detail.attempts[0]!;
    const lease = detail.lease!;
    store.updateRunDispatch({
      repositoryKey: "monorepo",
      runId,
      status: "cancel-requested",
      startedAt: detail.summary.startedAt,
      finishedAt: null,
      providerId: detail.summary.providerId!,
      workerThreadId: detail.summary.workerThreadId!,
      projectId: detail.summary.projectId!,
      environmentId: detail.summary.environmentId,
      repositoryRevision: detail.summary.repositoryRevision,
    });
    store.updateDispatchAttempt({ ...attempt, status: "cancel-requested" });
    store.updateOwnershipLease({ ...lease, status: "release-requested" });

    releaseStop();
    const result = await stopping;
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    const current = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(current.summary.status).toBe("cancel-requested");
    expect(current.attempts[0]?.status).toBe("cancel-requested");
    expect(current.lease?.status).toBe("release-requested");
  });

  it("does not let a delayed stop kill a retry that reuses the worker thread", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174027" as never });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    const originalStop = threads.stop.bind(threads);
    let releaseStop!: () => void;
    let markStopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopEntered = new Promise<void>((resolve) => { markStopEntered = resolve; });
    threads.stop = async (input) => {
      markStopEntered();
      await stopGate;
      await originalStop(input);
    };

    const stopping = engine.requestStop("monorepo");
    await stopEntered;
    const beforeRetry = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    const oldAttempt = beforeRetry.attempts[0]!;
    const oldLease = beforeRetry.lease!;
    const finishedAt = new Date(clock.value.getTime() + 1_000).toISOString();
    store.updateRunDispatch({
      repositoryKey: "monorepo",
      runId,
      status: "failed-safe",
      startedAt: beforeRetry.summary.startedAt,
      finishedAt,
      providerId: beforeRetry.summary.providerId!,
      workerThreadId: "thread-1",
      projectId: beforeRetry.summary.projectId!,
      environmentId: beforeRetry.summary.environmentId,
      repositoryRevision: beforeRetry.summary.repositoryRevision,
    });
    store.updateDispatchAttempt({ ...oldAttempt, status: "failed-safe", finishedAt });
    store.updateOwnershipLease({ ...oldLease, status: "released" });
    threads.threads.get("thread-1")!.status = "error";

    const retrying = engine.requestRetry({ repositoryKey: "monorepo", attemptId: oldAttempt.attemptId });
    await Promise.resolve();
    releaseStop();

    expect(await stopping).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(await retrying).toMatchObject({ ok: true, result: { action: "retry" } });
    expect(threads.threads.get("thread-1")?.status).toBe("active");
    const after = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(after.summary.status).toBe("started");
    expect(after.attempts.at(-1)?.status).toBe("started");
    expect(after.lease?.status).toBe("held");
  });

  it("bounds cancel-requested runs and quarantines the lease when stop fails", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174029" as never });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.stopError = new Error("stop transport unavailable");
    const stopped = await engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: false, error: { category: "internal" } });
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("cancel-requested");
    const lease = store.getLeaseForRun(runId)!;
    clock.value = new Date(Date.parse(lease.expiresAt) + 1);

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
    threads.stopError = null;
    threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("retries a failed-safe run only while its thread is in error", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    const attemptId = detail.run!.attempts[0]!.attemptId;
    expect(store.getReconciliation(runId)?.resolution).toBe("failed-safe");

    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: true, result: { status: "accepted", action: "retry" } });
    expect(threads.retried).toEqual(["thread-1"]);
    const after = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(after.run?.summary.status).toBe("started");
    expect(after.run?.attempts).toHaveLength(2);
    expect(after.run?.lease?.status).toBe("held");
    expect(store.getReconciliation(runId)).toBeNull();
    expect(store.getDispatcherState("monorepo").failedCount).toBe(1);

    threads.threads.get("thread-1")!.status = "error";
    clock.value = new Date(Date.parse(after.run!.lease!.expiresAt) + 1);
    await engine.reconcile("monorepo");
    const retryMetadata = store.getReconciliation(runId)!;
    clock.value = new Date(Date.parse(retryMetadata.deadlineAt) + 1);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getDispatcherState("monorepo").failedCount).toBe(1);
  });

  it("fences reconciliation while retry is pending before the provider call returns", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;
    const originalRetry = threads.retry.bind(threads);
    threads.retry = async ({ threadId }) => {
      const during = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
      expect(during.summary.status).toBe("started");
      expect(during.attempts.at(-1)?.status).toBe("pending");
      expect(during.lease?.status).toBe("held");
      await engine.reconcile("monorepo");
      expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("started");
      await originalRetry({ threadId });
    };

    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried.ok).toBe(true);
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.attempts.at(-1)?.status).toBe("started");
  });

  it("keeps a retry call error ambiguous and quarantines ownership through deadline settlement", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;
    threads.retryError = new Error("retry transport reset");

    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: false, error: { category: "internal" } });
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toBe("retry-ambiguous");

    threads.threads.delete("thread-1");
    const metadata = store.getReconciliation(runId)!;
    clock.value = new Date(Date.parse(metadata.deadlineAt) + 1);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);

    threads.threads.set("thread-1", { id: "thread-1", status: "idle" });
    await engine.reconcile("monorepo");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("settles a persisted pending retry after a hung provider call without releasing its lease", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;

    let releaseRetry!: () => void;
    let retryEntered!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const entered = new Promise<void>((resolve) => { retryEntered = resolve; });
    threads.retry = async () => {
      retryEntered();
      await retryGate;
    };
    const retrying = engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    await entered;
    const pending = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(pending.summary.status).toBe("started");
    expect(pending.attempts.at(-1)?.status).toBe("pending");
    threads.threads.get("thread-1")!.status = "active";
    threads.stopError = new Error("stop transport unavailable");
    clock.value = new Date(Date.parse(pending.lease!.expiresAt) + 1);

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
    expect(store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");

    threads.stopError = null;
    releaseRetry();
    expect(await retrying).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(threads.stopped).not.toContain("thread-1");
    expect(threads.threads.get("thread-1")?.status).toBe("active");
    threads.threads.get("thread-1")!.status = "idle";
    await engine.reconcile("monorepo");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("enforces global capacity atomically before a retry on another repository", async () => {
    const { engine, threads, store, clock } = makeMultiRepositoryHarness({ settings: { concurrencyLimit: 1 } });
    const started = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174032" as never });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;
    const other = await engine.requestRun({
      repositoryKey: "other",
      trigger: "manual",
      idempotencyKey: "bbf:v1:other:run-now:923e4567-e89b-42d3-a456-426614174033" as never,
    });
    expect(other).toMatchObject({ ok: true, result: { status: "accepted" } });

    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(threads.retried).toHaveLength(0);
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("failed-safe");
  });

  it("does not let retry success overwrite a concurrent stop generation", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const started = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174025" as never });
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    advancePastReconciliation(clock);
    await engine.reconcile("monorepo");
    const attemptId = (await store.getRun({ repositoryKey: "monorepo", runId })).run!.attempts[0]!.attemptId;
    const originalRetry = threads.retry.bind(threads);
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let retryEntered!: () => void;
    const entered = new Promise<void>((resolve) => { retryEntered = resolve; });
    threads.retry = async ({ threadId }) => {
      retryEntered();
      await retryGate;
      await originalRetry({ threadId });
    };

    const retrying = engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    await entered;
    const stopped = await engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: true, result: { status: "accepted" } });
    releaseRetry();

    expect(await retrying).toMatchObject({ ok: false, error: { category: "conflict" } });
    const detail = (await store.getRun({ repositoryKey: "monorepo", runId })).run!;
    expect(detail.summary.status).toBe("cancel-requested");
    expect(detail.attempts.at(-1)?.status).toBe("cancel-requested");
    expect(detail.lease?.status).toBe("release-requested");
  });

  it("returns reconciliation-required when a targeted evidence search is truncated", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174026" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\nRun 2026-09-10T02:00:00Z\nstate: success\n", clock.value.getTime() + 60_000);
    for (let index = 0; index < 257; index += 1) {
      files.seed(`plans/factory/runs/20260910T020000Z-thread-1-${index}.md`, "# Run\n\nstate: success\n");
    }

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("immutable terminal evidence");
  });

  it("rejects a discovered timestamp-only immutable filename", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun({ ...MANUAL_REQUEST, idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174027" as never });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "idle";
    files.put(`${CHECKOUT}/${PROTOCOL_PATHS.current}`, "# Latest run\nRun 2026-09-10T02:00:00Z\nstate: success\n", clock.value.getTime() + 60_000);
    files.seed("plans/factory/runs/20260910T020000Z.md", "# Run\n\nstate: success\n");

    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId })).run?.summary.status).toBe("reconciliation-required");
    expect(store.getReconciliation(runId)?.reasonCode).toContain("filename");
  });

  it("rejects retry when the worker is not in an error state", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    const attemptId = detail.run!.attempts[0]!.attemptId;
    threads.threads.get("thread-1")!.status = "idle";
    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("marks a run that was never dispatched as reconciliation-required after the grace period", async () => {
    const { store, engine, clock } = makeHarness();
    store.createRunIntent({
      intent: {
        runId: "run-orphan",
        repositoryKey: "monorepo",
        trigger: "schedule",
        idempotencyKey: "bbf:v1:monorepo:run-now:333e4567-e89b-42d3-a456-426614174000",
        requestedAt: clock.value.toISOString(),
        baseRevision: { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} },
        queueItemIds: [],
        authorizationProvenance: [],
      },
      canonicalRecords: [],
    });
    clock.value = new Date(clock.value.getTime() + 11 * 60 * 1000);
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: "run-orphan" });
    expect(detail.run?.summary.status).toBe("reconciliation-required");
    const metadata = store.getReconciliation("run-orphan")!;
    clock.value = new Date(Date.parse(metadata.deadlineAt) + 1);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: "run-orphan" })).run?.summary.status).toBe("failed-safe");
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
  });

  it("settles and releases a pending claim after its start grace expires", async () => {
    const { store, engine, clock } = makeHarness();
    const revision = { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} };
    const requestedAt = clock.value.toISOString();
    store.createRunIntent({
      intent: {
        runId: "run-expired-pending",
        repositoryKey: "monorepo",
        trigger: "schedule",
        idempotencyKey: "bbf:v1:monorepo:run-now:333e4567-e89b-42d3-a456-426614174042",
        requestedAt,
        baseRevision: revision,
        queueItemIds: [],
        authorizationProvenance: [],
      },
      canonicalRecords: [],
    });
    store.createDispatchAttempt({
      attemptId: "attempt-expired-pending",
      runId: "run-expired-pending",
      repositoryKey: "monorepo",
      providerId: "codex",
      model: "codex-model",
      reasoningLevel: "high",
      workerThreadId: null,
      status: "pending",
      startedAt: null,
      finishedAt: null,
    });
    store.createOwnershipLease({
      leaseId: "lease-expired-pending",
      repositoryKey: "monorepo",
      runId: "run-expired-pending",
      queueItemIds: [],
      workerThreadId: null,
      authorizationProvenance: [],
      acquiredAt: requestedAt,
      expiresAt: new Date(clock.value.getTime() + 60 * 60 * 1000).toISOString(),
      status: "held",
    });

    clock.value = new Date(clock.value.getTime() + 11 * 60 * 1000);
    await engine.reconcile("monorepo");
    expect((await store.getRun({ repositoryKey: "monorepo", runId: "run-expired-pending" })).run?.summary.status).toBe("failed-safe");
    expect(store.getCurrentOwnership("monorepo")).toBeNull();
  });
});

async function makeHarnessResult(runId: string, store: ReturnType<typeof makeStore>) {
  return store.getRun({ repositoryKey: "monorepo", runId });
}

describe("scheduler", () => {
  it("matches cron fields with POSIX dom/dow semantics", () => {
    const tuesday = new Date("2026-09-08T03:30:00");
    expect(cronMatches("30 3 * * *", tuesday, "server-local")).toBe(true);
    expect(cronMatches("31 3 * * *", tuesday, "server-local")).toBe(false);
    expect(cronMatches("30 3 * * 2", tuesday, "server-local")).toBe(true);
    expect(cronMatches("30 3 * * 4", tuesday, "server-local")).toBe(false);
    expect(cronMatches("30 3 8 * 4", tuesday, "server-local")).toBe(true);
    expect(cronMatches("30 3 9 * 4", tuesday, "server-local")).toBe(false);
    expect(cronMatches("*/15 3 * * *", tuesday, "server-local")).toBe(true);
    expect(cronMatches("0-20 3 * * *", tuesday, "server-local")).toBe(false);
    expect(cronMatches("not a cron", tuesday, "server-local")).toBe(false);
  });

  it("skips when paused, unscheduled, or outside the night window", async () => {
    const paused = makeHarness({ settings: { dispatchMode: "paused", scheduleCron: "* * * * *" } });
    expect((await schedulerTick(paused.ctx, "monorepo", ["monorepo"])).reason).toBe("dispatch is paused");

    const noCron = makeHarness({ settings: { scheduleCron: undefined } });
    expect((await schedulerTick(noCron.ctx, "monorepo", ["monorepo"])).reason).toBe("no schedule configured");

    const daytime = makeHarness({
      now: new Date("2026-09-10T12:00:00"),
      settings: { scheduleCron: "* * * * *", nightWindowEndHour: 6 },
    });
    const dayResult = await schedulerTick(daytime.ctx, "monorepo", ["monorepo"]);
    expect(dayResult.action).toBe("skipped");
    expect(dayResult.reason).toContain("night window");
  });

  it("starts a scheduled run inside the night window", async () => {
    const { ctx, threads, store, clock } = makeHarness({
      now: new Date(2026, 8, 10, 2, 0),
      settings: { scheduleCron: "* * * * *", nightWindowEndHour: 6 },
    });
    const result = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(result.action).toBe("started");
    expect(threads.threads.size).toBe(1);
    expect(store.listActiveRuns("monorepo")).toHaveLength(1);

    const again = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(again.action).toBe("skipped");
    expect(again.reason).toBe("inside the minimum start gap");

    clock.value = new Date(2026, 8, 10, 4, 0);
    const held = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(held.action).toBe("skipped");
    expect(held.reason).toContain("concurrency");
  });

  it("allows another repository to dispatch while one repository is stuck", async () => {
    const harness = makeHarness({ settings: { scheduleCron: "* * * * *", concurrencyLimit: 1 } });
    const otherEntry = {
      ...makeRegistryEntry(),
      projectId: "project-other",
      configuration: {
        ...makeRegistryEntry().configuration,
        repositoryKey: "other",
        repositoryRoot: "/repo-other",
        checkoutPath: "/repo-other",
      },
    };
    harness.files.seedProtocol();
    for (const [path, content] of [
      ["plans/factory/foreman.md", "# Foreman\n"],
      ["plans/factory/repo.md", "# Repo\n"],
      ["plans/factory/current.md", "# Current\n\nstate: no-op\n"],
      ["plans/factory/questions.md", "# Questions\n"],
      ["plans/factory/queue.md", "# Queue\n"],
      ["plans/README.md", "# Dashboard\n\n| id | work item | status | next action | evidence and canonical detail |\n|---|---|---|---|---|\n| T1 | Sample task | open | run | queue |\n"],
    ] as const) harness.files.seed(path, content, "/repo-other");
    harness.files.put("/repo-other/plans/factory/queue.md", QUEUE_MD.replace("status: blocked-by: Q6", "status: ready").replace("approved: none", "approved: task scope"));
    harness.files.put("/repo-other/plans/factory/questions.md", "# Questions\n");
    const entries = new Map([["monorepo", makeRegistryEntry()], ["other", otherEntry]]);
    const tasksClient = {
      listProjects: async () => [],
      createProject: async (input: { linkedBbProjectId?: string | null }) => ({
        id: `tasks-${input.linkedBbProjectId ?? "factory"}`,
        name: "Factory",
        prefix: "OTHER",
        color: "#123456",
        linkedBbProjectId: input.linkedBbProjectId ?? null,
      }),
      listAllTasks: async () => [],
      getTaskByKey: async () => ({
        id: "task-other",
        projectId: "tasks-project-other",
        key: "OTHER-1",
        title: "Sample task",
        status: "todo" as const,
        priority: "medium" as const,
        description: null,
        dueDate: null,
        labelIds: [],
        parentTaskId: null,
        position: 0,
      }),
      createTask: async (input: { projectId: string; title: string }) => ({
        ok: true as const,
        task: {
          id: `task-${input.projectId}`,
          projectId: input.projectId,
          key: "OTHER-1",
          title: input.title,
          status: "todo" as const,
          priority: "medium" as const,
          description: null,
          dueDate: null,
          labelIds: [],
          parentTaskId: null,
          position: 0,
        },
      }),
    } as unknown as TasksClient;
    const ctx: DispatchContext = {
      ...harness.ctx,
      repositoryLookup: (key) => entries.get(key as "monorepo" | "other") ?? null,
      tasksIntegration: "enabled",
      tasksClient,
      healthReader: {
        ...harness.ctx.healthReader,
        getTasksAvailability: async () => ({ enabled: true, status: "available" as const, message: "Tasks is available." }),
      },
      settings: makeSettings({
        scheduleCron: "* * * * *",
        concurrencyLimit: 1,
        repositoryRegistry: { repositories: [...entries.values()], defaultRepositoryKey: "monorepo" },
      }),
    };
    const intent = {
      runId: "run-global-recovery",
      repositoryKey: "monorepo" as const,
      trigger: "recovery" as const,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174011" as never,
      requestedAt: harness.clock.value.toISOString(),
      baseRevision: { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} },
      queueItemIds: [],
      authorizationProvenance: [],
    };
    harness.store.createRunIntent({ intent });
    harness.store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-09T00:00:00Z",
      deadlineAt: "2026-09-09T00:10:00Z",
      reasonCode: "stale-completion",
      rawObservation: "state: partial",
    });
    harness.store.updateRunDispatch({
      repositoryKey: intent.repositoryKey,
      runId: intent.runId,
      status: "reconciliation-required",
      startedAt: null,
      finishedAt: null,
      providerId: "codex",
      workerThreadId: "unknown-thread",
      projectId: "project-1",
      environmentId: "environment-1",
      repositoryRevision: intent.baseRevision,
    });

    const started = await schedulerTick(ctx, "other", ["monorepo", "other"]);
    expect(started.action).toBe("started");
  });

  it("night-stops after a blocked run and honors the minimum start gap", async () => {
    const now = new Date(2026, 8, 10, 2, 0);
    const { ctx, store } = makeHarness({
      now,
      settings: { scheduleCron: "* * * * *" },
    });
    store.saveDispatcherState({
      ...store.getDispatcherState("monorepo"),
      nightKey: "2026-09-09",
      lastState: "blocked",
    });
    const blocked = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(blocked.reason).toBe("night stopped after a blocked run");

    store.saveDispatcherState({
      ...store.getDispatcherState("monorepo"),
      lastState: "",
      lastStartAt: Math.floor((now.getTime() - 30 * 60 * 1000) / 1000),
    });
    const spaced = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(spaced.reason).toBe("inside the minimum start gap");
  });
});
