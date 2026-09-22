// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { createElement, useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectTasks, renderFactoryQuestionDescription, renderFactoryTaskDescription, type FactoryTaskMetadata } from "../src/tasks/migration.js";
import { TasksClient, type TasksRpcCall, type TasksTask } from "../src/tasks/index.js";
import type { TasksBlockerRecord } from "../src/storage/index.js";
import type { ProtocolSnapshot } from "../src/contracts.js";
import type { FactoryViewProps } from "../src/ui/FactoryView.js";
import type { FactoryRpcContract } from "../src/rpc.js";
import { parseFactoryRoute } from "../src/ui/routes.js";

type ControlledSettingsState = { values: Record<string, string | number | boolean> | undefined; isLoading: boolean };
let controlledSettingsState: ControlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
const controlledSettingsSubscribers = new Set<() => void>();

const revision = {
  gitCommit: "abcdef1234567",
  protocolDigest: "a".repeat(64),
  fileDigests: { "plans/factory/queue.md": "b".repeat(64) },
} as const;

const repository = {
  repositoryKey: "demo",
  repositoryRoot: "/work/demo",
  connectedHostId: "host-1",
  checkoutPath: "/work/demo",
  factoryBranch: "factory" as const,
  mainRef: "origin/main",
};

const snapshot = {
  repository,
  revision,
  capturedAt: "2026-09-10T12:00:00Z",
  foremanTemplate: {
    authority: "repository-protocol" as const,
    relativePath: "plans/factory/foreman.md" as const,
    contentSha256: "c".repeat(64),
    repositoryRevision: revision,
  },
  queue: [
    {
      id: "ready-item",
      title: "Ready work",
      status: { kind: "ready" as const },
      priority: 1,
      dependsOn: [],
      risk: "low" as const,
      planPath: "plans/ready.md",
      approved: { kind: "explicit" as const, source: "queue.approved" as const, text: "approved by Adam" },
      acceptance: ["It works"],
      validate: ["pnpm test"],
      notes: null,
      blockingQuestionIds: [],
      staleBlockingQuestionIds: [],
      blockedBy: [],
      eligible: true,
      eligibilityReasons: [],
    },
  ],
  questions: [
    {
      id: "Q1",
      date: "2026-09-10",
      classification: "blocking" as const,
      dashboardId: "blocked-item",
      question: "Which source is authoritative?",
      context: "Two candidates exist.",
      assumed: null,
      answer: null,
    },
  ],
  dashboard: {
    canonicalPath: "plans/README.md" as const,
    factoryBranch: "factory" as const,
    mainRef: "origin/main",
    factoryAhead: 1,
    mainBehind: 0,
    taskCommits: [],
    safeFastForward: true,
    canonicalDashboardUrl: null,
  },
  currentRun: {
    state: "no-op" as const,
    lastRunAt: null,
    currentPath: "plans/factory/current.md" as const,
    latestRunPath: null,
  },
};

const repositorySelection = {
  repositories: [{ configuration: repository, projectId: "project-1", environmentId: "environment-1", dispatchPaused: false, selected: true, available: true, reasons: [] }],
  selectedRepositoryKey: "demo",
};

const settingsProjection = {
  settings: {
    repositoryKey: "demo",
    repositoryRoot: "/work/demo",
    connectedHostId: "host-1",
    checkoutPath: "/work/demo",
    scheduleCron: "0 * * * *",
    timeZone: "UTC",
    nightWindowEndHour: 6,
    runtimeCapSeconds: 3600,
    providerPreference: "codex" as const,
    minimumStartGapSeconds: 3600,
    concurrencyLimit: 1,
    dispatchMode: "paused" as const,
  },
  validation: { valid: true, fieldErrors: {} },
  dispatch: { mode: "paused" as const, repositoryPaused: false, acceptingNewRuns: false, activeRunCount: 0, reason: null },
};

const enabledSettings = {
  ...settingsProjection,
  settings: { ...settingsProjection.settings, dispatchMode: "enabled" as const },
  dispatch: { mode: "enabled" as const, repositoryPaused: false, acceptingNewRuns: true, activeRunCount: 0, reason: null },
};

const healthProjection = {
  repositoryKey: "demo",
  providers: [{ providerId: "codex", model: "gpt-5", reasoningLevel: "medium" as const, availability: "available" as const, limitedUntil: null, activeThreadCount: 0, lastError: null }],
  host: { hostId: "host-1", status: "online" as const, checkoutExists: true, branch: "factory", requiredTools: { pnpm: true }, browserAvailable: null, dbtStudioAvailable: null, ok: true, reasons: [] },
};

const runSummary = {
  runId: "run-1",
  repositoryKey: "demo",
  requestedAt: "2026-09-10T12:00:00Z",
  startedAt: "2026-09-10T12:01:00Z",
  finishedAt: "2026-09-10T12:02:00Z",
  providerId: "codex",
  workerThreadId: "th_worker",
  projectId: "project-1",
  environmentId: "environment-1",
  status: "completed" as const,
  queueItemIds: ["ready-item"],
  repositoryRevision: revision,
  canonicalRecords: [{ relativePath: "plans/factory/runs/run-1.md", recordType: "immutable-run" as const, recordId: "run-1", repositoryRevision: revision }],
};

const runDetail = {
  run: {
    summary: runSummary,
    intent: {
      runId: "run-1",
      repositoryKey: "demo",
      trigger: "manual" as const,
      idempotencyKey: "bbf:v1:demo:run-now:00000000-0000-4000-8000-000000000001",
      requestedAt: "2026-09-10T12:00:00Z",
      baseRevision: revision,
      queueItemIds: ["ready-item"],
      authorizationProvenance: [{ queueItemId: "ready-item", source: "queue.approved" as const, approvedText: "approved by Adam" }],
    },
    attempts: [],
    lease: null,
  },
};

const monorepoRepository = {
  ...repository,
  repositoryKey: "monorepo",
  repositoryRoot: "/work/monorepo",
  checkoutPath: "/work/monorepo",
};

const dataRepository = {
  ...repository,
  repositoryKey: "data",
  repositoryRoot: "/work/data",
  checkoutPath: "/work/data",
};

const repositoryForSwitch = (repositoryKey: string) => repositoryKey === "data" ? dataRepository : monorepoRepository;
const repositorySelectionForSwitch = (requestedRepositoryKey: string | null | undefined) => {
  const selectedRepositoryKey = requestedRepositoryKey === "data" ? "data" : "monorepo";
  return {
    repositories: [monorepoRepository, dataRepository].map((configuration) => ({
      configuration,
      projectId: `project-${configuration.repositoryKey}`,
      environmentId: `environment-${configuration.repositoryKey}`,
      dispatchPaused: false,
      selected: configuration.repositoryKey === selectedRepositoryKey,
      available: true,
      reasons: [],
    })),
    selectedRepositoryKey,
  };
};
const snapshotForSwitch = (repositoryKey: string) => ({ ...snapshot, repository: repositoryForSwitch(repositoryKey) });
const settingsForSwitch = (repositoryKey: string) => ({ ...settingsProjection, settings: { ...settingsProjection.settings, repositoryKey, repositoryRoot: repositoryForSwitch(repositoryKey).repositoryRoot, checkoutPath: repositoryForSwitch(repositoryKey).checkoutPath } });
const healthForSwitch = (repositoryKey: string) => ({ ...healthProjection, repositoryKey, host: { ...healthProjection.host, hostId: repositoryForSwitch(repositoryKey).connectedHostId } });
const runsForSwitch = (repositoryKey: string) => ({ runs: [{ ...runSummary, repositoryKey }], nextCursor: null });

function baseRpc(overrides: Record<string, unknown> = {}) {
  return {
    factory_repositories: () => overrides.repositories ?? repositorySelection,
    factory_snapshot: () => {
      if (overrides.snapshotError) throw new Error(overrides.snapshotError as string);
      return overrides.snapshot ?? snapshot;
    },
    factory_settings: () => overrides.settings ?? settingsProjection,
    factory_health: () => overrides.health ?? healthProjection,
    factory_interactions: () => overrides.interactions ?? { repositoryKey: "demo", interactions: [] },
    factory_runs: () => overrides.runs ?? { runs: [runSummary], nextCursor: null },
    factory_run_detail: () => runDetail,
    factory_action: vi.fn((input: { action: { kind: string } }) => ({
      ok: true as const,
      revision,
      result: {
        status: "accepted" as const,
        message: `${input.action.kind} applied.`,
        revision,
        runId: input.action.kind === "run-now" ? "run-2" : null,
        leaseId: null,
        queueItemId: input.action.kind === "approve-queue" ? "blocked-item" : null,
        action: input.action.kind,
        questionId: null,
        interactionId: null,
      },
    })),
  } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_action: ReturnType<typeof vi.fn> };
}

const uiTasksProject = {
  id: "ui-tasks-project",
  name: "Factory Tasks",
  prefix: "FAC",
  color: "#123456",
  linkedBbProjectId: "project-1",
} as const;

const uiTaskMetadata: FactoryTaskMetadata = {
  dashboardId: "T1",
  priority: 2,
  dependsOn: [],
  risk: "low",
  planPath: "plans/factory/plan.md",
  acceptance: ["The card-backed work is complete."],
  validate: ["pnpm test"],
  notes: "Card-backed notes.",
  approvedScopes: [],
  approvedText: null,
  questionId: null,
  questionDate: null,
  questionText: null,
};

function disabledUiSnapshot(projected: ProtocolSnapshot): ProtocolSnapshot {
  return {
    ...projected,
    queue: projected.queue.map((entry) => {
      const legacyEntry = { ...entry } as Record<string, unknown>;
      delete legacyEntry.factoryMetadataPresent;
      delete legacyEntry.description;
      delete legacyEntry.labels;
      return legacyEntry as ProtocolSnapshot["queue"][number];
    }),
  };
}

async function projectUiSnapshot(repositoryKey: string): Promise<ProtocolSnapshot> {
  const project = { ...uiTasksProject, linkedBbProjectId: `project-${repositoryKey}` };
  const tasks: TasksTask[] = [
    {
      id: `${repositoryKey}-queue-task`,
      projectId: project.id,
      key: "FAC-1",
      title: "Card-backed work",
      status: "todo",
      priority: "high",
      description: renderFactoryTaskDescription(uiTaskMetadata),
      dueDate: null,
      labelIds: [],
      parentTaskId: null,
      position: 1,
    },
    {
      id: `${repositoryKey}-question-task`,
      projectId: project.id,
      key: "FAC-Q",
      title: "Question card",
      status: "todo",
      priority: "high",
      description: renderFactoryQuestionDescription({
        questionId: "Q1",
        date: "2026-09-10",
        question: "Which provider?",
        context: "Real blocker context.",
      }),
      dueDate: null,
      labelIds: [],
      parentTaskId: null,
      position: 2,
    },
  ];
  const blocker: TasksBlockerRecord = {
    blockerId: "Q1",
    repositoryKey: repositoryKey as TasksBlockerRecord["repositoryKey"],
    taskId: `${repositoryKey}-question-task`,
    kind: "blocking-question",
    state: "open",
    questionText: "Which provider?",
    answerText: null,
    provenance: { source: "ui-test", date: "2026-09-10" },
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    answeredAt: null,
    resolvedAt: null,
  };
  const client = new TasksClient((async ({ method, input }: Parameters<TasksRpcCall>[0]) => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (method === "listTasks") return { tasks: tasks.filter((task) => task.projectId === args.projectId), nextCursor: null };
    if (method === "listLabels") return { labels: [] };
    throw new Error(`Unexpected Tasks RPC ${method}`);
  }) as never);
  const projection = await projectTasks(client, {
    listTasksApprovals: () => [],
    listTasksDependencyEdges: () => [],
    listTasksBlockers: () => [blocker],
  }, {
    repositoryKey: repositoryKey as typeof blocker.repositoryKey,
    project,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  });
  return {
    ...snapshot,
    repository: repositoryKey === "demo" ? repository : repositoryForSwitch(repositoryKey),
    queue: [...projection.queue],
    questions: [...projection.questions],
  };
}

function modeEquivalenceRpc(
  scope: "repository" | "aggregate",
  snapshots: ReadonlyMap<string, ProtocolSnapshot>,
) {
  return {
    ...baseRpc(),
    factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => scope === "repository"
      ? repositorySelection
      : repositorySelectionForSwitch(input.selectedRepositoryKey)),
    factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshots.get(repositoryKey)),
    factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
    factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
    factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
    factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({
      runs: [{ ...runSummary, repositoryKey, queueItemIds: ["FAC-1"] }],
      nextCursor: null,
    })),
  } as ReturnType<typeof baseRpc>;
}

function visibleFactoryText(slot: ReturnType<typeof renderSlot>): string {
  return (slot.container.textContent ?? "")
    .replace(/refreshed just now\?|Updated\?/gu, "updated")
    .replace(/\s+/gu, " ")
    .trim();
}

function submittedFactoryAction(rpc: ReturnType<typeof modeEquivalenceRpc>) {
  const input = rpc.factory_action.mock.calls[0]?.[0] as { repositoryKey: string; action: unknown } | undefined;
  return input ? { repositoryKey: input.repositoryKey, action: input.action } : null;
}

beforeAll(() => {
  installTestPluginRuntime();
});

describe("Factory routes", () => {
  it("parses sections, anchors, run ids, and repository routes", () => {
    expect(parseFactoryRoute("")).toMatchObject({ section: "overview" });
    expect(parseFactoryRoute("queue")).toMatchObject({ section: "work" });
    expect(parseFactoryRoute("work#work-A-1")).toMatchObject({ section: "work", anchor: "work-A-1" });
    expect(parseFactoryRoute("questions#question-Q9")).toMatchObject({ section: "questions", anchor: "question-Q9" });
    expect(parseFactoryRoute("runs/run%2F2026")).toMatchObject({ section: "runs", runId: "run/2026" });
    expect(parseFactoryRoute("repositories")).toMatchObject({ section: "overview", scope: "all" });
    expect(parseFactoryRoute("repositories/new")).toMatchObject({ section: "add-repository" });
    expect(parseFactoryRoute("unexpected/path")).toMatchObject({ section: "not-found", raw: "unexpected/path" });
  });
});

describe("Factory view shell", () => {
  it("waits for settings before reading and loads the configured repository once", async () => {
    const runtime = globalThis as typeof globalThis & {
      __bbPluginRuntime?: {
        pluginSdkApp: {
          useSettings: () => { values: Record<string, string | number | boolean> | undefined; isLoading: boolean };
        };
      };
    };
    if (!runtime.__bbPluginRuntime) throw new Error("The SDK test runtime is unavailable");

    controlledSettingsState = { values: undefined, isLoading: true };
    const originalUseSettings = runtime.__bbPluginRuntime.pluginSdkApp.useSettings;
    runtime.__bbPluginRuntime.pluginSdkApp.useSettings = () => {
      const [, forceRender] = useState(0);
      useEffect(() => {
        const subscriber = () => forceRender((value) => value + 1);
        controlledSettingsSubscribers.add(subscriber);
        return () => {
          controlledSettingsSubscribers.delete(subscriber);
        };
      }, []);
      return controlledSettingsState;
    };

    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await act(async () => undefined);
      expect(slot.inspection.rpcCalls).toHaveLength(0);

      await act(async () => {
        controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
        for (const subscriber of controlledSettingsSubscribers) subscriber();
      });
      await slot.findByText("Factory");

      expect(slot.inspection.rpcCalls).toEqual([
        { method: "factory_repositories", input: { selectedRepositoryKey: "demo" } },
        { method: "factory_snapshot", input: { repositoryKey: "demo" } },
        { method: "factory_settings", input: { repositoryKey: "demo" } },
        { method: "factory_health", input: { repositoryKey: "demo" } },
        { method: "factory_interactions", input: { repositoryKey: "demo" } },
        { method: "factory_runs", input: { repositoryKey: "demo", limit: 50 } },
      ]);
    } finally {
      slot.lifecycle.unmount();
      runtime.__bbPluginRuntime.pluginSdkApp.useSettings = originalUseSettings;
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("owns a scrollable content region under a fixed header", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      const scroll = await slot.findByTestId("factory-scroll");
      expect(scroll.className).toMatch(/min-h-0/);
      expect(scroll.className).toMatch(/overflow-y-auto/);
      expect(scroll.parentElement?.querySelector("header")).not.toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("renders the standard Work view over an enabled Tasks-backed snapshot", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    controlledSettingsState = { values: { repositoryKey: "demo", tasksIntegration: "enabled" }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo", tasksIntegration: "enabled" } },
    );
    try {
      expect(await slot.findByText("Ready work")).toBeTruthy();
      expect(slot.queryByRole("heading", { name: "Native Tasks board" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("switches repositories through the segmented switcher while keeping the tab", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_repositories: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("Ready work");
      const switcher = await slot.findByRole("group", { name: "Configured repository" });
      const monorepoButton = within(switcher as HTMLElement).getByRole("button", { name: "monorepo" });
      expect(monorepoButton.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(within(switcher as HTMLElement).getByRole("button", { name: "data" }));
      await vi.waitFor(() => {
        expect(rpc.factory_repositories).toHaveBeenCalledTimes(2);
      });
      expect(rpc.factory_repositories).toHaveBeenNthCalledWith(2, { selectedRepositoryKey: "data" });
      await vi.waitFor(() => {
        for (const method of ["factory_snapshot", "factory_settings", "factory_health", "factory_interactions", "factory_runs"]) {
          const calls = slot.inspection.rpcCalls.filter((call) => call.method === method);
          expect(calls).toHaveLength(2);
          expect(calls[1]).toEqual(expect.objectContaining({ input: expect.objectContaining({ repositoryKey: "data" }) }));
        }
      });
      // The tab stays on Work for the newly selected repository.
      expect(slot.inspection.navigateCalls).not.toContainEqual(expect.objectContaining({ method: "toPluginPanel" }));
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("activates the All pill on the aggregate overview and navigates to overview on repository selection", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_repositories: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByRole("heading", { name: "Needs attention" });
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      const allPill = within(switcher).getByRole("button", { name: "All" });
      expect(allPill.getAttribute("aria-pressed")).toBe("true");
      expect(allPill.className).toContain("bg-background");
      for (const repositoryKey of ["monorepo", "data"]) {
        const pill = within(switcher).getByRole("button", { name: repositoryKey });
        expect(pill.getAttribute("aria-pressed")).toBe("false");
        expect(pill.className).not.toContain("shadow-sm");
      }

      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "overview" },
      });
      await vi.waitFor(() => {
        expect(rpc.factory_repositories).toHaveBeenCalledWith({ selectedRepositoryKey: "data" });
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("hides repo-scoped chrome on the repositories landing and restores it on a repo view", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const landing = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await landing.findByRole("heading", { name: "Needs attention" });
      const header = landing.container.querySelector("header") as HTMLElement;
      // The aggregate scope keeps its four union tabs but never repo chrome
      // or a Settings tab.
      const tablist = header.querySelector('[role="tablist"]') as HTMLElement;
      expect(tablist).not.toBeNull();
      expect(within(tablist).getAllByRole("tab")).toHaveLength(4);
      for (const name of ["Overview", "Work", "Questions", "Runs"]) {
        expect(within(tablist).getByRole("tab", { name: new RegExp(`^${name}`) })).toBeTruthy();
      }
      expect(within(tablist).queryByRole("tab", { name: "Settings" })).toBeNull();
      expect(within(header).queryByText("Global dispatch paused")).toBeNull();
      expect(within(header).queryByText(/@abcdef1/)).toBeNull();
      expect(within(header).queryByRole("button", { name: "Resume global dispatch" })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Run now" })).toBeNull();
      // The title and switcher stay; aggregate scope has no status or controls rows.
      expect(within(header).getByText("Factory")).toBeTruthy();
      expect(within(header).getByRole("group", { name: "Configured repository" })).toBeTruthy();
      expect(within(header).queryByRole("button", { name: /refreshed/ })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Chip legend" })).toBeNull();
    } finally {
      landing.lifecycle.unmount();
    }

    const overview = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await overview.findAllByText("Global dispatch paused");
      const header = overview.container.querySelector("header") as HTMLElement;
      expect(within(header).getByRole("tablist")).toBeTruthy();
      expect(within(header).getByText(/@abcdef1/)).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Resume global dispatch" })).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Run now" })).toBeTruthy();
    } finally {
      overview.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("navigates to overview when a switcher pill is clicked on the repositories landing", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_repositories: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByRole("heading", { name: "Needs attention" });
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "overview" },
      });
      await vi.waitFor(() => {
        expect(rpc.factory_repositories).toHaveBeenCalledWith({ selectedRepositoryKey: "data" });
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps the switcher mounted while a selection reload runs", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "data"
        ? new Promise((resolve) => { resolveSnapshot = resolve; })
        : snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_repositories: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("Ready work");
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      // The data snapshot is held pending: the pills must stay mounted and the
      // strip shows a subtle busy state instead of collapsing.
      const group = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      expect(within(group).getByRole("button", { name: "monorepo" })).toBeTruthy();
      expect(within(group).getByRole("button", { name: "data" })).toBeTruthy();
      expect(group.getAttribute("aria-busy")).toBe("true");
      expect(group.className).toContain("opacity-60");
      await act(async () => { resolveSnapshot?.(snapshotForSwitch("data")); });
      await vi.waitFor(async () => {
        const resolved = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
        expect(resolved.getAttribute("aria-busy")).toBe("false");
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps the selected repository when a registry write changes the settings identity", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_repositories: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("Ready work");
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      await vi.waitFor(() => {
        expect(rpc.factory_repositories).toHaveBeenLastCalledWith({ selectedRepositoryKey: "data" });
      });
      const callsAfterSelect = rpc.factory_repositories.mock.calls.length;

      // A registry write (e.g. a dispatch-pause toggle or an added repo) changes
      // the registry JSON. The selection override must survive it.
      const rewritten = JSON.stringify({
        repositories: [
          { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo", dispatchPaused: true },
          { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
        ],
        defaultRepositoryKey: "monorepo",
      });
      await act(async () => {
        controlledSettingsState = { values: { repositoryRegistry: rewritten }, isLoading: false };
        for (const subscriber of controlledSettingsSubscribers) subscriber();
      });
      await vi.waitFor(() => {
        expect(rpc.factory_repositories.mock.calls.length).toBeGreaterThan(callsAfterSelect);
      });
      expect(rpc.factory_repositories).toHaveBeenLastCalledWith({ selectedRepositoryKey: "data" });
      const selectedPill = within((await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement)
        .getByRole("button", { name: "data" });
      expect(selectedPill.getAttribute("aria-pressed")).toBe("true");
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("ignores realtime invalidations that name a different repository", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...baseRpc(),
      factory_snapshot: vi.fn(() => snapshotForSwitch("demo")),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_snapshot: ReturnType<typeof vi.fn> };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByText("Ready work");
      const initialCalls = rpc.factory_snapshot.mock.calls.length;
      await slot.behavior.emitRealtime("factory", { channel: "factory", kind: "run.changed", repositoryKey: "other-repo", revision, reason: "unrelated", durableReloadRequired: true });
      await act(async () => undefined);
      expect(rpc.factory_snapshot.mock.calls.length).toBe(initialCalls);
      await slot.behavior.emitRealtime("factory", { channel: "factory", kind: "repository.changed", repositoryKey: "demo", revision, reason: "mine", durableReloadRequired: true });
      await vi.waitFor(() => {
        expect(rpc.factory_snapshot.mock.calls.length).toBeGreaterThan(initialCalls);
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("reloads every durable projection after recovery and invalidation", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" }, realtimeConnectionState: "reconnecting" },
    );
    try {
      await slot.findByText("Factory");
      const readMethods = ["factory_repositories", "factory_snapshot", "factory_settings", "factory_health", "factory_interactions", "factory_runs"];
      await vi.waitFor(() => {
        for (const method of readMethods) expect(slot.inspection.rpcCalls.filter((call) => call.method === method)).toHaveLength(1);
      });

      await slot.behavior.setRealtimeConnectionState("connected");
      await vi.waitFor(() => {
        for (const method of readMethods) expect(slot.inspection.rpcCalls.filter((call) => call.method === method)).toHaveLength(2);
      });

      await slot.behavior.emitRealtime("factory", { channel: "factory", kind: "repository.changed", repositoryKey: "demo", revision, reason: "test invalidation", durableReloadRequired: true });
      await vi.waitFor(() => {
        for (const method of readMethods) expect(slot.inspection.rpcCalls.filter((call) => call.method === method)).toHaveLength(3);
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("shows tab badges for attention and resolves file links through the environment", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" }, openFilePreview: () => true },
    );
    try {
      const questionsTab = await slot.findByRole("tab", { name: /Questions/ });
      await vi.waitFor(() => {
        expect(questionsTab.textContent).toContain("1");
      });

      const dashboardLink = await slot.findByRole("link", { name: "plans/README.md" });
      fireEvent.click(dashboardLink);
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "experimental_openFilePreview",
        options: { target: { kind: "workspace", environmentId: "environment-1", path: "plans/README.md" }, location: null },
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("omits Run now while the selected repository has an active run", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const activeRun = { ...runSummary, status: "started" as const, finishedAt: null };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc: baseRpc({ runs: { runs: [activeRun], nextCursor: null } }), settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByRole("heading", { name: "Current run" });
      const header = slot.container.querySelector("header") as HTMLElement;
      expect(header.textContent).not.toContain("Run now");
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps the settings form mounted across a mutation-triggered reload and reseeds on a repository switch", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let saved = false;
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "monorepo" && saved
        ? { ...settingsProjection, settings: { ...settingsProjection.settings, repositoryKey, runtimeCapSeconds: 14400 } }
        : settingsForSwitch(repositoryKey)),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
      factory_update_settings: vi.fn(async () => {
        saved = true;
        return { ok: true, message: "saved" };
      }),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_settings: ReturnType<typeof vi.fn> };
    const registry = JSON.stringify({
      repositories: [
        { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
        { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
      ],
      defaultRepositoryKey: "monorepo",
    });
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "settings", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      const cap = (await slot.findByLabelText("Runtime cap (minutes)")) as HTMLInputElement;
      fireEvent.change(cap, { target: { value: "240" } });
      fireEvent.click(within(slot.container as HTMLElement).getByRole("button", { name: "Save" }));
      fireEvent.click(within(await slot.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
      expect(await slot.findByText("Saved")).toBeTruthy();

      // A concurrent unsaved edit must survive the projection swap too.
      fireEvent.change(await slot.findByLabelText("Time zone"), { target: { value: "America/Chicago" } });
      // The accepted mutation already triggered the reload; wait for the new
      // projection to land, then the saved field and the dirty field both hold.
      await vi.waitFor(() => expect(rpc.factory_settings.mock.calls.length).toBeGreaterThan(1));
      expect(((await slot.findByLabelText("Runtime cap (minutes)")) as HTMLInputElement).value).toBe("240");
      expect(((await slot.findByLabelText("Time zone")) as HTMLInputElement).value).toBe("America/Chicago");
      expect(await slot.findByText("Saved")).toBeTruthy();
      expect(slot.container.textContent).toContain("Unsaved changes");

      // A different repository still reseeds the form: no retained draft bleeds across.
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      await vi.waitFor(async () => {
        expect(((await slot.findByLabelText("Runtime cap (minutes)")) as HTMLInputElement).value).toBe("60");
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });
});

describe("Factory mode-equivalent projection", () => {
  it.each([
    ["repository", "work"],
    ["repository", "questions"],
    ["repository", "runs"],
    ["aggregate", "work"],
    ["aggregate", "questions"],
    ["aggregate", "runs"],
  ] as const)("keeps %s %s visible content and interactions equivalent", async (scope, section) => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const keys = scope === "repository" ? ["demo"] : ["monorepo", "data"];
    const projected = new Map<string, ProtocolSnapshot>();
    for (const key of keys) projected.set(key, await projectUiSnapshot(key));
    const disabled = new Map([...projected].map(([key, value]) => [key, disabledUiSnapshot(value)]));
    const subPath = scope === "repository" ? section : `all/${section}`;
    const settings: Record<string, string | number | boolean> = scope === "repository"
      ? { repositoryKey: "demo", tasksIntegration: "enabled" }
      : { repositoryRegistry: JSON.stringify({ repositories: [
          { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
          { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
        ], defaultRepositoryKey: "monorepo" }), tasksIntegration: "enabled" };
    const enabledRpc = modeEquivalenceRpc(scope, projected);
    controlledSettingsState = { values: settings, isLoading: false };
    const enabledSlot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath, panelPath: "factory" },
      { rpc: enabledRpc, settings },
    );
    let enabledText: string;
    let enabledResult: { kind: "action"; value: ReturnType<typeof submittedFactoryAction> } | { kind: "navigation"; value: unknown[] };
    try {
      if (section === "work") {
        await enabledSlot.findAllByText("Card-backed work");
        const workRow = enabledSlot.container.querySelector('[id$="work-FAC-1"]') as HTMLElement | null;
        if (!workRow) throw new Error("The projected Work row was not rendered.");
        fireEvent.click(within(workRow).getByRole("button", { name: "Approve" }));
        fireEvent.change(within(workRow).getByRole("textbox"), { target: { value: "same approval" } });
        const composerButtons = within(workRow).getAllByRole("button", { name: "Approve" });
        fireEvent.click(composerButtons[composerButtons.length - 1]!);
        const dialog = await enabledSlot.findByRole("alertdialog");
        expect(dialog.textContent).toContain("revision-bound ledger approval");
        fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Approve" }));
        await vi.waitFor(() => expect(enabledRpc.factory_action).toHaveBeenCalled());
        enabledResult = { kind: "action", value: submittedFactoryAction(enabledRpc) };
      } else if (section === "questions") {
        await enabledSlot.findAllByText("Real blocker context.");
        const answers = await enabledSlot.findAllByLabelText("Answer Q1");
        fireEvent.change(answers[0]!, { target: { value: "Use provider one." } });
        const recordButtons = await enabledSlot.findAllByRole("button", { name: "Record answer" });
        fireEvent.click(recordButtons[0]!);
        const dialog = await enabledSlot.findByRole("alertdialog");
        expect(dialog.textContent).toContain("factory ledger");
        fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Record answer" }));
        await vi.waitFor(() => expect(enabledRpc.factory_action).toHaveBeenCalled());
        enabledResult = { kind: "action", value: submittedFactoryAction(enabledRpc) };
      } else {
        const runLabels = await enabledSlot.findAllByText("FAC-1");
        const runButton = runLabels[0]?.closest("button");
        if (!runButton) throw new Error("The projected run row was not rendered.");
        fireEvent.click(runButton);
        enabledResult = {
          kind: "navigation",
          value: enabledSlot.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel"),
        };
      }
      enabledText = visibleFactoryText(enabledSlot);
    } finally {
      enabledSlot.lifecycle.unmount();
    }

    const disabledRpc = modeEquivalenceRpc(scope, disabled);
    controlledSettingsState = { values: { ...settings, tasksIntegration: "disabled" }, isLoading: false };
    const disabledSlot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath, panelPath: "factory" },
      { rpc: disabledRpc, settings: { ...settings, tasksIntegration: "disabled" } },
    );
    let disabledText: string;
    let disabledResult: { kind: "action"; value: ReturnType<typeof submittedFactoryAction> } | { kind: "navigation"; value: unknown[] };
    try {
      if (section === "work") {
        await disabledSlot.findAllByText("Card-backed work");
        const workRow = disabledSlot.container.querySelector('[id$="work-FAC-1"]') as HTMLElement | null;
        if (!workRow) throw new Error("The projected Work row was not rendered.");
        fireEvent.click(within(workRow).getByRole("button", { name: "Approve" }));
        fireEvent.change(within(workRow).getByRole("textbox"), { target: { value: "same approval" } });
        const composerButtons = within(workRow).getAllByRole("button", { name: "Approve" });
        fireEvent.click(composerButtons[composerButtons.length - 1]!);
        const dialog = await disabledSlot.findByRole("alertdialog");
        expect(dialog.textContent).toContain("queue.approved");
        fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Approve" }));
        await vi.waitFor(() => expect(disabledRpc.factory_action).toHaveBeenCalled());
        disabledResult = { kind: "action", value: submittedFactoryAction(disabledRpc) };
      } else if (section === "questions") {
        await disabledSlot.findAllByText("Real blocker context.");
        const answers = await disabledSlot.findAllByLabelText("Answer Q1");
        fireEvent.change(answers[0]!, { target: { value: "Use provider one." } });
        const recordButtons = await disabledSlot.findAllByRole("button", { name: "Record answer" });
        fireEvent.click(recordButtons[0]!);
        const dialog = await disabledSlot.findByRole("alertdialog");
        expect(dialog.textContent).toContain("questions.md");
        fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Record answer" }));
        await vi.waitFor(() => expect(disabledRpc.factory_action).toHaveBeenCalled());
        disabledResult = { kind: "action", value: submittedFactoryAction(disabledRpc) };
      } else {
        const runLabels = await disabledSlot.findAllByText("FAC-1");
        const runButton = runLabels[0]?.closest("button");
        if (!runButton) throw new Error("The projected run row was not rendered.");
        fireEvent.click(runButton);
        disabledResult = {
          kind: "navigation",
          value: disabledSlot.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel"),
        };
      }
      disabledText = visibleFactoryText(disabledSlot);
    } finally {
      disabledSlot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }

    expect(enabledText).toBe(disabledText);
    expect(enabledResult).toEqual(disabledResult);
  });
});

describe("Factory aggregate scope", () => {
  const aggregateRegistry = () => JSON.stringify({
    repositories: [
      { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
      { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
    ],
    defaultRepositoryKey: "monorepo",
  });
  const aggregateRpc = (snapshotFor: (key: string) => unknown = snapshotForSwitch) => ({
    ...baseRpc(),
    factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
    factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotFor(repositoryKey)),
    factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
    factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
    factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
    factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    factory_run_detail: vi.fn(({ repositoryKey, runId }: { repositoryKey: string; runId: string }) => ({
      run: { ...runDetail.run, summary: { ...runDetail.run.summary, repositoryKey, runId } },
    })),
  }) as unknown as PluginRpcTestHandlers<FactoryRpcContract> & {
    factory_snapshot: ReturnType<typeof vi.fn>;
    factory_run_detail: ReturnType<typeof vi.fn>;
  };
  const mountAggregate = (component: (props: FactoryViewProps) => unknown, subPath: string, rpc: PluginRpcTestHandlers<FactoryRpcContract>, tasksIntegration = false) => {
    const registry = aggregateRegistry();
    controlledSettingsState = { values: { repositoryRegistry: registry, ...(tasksIntegration ? { tasksIntegration: "enabled" } : {}) }, isLoading: false };
    return renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: component as never },
      { subPath, panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry }, openFilePreview: () => true },
    );
  };
  const groupFor = (slot: ReturnType<typeof renderSlot>, repositoryKey: string) =>
    Array.from(slot.container.querySelectorAll("section, details")).find(
      (section) => section.querySelector("h2")?.textContent === repositoryKey,
    ) as HTMLElement;

  const categoryFor = (slot: ReturnType<typeof renderSlot>, title: string) =>
    slot.getByRole("heading", { name: title }).closest("details") as HTMLElement;

  const overviewRepositoryFor = (slot: ReturnType<typeof renderSlot>, category: string, repositoryKey: string) =>
    within(categoryFor(slot, category)).getByRole("heading", { name: repositoryKey }).closest("details,section") as HTMLElement;

  it("renders a category-first compact overview with scoped rows and actions", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc();
    const slot = mountAggregate(FactoryView, "all/overview", rpc);
    try {
      await slot.findByRole("heading", { name: "Needs attention" });
      for (const category of ["Needs attention", "Work queue", "Questions", "Last run", "Dispatch"]) {
        const section = categoryFor(slot, category);
        expect(section).toBeTruthy();
        expect(within(section).getByRole("heading", { name: "monorepo" })).toBeTruthy();
        expect(within(section).getByRole("heading", { name: "data" })).toBeTruthy();
      }
      expect(slot.container.querySelectorAll("h2")).toHaveLength(15);
      expect(slot.queryByRole("heading", { name: "Technical details" })).toBeNull();
      expect(slot.queryByText("/work/monorepo")).toBeNull();
      expect(slot.queryByText("0 * * * *")).toBeNull();
      expect(slot.getAllByText("Every hour on the hour, every day")).toHaveLength(2);
      expect(slot.getAllByText("(UTC)")).toHaveLength(2);
      expect(slot.getAllByText("1 Ready")).toHaveLength(2);
      expect(slot.getAllByText("Which source is authoritative?")).toHaveLength(2);
      expect(within(overviewRepositoryFor(slot, "Questions", "monorepo")).getByRole("button", { name: "Open question Q1" })).toBeTruthy();
      expect(slot.queryByText("No repositories configured")).toBeNull();
      expect(slot.queryByText("Add a repository registry entry to start dispatching factory runs.")).toBeNull();

      const action = (rpc as unknown as { factory_action: ReturnType<typeof vi.fn> }).factory_action;
      fireEvent.click(within(overviewRepositoryFor(slot, "Needs attention", "monorepo")).getByRole("button", { name: "Resume" }));
      await vi.waitFor(() => {
        expect(action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "monorepo",
          expectedRevision: snapshotForSwitch("monorepo").revision,
          action: { kind: "resume" },
        }));
      });

      fireEvent.click(within(overviewRepositoryFor(slot, "Last run", "data")).getByRole("button", { name: "View run run-1" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "all/runs/data/run-1" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("uses the display name for aggregate repository headings without changing scoped identity", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc();
    vi.mocked(rpc.factory_repositories).mockImplementation((input: { selectedRepositoryKey?: string | null }) => {
      const selection = repositorySelectionForSwitch(input.selectedRepositoryKey);
      return {
        ...selection,
        repositories: selection.repositories.map((entry) => entry.configuration.repositoryKey === "monorepo"
          ? { ...entry, displayName: "Core repo" }
          : entry),
      };
    });
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      expect(await slot.findByRole("heading", { name: "Core repo" })).toBeTruthy();
      expect(slot.getByRole("heading", { name: "data" })).toBeTruthy();
      expect(slot.container.querySelector('[id="monorepo:work-ready-item"]')).not.toBeNull();
      expect(slot.container.querySelector('[id="Core repo:work-ready-item"]')).toBeNull();
      expect(slot.container.textContent).not.toContain("Repository 'Core repo'");
      expect((rpc.factory_snapshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ repositoryKey: "monorepo" });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps aggregate disclosure storage separate from a repository named all", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const repositoryNamedAll = { ...monorepoRepository, repositoryKey: "all" };
    const registry = JSON.stringify({
      repositories: [{ configuration: repositoryNamedAll, projectId: "project-all", environmentId: "environment-all" }],
      defaultRepositoryKey: "all",
    });
    const rpc = {
      ...baseRpc(),
      factory_repositories: vi.fn(() => ({
        repositories: [{
          configuration: repositoryNamedAll,
          projectId: "project-all",
          environmentId: "environment-all",
          dispatchPaused: false,
          selected: true,
          available: true,
          reasons: [],
          displayName: "All source",
        }],
        selectedRepositoryKey: "all",
      })),
      factory_snapshot: vi.fn(() => ({ ...snapshot, repository: repositoryNamedAll })),
      factory_settings: vi.fn(() => ({
        ...settingsProjection,
        settings: { ...settingsProjection.settings, repositoryKey: "all" },
      })),
      factory_health: vi.fn(() => ({ ...healthProjection, repositoryKey: "all" })),
      factory_interactions: vi.fn(() => ({ repositoryKey: "all", interactions: [] })),
      factory_runs: vi.fn(() => ({ runs: [{ ...runSummary, repositoryKey: "all" }], nextCursor: null })),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
    const mount = () => {
      controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
      return renderSlot<FactoryViewProps, FactoryRpcContract>(
        { component: FactoryView },
        { subPath: "all/overview", panelPath: "factory" },
        { rpc, settings: { repositoryRegistry: registry } },
      );
    };
    const aggregateStorageKey = "bb-factory:section:@aggregate:overview:needs-attention";
    const repositoryStorageKey = "bb-factory:section:all:overview:needs-attention";
    window.sessionStorage.removeItem(aggregateStorageKey);
    window.sessionStorage.removeItem(repositoryStorageKey);
    let slot: ReturnType<typeof renderSlot> | null = mount();
    try {
      const aggregate = await slot.findByRole("heading", { name: "Needs attention" });
      const aggregateDetails = aggregate.closest("details") as HTMLDetailsElement;
      const repository = within(aggregateDetails).getByRole("heading", { name: "All source" }).closest("details") as HTMLDetailsElement;
      fireEvent.click(repository.querySelector("summary") as HTMLElement);
      expect(repository.open).toBe(false);
      expect(window.sessionStorage.getItem(repositoryStorageKey)).toBe("0");
      expect(window.sessionStorage.getItem(aggregateStorageKey)).toBeNull();

      slot.lifecycle.unmount();
      slot = null;
      const reloaded = mount();
      try {
        const reloadedAggregate = await reloaded.findByRole("heading", { name: "Needs attention" });
        const reloadedDetails = reloadedAggregate.closest("details") as HTMLDetailsElement;
        const reloadedRepository = within(reloadedDetails).getByRole("heading", { name: "All source" }).closest("details") as HTMLDetailsElement;
        expect(reloadedDetails.open).toBe(true);
        expect(reloadedRepository.open).toBe(false);
      } finally {
        reloaded.lifecycle.unmount();
      }
    } finally {
      slot?.lifecycle.unmount();
      window.sessionStorage.removeItem(aggregateStorageKey);
      window.sessionStorage.removeItem(repositoryStorageKey);
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("settles aggregate overview groups independently while preserving loading and errors", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let resolveDataSnapshot: ((value: unknown) => void) | null = null;
    const loadingRpc = aggregateRpc((key) => key === "data"
      ? new Promise((resolve) => { resolveDataSnapshot = resolve; })
      : snapshotForSwitch(key));
    const loadingSlot = mountAggregate(FactoryView, "all/overview", loadingRpc);
    try {
      await loadingSlot.findByRole("heading", { name: "Work queue" });
      const monoGroup = overviewRepositoryFor(loadingSlot, "Work queue", "monorepo");
      const dataGroup = overviewRepositoryFor(loadingSlot, "Work queue", "data");
      expect(within(monoGroup).getByText("1 Ready")).toBeTruthy();
      expect(within(dataGroup).getByRole("status", { name: "Loading repository work" })).toBeTruthy();
      const attentionMonoGroup = overviewRepositoryFor(loadingSlot, "Needs attention", "monorepo");
      const attentionDataGroup = overviewRepositoryFor(loadingSlot, "Needs attention", "data");
      expect(within(attentionMonoGroup).getByRole("button", { name: "Resume" })).toBeTruthy();
      expect(within(attentionDataGroup).getByRole("status", { name: "Loading repository state" })).toBeTruthy();
      await act(async () => {
        resolveDataSnapshot?.(snapshotForSwitch("data"));
      });
      await loadingSlot.findAllByText("1 Ready");
      expect(within(overviewRepositoryFor(loadingSlot, "Work queue", "data")).getByText("1 Ready")).toBeTruthy();
    } finally {
      loadingSlot.lifecycle.unmount();
    }

    const errorRpc = aggregateRpc((key) => key === "data"
      ? (() => { throw new Error("data overview exploded"); })()
      : snapshotForSwitch(key));
    const errorSlot = mountAggregate(FactoryView, "all/overview", errorRpc);
    try {
      await errorSlot.findByRole("heading", { name: "Work queue" });
      const monoGroup = overviewRepositoryFor(errorSlot, "Work queue", "monorepo");
      const dataGroup = overviewRepositoryFor(errorSlot, "Work queue", "data");
      expect(within(monoGroup).getByText("1 Ready")).toBeTruthy();
      await within(dataGroup).findByText(/data overview exploded/);
      expect(within(dataGroup).getByRole("alert").textContent).toContain("data overview exploded");
      const attentionDataGroup = overviewRepositoryFor(errorSlot, "Needs attention", "data");
      expect(within(attentionDataGroup).getByText("Protocol files failed to parse")).toBeTruthy();
      expect(within(attentionDataGroup).getByRole("alert").textContent).toContain("data overview exploded");
    } finally {
      errorSlot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("renders enabled aggregate snapshot errors with retry instead of permanent loading", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc((key) => key === "data"
      ? (() => { throw new Error("data Tasks board unavailable"); })()
      : snapshotForSwitch(key));
    const slot = mountAggregate(FactoryView, "all/work", rpc, true);
    try {
      expect(await slot.findByText("Ready work")).toBeTruthy();
      expect(slot.queryByRole("heading", { name: "Native Tasks board" })).toBeNull();
      const dataGroup = groupFor(slot, "data");
      expect(within(dataGroup).getByRole("alert").textContent).toContain("data Tasks board unavailable");
      expect(within(dataGroup).getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(within(dataGroup).queryByRole("status")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps useful unhealthy repository details and scoped file links without paths", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...aggregateRpc(),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "data"
        ? {
            ...healthForSwitch(repositoryKey),
            host: {
              ...healthForSwitch(repositoryKey).host,
              ok: false,
              reasons: ["checkout is unavailable"],
            },
          }
        : healthForSwitch(repositoryKey)),
    };
    const slot = mountAggregate(FactoryView, "all/overview", rpc);
    try {
      const repositorySection = await slot.findByRole("heading", { name: "Repository" });
      const repositoryDetails = repositorySection.closest("details") as HTMLElement;
      const dataGroup = within(repositoryDetails).getByRole("heading", { name: "data" }).closest("details") as HTMLElement;
      expect(within(repositoryDetails).queryByRole("heading", { name: "monorepo" })).toBeNull();
      expect(within(dataGroup).getByText(/checkout is unavailable/)).toBeTruthy();
      expect(slot.queryByText("/work/data")).toBeNull();
      expect(slot.queryByText("a".repeat(64))).toBeNull();

      fireEvent.click(within(dataGroup).getByRole("link", { name: "Open current state" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "experimental_openFilePreview",
        options: { target: { kind: "workspace", environmentId: "environment-data", path: "plans/factory/current.md" }, location: null },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("reports a configured provider missing from health instead of blaming the host", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      ...aggregateRpc(),
      factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "data"
        ? {
            ...healthForSwitch(repositoryKey),
            providers: [],
          }
        : healthForSwitch(repositoryKey)),
    };
    const slot = mountAggregate(FactoryView, "all/overview", rpc);
    try {
      await slot.findByRole("heading", { name: "Dispatch" });
      const dispatch = categoryFor(slot, "Dispatch");
      const dataGroup = within(dispatch).getByRole("heading", { name: "data" }).closest("details") as HTMLElement;

      expect(within(dataGroup).getByText(/Preferred provider codex is not reported/)).toBeTruthy();
      expect(within(dataGroup).getByText("not reported")).toBeTruthy();
      expect(within(dataGroup).queryByText(/Host .* is online/)).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("unions every repository's work grouped by repository with scoped DOM ids and summed badges", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = mountAggregate(FactoryView, "all/work", aggregateRpc());
    try {
      await slot.findByRole("heading", { name: "monorepo" });
      await slot.findByRole("heading", { name: "data" });
      // Both repositories carry a queue entry with the same id; the scoped
      // idPrefix keeps the DOM ids distinct.
      expect(slot.container.querySelector('[id="monorepo:work-ready-item"]')).not.toBeNull();
      expect(slot.container.querySelector('[id="data:work-ready-item"]')).not.toBeNull();
      // The questions badge sums each repository's one open question.
      const questionsTab = await slot.findByRole("tab", { name: /Questions/ });
      await vi.waitFor(() => expect(questionsTab.textContent).toContain("2"));
      // Work is the active aggregate tab and no Settings tab exists.
      expect((await slot.findByRole("tab", { name: /^Work/ })).getAttribute("aria-selected")).toBe("true");
      expect(slot.container.querySelectorAll('[role="tab"]')).toHaveLength(4);
      expect(within(slot.container as HTMLElement).queryByRole("tab", { name: "Settings" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("orders aggregate status categories before repository subgroups", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const categorizedSnapshot = (key: string) => {
      const base = snapshotForSwitch(key);
      if (key === "monorepo") return {
        ...base,
        queue: [{ ...base.queue[0]!, id: "ready-mono" }],
        questions: [{ ...base.questions[0]!, id: "Q-mono" }],
      };
      return {
        ...base,
        queue: [{
          ...base.queue[0]!,
          id: "done-data",
          status: { kind: "done" as const, detail: "shipped" },
          eligible: false,
          eligibilityReasons: ["not-ready" as const],
        }],
        questions: [{ ...base.questions[0]!, id: "Q-data", answer: "answered" }],
      };
    };
    const pendingInteraction = {
      source: "bb-interaction" as const,
      interactionId: "interaction-1",
      threadId: "thr_1",
      turnId: "turn-1",
      status: "pending" as const,
      title: "Need a decision",
      prompt: "Choose one",
      createdAt: "2026-09-10T12:00:00Z",
      expiresAt: null,
      kind: "approval" as const,
      metadata: {
        kind: "approval" as const,
        availableDecisions: ["allow_once", "allow_for_session", "deny"] as Array<"allow_once" | "allow_for_session" | "deny">,
      },
    };
    const rpc = {
      ...aggregateRpc(categorizedSnapshot),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "monorepo"
        ? {
            repositoryKey,
            interactions: [pendingInteraction],
          }
        : { repositoryKey, interactions: [] }),
      factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "monorepo"
        ? { runs: [{ ...runSummary, repositoryKey, status: "started" as const, finishedAt: null }], nextCursor: null }
        : runsForSwitch(repositoryKey)),
    };

    const headings = (slot: ReturnType<typeof mountAggregate>) =>
      Array.from(slot.container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "");
    const workSlot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      await workSlot.findByRole("heading", { name: "Done" });
      const doneSection = workSlot.getByRole("heading", { name: "Done" }).closest("details") as HTMLDetailsElement;
      expect(doneSection.open).toBe(false);
      fireEvent.click(doneSection.querySelector("summary") as HTMLElement);
      const workHeadings = headings(workSlot);
      expect(workHeadings.indexOf("Ready")).toBeLessThan(workHeadings.indexOf("monorepo"));
      expect(workHeadings.indexOf("Done")).toBeLessThan(workHeadings.indexOf("data"));

      const dataSubgroup = workSlot.getByRole("heading", { name: "data" }).closest("details") as HTMLDetailsElement;
      expect(dataSubgroup.open).toBe(false);
    } finally {
      workSlot.lifecycle.unmount();
    }

    const questionsSlot = mountAggregate(FactoryView, "all/questions", rpc);
    try {
      const answeredHeading = await questionsSlot.findByRole("heading", { name: "Answered" });
      fireEvent.click(answeredHeading.closest("summary") as HTMLElement);
      await questionsSlot.findByRole("heading", { name: "data" });
      const questionHeadings = headings(questionsSlot);
      const bbIndex = questionHeadings.indexOf("BB questions");
      const openIndex = questionHeadings.indexOf("Open");
      const answeredIndex = questionHeadings.indexOf("Answered");
      expect(bbIndex).toBeGreaterThanOrEqual(0);
      expect(bbIndex).toBeLessThan(openIndex);
      expect(openIndex).toBeLessThan(answeredIndex);
      expect(questionHeadings.slice(bbIndex + 1)).toContain("monorepo");
      expect(questionHeadings.slice(openIndex + 1)).toContain("monorepo");
      expect(questionHeadings.slice(answeredIndex + 1)).toContain("data");
    } finally {
      questionsSlot.lifecycle.unmount();
    }

    const runsSlot = mountAggregate(FactoryView, "all/runs", rpc);
    try {
      await runsSlot.findByRole("heading", { name: "History" });
      const runHeadings = headings(runsSlot);
      expect(runHeadings.indexOf("Active")).toBeLessThan(runHeadings.indexOf("monorepo"));
      expect(runHeadings.indexOf("History")).toBeLessThan(runHeadings.indexOf("data"));
    } finally {
      runsSlot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("omits empty aggregate repository subgroups and keeps all-empty work explicit", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc((key) => key === "data"
      ? { ...snapshotForSwitch(key), queue: [], questions: [] }
      : snapshotForSwitch(key));
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      await slot.findByRole("heading", { name: "Ready" });
      expect(slot.container.querySelectorAll("h2")).toHaveLength(2);
      expect(slot.container.textContent).not.toContain("No work across configured repositories");
    } finally {
      slot.lifecycle.unmount();
    }

    const emptyRpc = {
      ...aggregateRpc(() => ({ ...snapshotForSwitch("monorepo"), queue: [], questions: [] })),
      factory_runs: vi.fn(() => ({ runs: [], nextCursor: null })),
    };
    const emptySlot = mountAggregate(FactoryView, "all/work", emptyRpc);
    try {
      await emptySlot.findByText("No work across configured repositories");
      expect(emptySlot.container.querySelectorAll("h2")).toHaveLength(0);
    } finally {
      emptySlot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps aggregate optimistic answers with their repository while another settles", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let resolveDataSnapshot: ((value: unknown) => void) | null = null;
    const rpc = {
      ...aggregateRpc((key) => key === "data"
        ? new Promise((resolve) => { resolveDataSnapshot = resolve; })
        : snapshotForSwitch(key)),
      factory_action: vi.fn(() => new Promise<unknown>(() => undefined)) as unknown as PluginRpcTestHandlers<FactoryRpcContract>["factory_action"],
    };
    const slot = mountAggregate(FactoryView, "all/questions", rpc);
    try {
      const monoGroup = await slot.findByRole("heading", { name: "monorepo" });
      const answer = await within(monoGroup.closest("details") as HTMLElement).findByLabelText("Answer Q1");
      fireEvent.change(answer, { target: { value: "Keep the existing provider." } });
      fireEvent.click(within(monoGroup.closest("details") as HTMLElement).getByRole("button", { name: "Record answer" }));
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Record answer" }));

      await slot.findByTestId("answered-questions");
      await act(async () => {
        resolveDataSnapshot?.(snapshotForSwitch("data"));
      });
      await slot.findByRole("heading", { name: "data" });

      const answered = slot.getByTestId("answered-questions") as HTMLDetailsElement;
      if (!answered.open) fireEvent.click(answered.querySelector("summary") as HTMLElement);
      const recorded = slot.container.querySelector('[id="monorepo:question-Q1"]') as HTMLElement;
      expect(recorded).not.toBeNull();
      expect(within(recorded).getByText("Recorded")).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("reveals every repository for a bare aggregate question anchor", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const slot = mountAggregate(FactoryView, "all/questions/question-Q1", aggregateRpc());
    try {
      await vi.waitFor(() => expect(scrollSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(document.getElementById("monorepo:question-Q1")?.closest("details")).toHaveProperty("open", true);
      expect(document.getElementById("data:question-Q1")?.closest("details")).toHaveProperty("open", true);
    } finally {
      slot.lifecycle.unmount();
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("navigates an aggregate interaction action to its scoped BB questions row", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const pendingInteraction = {
      source: "bb-interaction" as const,
      interactionId: "interaction-1",
      threadId: "thr_1",
      turnId: "turn-1",
      status: "pending" as const,
      title: "Need a decision",
      prompt: "Choose one",
      createdAt: "2026-09-10T12:00:00Z",
      expiresAt: null,
      kind: "approval" as const,
      metadata: {
        kind: "approval" as const,
        availableDecisions: ["allow_once", "allow_for_session", "deny"] as Array<"allow_once" | "allow_for_session" | "deny">,
      },
    };
    const rpc = {
      ...aggregateRpc(),
      factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => repositoryKey === "monorepo"
        ? { repositoryKey, interactions: [pendingInteraction] }
        : { repositoryKey, interactions: [] }),
    };
    const slot = mountAggregate(FactoryView, "all/overview", rpc);
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      await slot.findByText("Need a decision");
      const overviewInteraction = document.getElementById("monorepo:interaction-interaction-1") as HTMLElement;
      fireEvent.click(within(overviewInteraction).getByRole("button", { name: "Open interaction interaction-1" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "all/questions/monorepo%2Finteraction-interaction-1" },
      });

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "all/questions/monorepo/interaction-interaction-1", panelPath: "factory" }));
      });
      await vi.waitFor(() => {
        expect(document.getElementById("monorepo:interaction-interaction-1")).not.toBeNull();
      });
      const interactionRow = document.getElementById("monorepo:interaction-interaction-1") as HTMLElement;
      const repositoryGroup = interactionRow.closest("details");
      const bbGroup = repositoryGroup?.parentElement?.closest("details");
      expect(repositoryGroup).toHaveProperty("open", true);
      expect(bbGroup).toHaveProperty("open", true);
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("reopens the aggregate Open disclosure when a scoped question changes repositories", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc();
    const slot = mountAggregate(FactoryView, "all/questions/monorepo/question-Q1", rpc);
    try {
      const open = (await slot.findByRole("heading", { name: "Open" })).closest("details") as HTMLDetailsElement;
      expect(open.open).toBe(true);
      fireEvent.click(open.querySelector("summary") as HTMLElement);
      expect(open.open).toBe(false);

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "all/questions/data/question-Q1", panelPath: "factory" }));
      });
      await vi.waitFor(() => expect(open.open).toBe(true));
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("reopens the aggregate Answered disclosure when a scoped question changes repositories", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const answeredSnapshot = (key: string) => ({
      ...snapshotForSwitch(key),
      questions: snapshotForSwitch(key).questions.map((question) => ({ ...question, answer: "Recorded answer." })),
    });
    const rpc = aggregateRpc(answeredSnapshot);
    const slot = mountAggregate(FactoryView, "all/questions/monorepo/question-Q1", rpc);
    try {
      const answered = await slot.findByTestId("answered-questions") as HTMLDetailsElement;
      expect(answered.open).toBe(true);
      fireEvent.click(answered.querySelector("summary") as HTMLElement);
      expect(answered.open).toBe(false);

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "all/questions/data/question-Q1", panelPath: "factory" }));
      });
      await vi.waitFor(() => expect(answered.open).toBe(true));
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("pins an aggregate row action to its own repository and revision", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const dataRevision = { ...revision, protocolDigest: "d".repeat(64) };
    const approvalEntry = (id: string) => ({
      ...snapshot.queue[0]!,
      id,
      title: `${id} title`,
      status: { kind: "unknown" as const, raw: "draft" },
      approved: { kind: "none" as const, source: "none" as const },
      eligible: false,
      eligibilityReasons: ["not-ready" as const, "missing-authorization" as const],
    });
    const rpc = aggregateRpc((key) => key === "data"
      ? { ...snapshotForSwitch(key), revision: dataRevision, queue: [approvalEntry("data-task")] }
      : { ...snapshotForSwitch(key), queue: [approvalEntry("mono-task")] });
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      await slot.findByRole("heading", { name: "data" });
      const dataGroup = groupFor(slot, "data");
      await within(dataGroup).findByText("data-task title");
      fireEvent.click(within(dataGroup).getByRole("button", { name: "Approve" }));
      const input = await within(dataGroup).findByRole("textbox");
      fireEvent.change(input, { target: { value: "approved on data" } });
      const buttons = await within(dataGroup).findAllByRole("button", { name: "Approve" });
      fireEvent.click(buttons[buttons.length - 1]!);
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Approve" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "data",
          expectedRevision: dataRevision,
          action: { kind: "approve-queue", queueItemId: "data-task", approvedText: "approved on data" },
        }));
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps each repository's error and loading state independent", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc((key) => {
      if (key === "data") throw new Error("snapshot exploded");
      return snapshotForSwitch(key);
    });
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      // The healthy group renders its rows while the failed group shows its own error.
      await slot.findByRole("heading", { name: "monorepo" });
      const monoGroup = groupFor(slot, "monorepo");
      await within(monoGroup).findByText("Ready work");
      await slot.findByRole("heading", { name: "data" });
      const dataGroup = groupFor(slot, "data");
      await within(dataGroup).findByText("snapshot exploded");
      expect(within(dataGroup).getByRole("button", { name: /retry/i })).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("pins aggregate run detail to its repository and returns to the aggregate runs list", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = aggregateRpc();
    vi.mocked(rpc.factory_repositories).mockImplementation((input: { selectedRepositoryKey?: string | null }) => {
      const selection = repositorySelectionForSwitch(input.selectedRepositoryKey);
      return {
        ...selection,
        repositories: selection.repositories.map((entry) => entry.configuration.repositoryKey === "data"
          ? { ...entry, displayName: "Data platform" }
          : entry),
      };
    });
    const slot = mountAggregate(FactoryView, "all/runs", rpc);
    try {
      await slot.findByRole("heading", { name: "Data platform" });
      const dataGroup = Array.from(slot.container.querySelectorAll("section, details")).find(
        (section) => section.querySelector("h2")?.textContent === "Data platform",
      ) as HTMLElement;
      // The history row is a button keyed by its queue-item chip.
      const row = (await within(dataGroup).findByText("ready-item")).closest("button") as HTMLElement;
      fireEvent.click(row);
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "all/runs/data/run-1" },
      });

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "all/runs/data/run-1", panelPath: "factory" }));
      });
      await vi.waitFor(() => {
        expect(rpc.factory_run_detail).toHaveBeenCalledWith(expect.objectContaining({ repositoryKey: "data", runId: "run-1" }));
      });
      fireEvent.click(await slot.findByRole("button", { name: "Back to runs" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "all/runs" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("keeps aggregate pending state scoped by raw repository key when labels differ", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const actionResolver = { current: null as ((value: unknown) => void) | null };
    const rpc = {
      ...aggregateRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => {
        const selection = repositorySelectionForSwitch(input.selectedRepositoryKey);
        return {
          ...selection,
          repositories: selection.repositories.map((entry) => entry.configuration.repositoryKey === "data"
            ? { ...entry, displayName: "Data platform" }
            : entry),
        };
      }),
      factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({
        ...settingsForSwitch(repositoryKey),
        dispatch: { ...settingsForSwitch(repositoryKey).dispatch, mode: "paused" as const },
      })),
      factory_action: vi.fn(() => new Promise((resolve) => { actionResolver.current = resolve; })),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & {
      factory_action: ReturnType<typeof vi.fn>;
    };
    const slot = mountAggregate(FactoryView, "all/overview", rpc);
    try {
      const needsAttention = (await slot.findByRole("heading", { name: "Needs attention" })).closest("details") as HTMLElement;
      const dataGroup = within(needsAttention).getByRole("heading", { name: "Data platform" }).closest("details") as HTMLElement;
      const dataResume = within(dataGroup).getByRole("button", { name: "Resume" });
      fireEvent.click(dataResume);
      await vi.waitFor(() => expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
        repositoryKey: "data",
        action: { kind: "resume" },
      })));
      await vi.waitFor(() => {
        const currentAttention = slot.getByRole("heading", { name: "Needs attention" }).closest("details") as HTMLElement;
        const currentDataGroup = within(currentAttention).getByRole("heading", { name: "Data platform" }).closest("details") as HTMLElement;
        expect(within(currentDataGroup).getByRole("button", { name: "Working..." })).toHaveProperty("disabled", true);
      });
      const currentAttention = slot.getByRole("heading", { name: "Needs attention" }).closest("details") as HTMLElement;
      const currentMonoGroup = within(currentAttention).getByRole("heading", { name: "monorepo" }).closest("details") as HTMLElement;
      expect(within(currentMonoGroup).getByRole("button", { name: "Resume" })).toHaveProperty("disabled", false);
    } finally {
      actionResolver.current?.({
        ok: true,
        revision,
        result: {
          status: "accepted",
          message: "resumed",
          revision,
          runId: null,
          leaseId: null,
          queueItemId: null,
          action: "resume",
          questionId: null,
          interactionId: null,
        },
      });
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("selects a repository pill from All and keeps the same tab", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = mountAggregate(FactoryView, "all/work", aggregateRpc());
    try {
      await slot.findByRole("heading", { name: "monorepo" });
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      fireEvent.click(within(switcher).getByRole("button", { name: "data" }));
      // From the aggregate the pill navigates to the same tab repo-scoped.
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "work" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("never shows a retained detail whose concat key would collide with the current route", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    // repo "a" + run "bc" and repo "ab" + run "c" concatenate identically; the
    // gate key must stay unambiguous or the retained detail would bleed across.
    const repoA = { ...repository, repositoryKey: "a", repositoryRoot: "/work/a", checkoutPath: "/work/a" };
    const repoAB = { ...repository, repositoryKey: "ab", repositoryRoot: "/work/ab", checkoutPath: "/work/ab" };
    const registry = JSON.stringify({
      repositories: [
        { configuration: repoA, projectId: "project-a", environmentId: "environment-a" },
        { configuration: repoAB, projectId: "project-ab", environmentId: "environment-ab" },
      ],
      defaultRepositoryKey: "a",
    });
    const rpc = {
      ...aggregateRpc(),
      factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => ({
        repositories: [repoA, repoAB].map((configuration) => ({
          configuration,
          projectId: `project-${configuration.repositoryKey}`,
          environmentId: `environment-${configuration.repositoryKey}`,
          dispatchPaused: false,
          selected: configuration.repositoryKey === (input.selectedRepositoryKey ?? "a"),
          available: true,
          reasons: [],
        })),
        selectedRepositoryKey: input.selectedRepositoryKey ?? "a",
      })),
      factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey === "ab" ? "data" : "monorepo")),
      // The ab/c fetch is withheld: if the gate mis-keys, the stale a/bc detail shows.
      factory_run_detail: vi.fn(({ repositoryKey, runId }: { repositoryKey: string; runId: string }) =>
        repositoryKey === "a" && runId === "bc"
          ? { run: { ...runDetail.run, summary: { ...runDetail.run.summary, repositoryKey: "a", runId: "bc", queueItemIds: ["MARKER-TASK"] } } }
          : new Promise(() => undefined)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_run_detail: ReturnType<typeof vi.fn> };
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "all/runs/a/bc", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("MARKER-TASK");
      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "all/runs/ab/c", panelPath: "factory" }));
      });
      await vi.waitFor(() => {
        expect(rpc.factory_run_detail).toHaveBeenCalledWith(expect.objectContaining({ repositoryKey: "ab", runId: "c" }));
      });
      expect(slot.container.textContent).not.toContain("MARKER-TASK");
      expect(await slot.findByLabelText("Loading run detail")).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("drops a stale repository response that lands after a selection change", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let resolveStale: ((value: unknown) => void) | null = null;
    const rpc = aggregateRpc((key) => key === "monorepo"
      ? new Promise((resolve) => { resolveStale = resolve; })
      : { ...snapshotForSwitch(key), queue: [{ ...snapshot.queue[0]!, id: "data-only", title: "DATA-ONLY-TASK" }] });
    const slot = mountAggregate(FactoryView, "work", rpc);
    try {
      // The switcher group paints before the repositories read lands; wait on the pill itself.
      fireEvent.click(await slot.findByRole("button", { name: "data" }));
      await slot.findByText("DATA-ONLY-TASK");
      // The monorepo read from the superseded load resolves late and must not paint.
      await act(async () => {
        resolveStale?.({ ...snapshotForSwitch("monorepo"), queue: [{ ...snapshot.queue[0]!, id: "mono-only", title: "MONO-ONLY-TASK" }] });
      });
      await vi.waitFor(() => expect(slot.container.textContent).toContain("DATA-ONLY-TASK"));
      expect(slot.container.textContent).not.toContain("MONO-ONLY-TASK");
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("renders a settled repository group while another repository is still loading", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    let resolveSlow: ((value: unknown) => void) | null = null;
    const rpc = aggregateRpc((key) => key === "data"
      ? new Promise((resolve) => { resolveSlow = resolve as (value: unknown) => void; })
      : { ...snapshotForSwitch(key), queue: [{ ...snapshot.queue[0]!, id: "mono-only", title: "FAST-REPO-TASK" }] });
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      // The finished repository paints its work rather than waiting on the
      // slow repository's bundle.
      await slot.findByText("FAST-REPO-TASK");
      const dataGroup = groupFor(slot, "data");
      expect(within(dataGroup).getByRole("status", { name: "Loading repository work" })).toBeTruthy();
      await act(async () => {
        resolveSlow?.({ ...snapshotForSwitch("data"), queue: [{ ...snapshot.queue[0]!, id: "data-only", title: "SLOW-REPO-TASK" }] });
      });
      await slot.findByText("SLOW-REPO-TASK");
      expect(slot.container.textContent).toContain("FAST-REPO-TASK");
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("never lets a superseded aggregate bundle commit into the current scope", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const dataSnapshotWith = (title: string) => ({
      ...snapshotForSwitch("data"),
      queue: [{ ...snapshot.queue[0]!, id: "data-only", title }],
    });
    let dataCalls = 0;
    let resolveStale: ((value: unknown) => void) | null = null;
    const rpc = aggregateRpc((key) => {
      if (key !== "data") return snapshotForSwitch(key);
      dataCalls += 1;
      // The second load hangs; the third supersedes it with fresh data.
      if (dataCalls === 2) return new Promise((resolve) => { resolveStale = resolve as (value: unknown) => void; });
      return dataSnapshotWith(dataCalls === 1 ? "FIRST-DATA-TASK" : "CURRENT-DATA-TASK");
    });
    const slot = mountAggregate(FactoryView, "all/work", rpc);
    try {
      await slot.findByText("FIRST-DATA-TASK");
      await slot.emitRealtime("factory", null);
      await vi.waitFor(() => expect(dataCalls).toBe(2));
      await slot.emitRealtime("factory", null);
      await slot.findByText("CURRENT-DATA-TASK");
      // The superseded load's bundle lands last and must not overwrite the
      // group the current load already committed.
      await act(async () => { resolveStale?.(dataSnapshotWith("STALE-DATA-TASK")); });
      await vi.waitFor(() => expect(slot.container.textContent).toContain("CURRENT-DATA-TASK"));
      expect(slot.container.textContent).not.toContain("STALE-DATA-TASK");
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });
});

describe("Factory guarded actions", () => {
  const blockedSnapshot = {
    ...snapshot,
    queue: [{
      ...snapshot.queue[0]!,
      id: "draft-item",
      title: "Draft work",
      status: { kind: "unknown" as const, raw: "draft" },
      approved: { kind: "none" as const, source: "none" as const },
      blockedBy: [],
      blockingQuestionIds: [],
      eligible: false,
      eligibilityReasons: ["not-ready" as const, "missing-authorization" as const],
    }],
  };

  it("submits a guarded queue approval through the confirm dialog", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc({ snapshot: blockedSnapshot });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const approveCta = await slot.findByRole("button", { name: "Approve" });
      fireEvent.click(approveCta);
      const input = await slot.findByRole("textbox");
      fireEvent.change(input, { target: { value: "no gated actions" } });
      const approveButtons = await slot.findAllByRole("button", { name: "Approve" });
      fireEvent.click(approveButtons[approveButtons.length - 1]!);
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Approve" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          expectedRevision: revision,
          action: { kind: "approve-queue", queueItemId: "draft-item", approvedText: "no gated actions" },
        }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("sends a question to an agent and opens the spawned chat", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc();
    rpc.factory_action = vi.fn(() => ({
      ok: true as const,
      revision,
      result: {
        status: "accepted" as const,
        message: "Started a recommendation chat for Q1 on codex (gpt-5).",
        revision,
        runId: null,
        leaseId: null,
        queueItemId: null,
        action: "recommend-question" as const,
        questionId: "Q1",
        interactionId: null,
        threadId: "thr_rec",
      },
    }));
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "questions", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const ask = await slot.findByRole("button", { name: "Ask an agent" });
      fireEvent.click(ask);
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Start chat" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          expectedRevision: revision,
          action: { kind: "recommend-question", questionId: "Q1", providerId: "codex", model: "gpt-5", reasoningLevel: "medium" },
        }));
      });
      await vi.waitFor(() => {
        expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_rec" });
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps ready queue entries free of approval controls", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByText("Ready work");
      const buttons = Array.from(slot.container.querySelectorAll("button"));
      expect(buttons.some((button) => button.textContent === "Approve")).toBe(false);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("dispatches run-now from the shell header after confirming", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc({ settings: enabledSettings });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Run now" }));
      const dialog = await slot.findByRole("alertdialog");
      expect(dialog.textContent).toContain("ignoring the night window");
      // Automatic is the default: the seeded picker stays dormant until chosen,
      // so confirming sends no override and rotation still applies.
      expect((within(dialog as HTMLElement).getByRole("radio", { name: "Automatic" }) as HTMLInputElement).checked).toBe(true);
      expect(within(dialog as HTMLElement).queryByTestId("bb-provider-model-picker")).toBeNull();
      expect(dialog.textContent).toContain("Provider: codex (available).");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Run now" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          expectedRevision: revision,
          action: { kind: "run-now" },
        }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("sends the picked provider, model, thinking level, and service tier on run-now", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc({ settings: enabledSettings });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Run now" }));
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("radio", { name: "Choose provider and model" }));
      const picker = within(dialog as HTMLElement).getByTestId("bb-provider-model-picker");
      expect(picker.getAttribute("data-routing-kind")).toBe("environment");
      expect(picker.getAttribute("data-routing-id")).toBe("environment-1");
      expect((within(picker).getByLabelText("Provider ID") as HTMLInputElement).value).toBe("codex");
      expect((within(picker).getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-5");
      expect((within(picker).getByLabelText("Reasoning level") as HTMLInputElement).value).toBe("medium");
      fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "claude-code" } });
      fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "claude-sonnet-4" } });
      fireEvent.change(within(picker).getByLabelText("Reasoning level"), { target: { value: "high" } });
      fireEvent.change(within(picker).getByLabelText("Service tier"), { target: { value: "fast" } });
      fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Run now" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          action: {
            kind: "run-now",
            providerId: "claude-code",
            model: "claude-sonnet-4",
            reasoningLevel: "high",
            serviceTier: "fast",
          },
        }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("disables run-now and offers resume while dispatch is paused", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc();
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const runNow = await slot.findByRole("button", { name: "Run now" });
      expect((runNow as HTMLButtonElement).disabled).toBe(true);
      expect(runNow.getAttribute("title")).toContain("paused");
      const header = slot.container.querySelector("header")!;
      fireEvent.click(within(header as HTMLElement).getByRole("button", { name: "Resume global dispatch" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: "resume" } }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps run-now usable when the repository snapshot fails to parse", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc({ settings: enabledSettings, snapshotError: "malformed queue" });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "overview", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Run now" }));
      const dialog = await slot.findByRole("alertdialog");
      fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Run now" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          action: { kind: "run-now" },
        }));
      });
      const call = rpc.factory_action.mock.calls[0]?.[0] as { expectedRevision?: unknown };
      expect(call.expectedRevision).toBeUndefined();
    } finally {
      slot.lifecycle.unmount();
    }
  });
});

describe("Add-repository wizard chrome", () => {
  const wizardRpc = (
    hosts: Array<{ hostId: string; label: string | null; status: string }> = [
      { hostId: "host-1", label: "Workstation", status: "connected" },
    ],
  ) => ({
    ...baseRpc(),
    factory_repositories: vi.fn((input: { selectedRepositoryKey?: string | null }) => repositorySelectionForSwitch(input.selectedRepositoryKey)),
    factory_snapshot: vi.fn(({ repositoryKey }: { repositoryKey: string }) => snapshotForSwitch(repositoryKey)),
    factory_settings: vi.fn(({ repositoryKey }: { repositoryKey: string }) => settingsForSwitch(repositoryKey)),
    factory_health: vi.fn(({ repositoryKey }: { repositoryKey: string }) => healthForSwitch(repositoryKey)),
    factory_interactions: vi.fn(({ repositoryKey }: { repositoryKey: string }) => ({ repositoryKey, interactions: [] })),
    factory_runs: vi.fn(({ repositoryKey }: { repositoryKey: string }) => runsForSwitch(repositoryKey)),
    factory_registry_options: () => ({ hosts, projects: [] }),
    factory_pick_folder: vi.fn(async () => ({ hostId: "host-1", path: null })),
    factory_probe_repository: vi.fn(async () => ({
      hostId: "host-1",
      path: "/work/newrepo",
      isGitRepo: true,
      hasProtocol: false,
      currentBranch: "main",
      suggestedKey: "newrepo",
      mainRef: "origin/main",
      checkoutSuggestion: "/work/newrepo-factory",
      projectMatch: null,
      factoryBranchState: { exists: false, checkedOutPath: null },
    })),
    factory_resolve_project: vi.fn(async () => ({ projectId: "proj-9", label: "newrepo", created: true })),
  }) as unknown as PluginRpcTestHandlers<FactoryRpcContract>;

  const twoRepoRegistry = () => JSON.stringify({
    repositories: [
      { configuration: monorepoRepository, projectId: "project-monorepo", environmentId: "environment-monorepo" },
      { configuration: dataRepository, projectId: "project-data", environmentId: "environment-data" },
    ],
    defaultRepositoryKey: "monorepo",
  });

  it("suppresses repo chrome and switcher selection on the wizard, and Back restores the opening tab", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const registry = twoRepoRegistry();
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc: wizardRpc(), settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("Ready work");
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      expect(within(switcher).getByRole("button", { name: "monorepo" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.click((await slot.findAllByRole("button", { name: "Add repository" }))[0]!);
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "repositories/new" },
      });

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "repositories/new", panelPath: "factory" }));
      });
      await slot.findByRole("button", { name: "Choose repository folder" });

      const header = slot.container.querySelector("header") as HTMLElement;
      expect(header.querySelector('[role="tablist"]')).toBeNull();
      expect(within(header).queryByText("Global dispatch paused")).toBeNull();
      expect(within(header).queryByText(/@abcdef1/)).toBeNull();
      expect(within(header).queryByRole("button", { name: "Pause global dispatch" })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Resume global dispatch" })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Run now" })).toBeNull();
      // The title and switcher stay mounted; the wizard has no status or controls rows.
      expect(within(header).getByText("Factory")).toBeTruthy();
      expect(within(header).queryByRole("button", { name: /refreshed/ })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Chip legend" })).toBeNull();

      const wizardSwitcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      const allPill = within(wizardSwitcher).getByRole("button", { name: "All" });
      expect(allPill.getAttribute("aria-pressed")).toBe("false");
      expect(allPill.className).not.toContain("bg-background");
      for (const repositoryKey of ["monorepo", "data"]) {
        const pill = within(wizardSwitcher).getByRole("button", { name: repositoryKey });
        expect(pill.getAttribute("aria-pressed")).toBe("false");
        expect(pill.className).not.toContain("shadow-sm");
      }
      expect(((await slot.findByRole("combobox", { name: "Configured repository" })) as HTMLSelectElement).value).toBe("");

      fireEvent.click(await slot.findByRole("button", { name: "Back" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "work" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("restores the repositories landing when the wizard was opened from it", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const registry = twoRepoRegistry();
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories", panelPath: "factory" },
      { rpc: wizardRpc(), settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByRole("heading", { name: "Needs attention" });
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      expect(within(switcher).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(within(switcher).getByRole("button", { name: "Add repository" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "repositories/new" },
      });

      await act(async () => {
        slot.rerender(createElement(FactoryView, { subPath: "repositories/new", panelPath: "factory" }));
      });
      await slot.findByRole("button", { name: "Choose repository folder" });
      // The wizard is not the landing: All loses its active state too.
      const wizardSwitcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      expect(within(wizardSwitcher).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(await slot.findByRole("button", { name: "Back" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "repositories" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("lands Back on the repositories landing for a deep-linked wizard and names the resolved host", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const registry = twoRepoRegistry();
    controlledSettingsState = { values: { repositoryRegistry: registry }, isLoading: false };
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories/new", panelPath: "factory" },
      { rpc: wizardRpc(), settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByText("Choose the folder on this machine (Workstation).");
      expect(slot.container.textContent).not.toContain("folder picker opens on");
      const header = slot.container.querySelector("header") as HTMLElement;
      expect(header.querySelector('[role="tablist"]')).toBeNull();
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      expect(within(switcher).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(await slot.findByRole("button", { name: "Back" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "all/overview" },
      });
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("falls back to the host id in the folder-pick copy when the resolved host has no label", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "repositories/new", panelPath: "factory" },
      { rpc: wizardRpc([{ hostId: "host-7", label: null, status: "connected" }]), settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByText("Choose the folder on this machine (host-7).");
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
