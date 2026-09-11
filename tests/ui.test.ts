// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
    expect(parseFactoryRoute("repositories")).toMatchObject({ section: "repositories" });
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

  it("activates the All pill on the repositories landing and navigates to overview on a card click", async () => {
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
      await slot.findByText("Repositories");
      const switcher = (await slot.findByRole("group", { name: "Configured repository" })) as HTMLElement;
      const allPill = within(switcher).getByRole("button", { name: "All" });
      expect(allPill.getAttribute("aria-pressed")).toBe("true");
      expect(allPill.className).toContain("bg-background");
      for (const repositoryKey of ["monorepo", "data"]) {
        const pill = within(switcher).getByRole("button", { name: repositoryKey });
        expect(pill.getAttribute("aria-pressed")).toBe("false");
        expect(pill.className).not.toContain("shadow-sm");
      }

      const scroll = (await slot.findByTestId("factory-scroll")) as HTMLElement;
      fireEvent.click(within(scroll).getByRole("button", { name: /^data\b/ }));
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
      await landing.findByText("Repositories");
      const header = landing.container.querySelector("header") as HTMLElement;
      // Repo-scoped chrome must not render above the landing.
      expect(header.querySelector('[role="tablist"]')).toBeNull();
      expect(within(header).queryByText("Dispatch paused")).toBeNull();
      expect(within(header).queryByText(/@abcdef1/)).toBeNull();
      expect(within(header).queryByRole("button", { name: "Resume" })).toBeNull();
      expect(within(header).queryByRole("button", { name: "Run now" })).toBeNull();
      // The title, switcher, refreshed indicator, and legend stay.
      expect(within(header).getByText("Factory")).toBeTruthy();
      expect(within(header).getByRole("group", { name: "Configured repository" })).toBeTruthy();
      expect(within(header).getByText(/refreshed/)).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Chip legend" })).toBeTruthy();
    } finally {
      landing.lifecycle.unmount();
    }

    const overview = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await overview.findByText("Dispatch paused");
      const header = overview.container.querySelector("header") as HTMLElement;
      expect(within(header).getByRole("tablist")).toBeTruthy();
      expect(within(header).getByText(/@abcdef1/)).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Resume" })).toBeTruthy();
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
      await slot.findByText("Repositories");
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
      { subPath: "", panelPath: "factory" },
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
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Run now" }));
      const dialog = await slot.findByRole("alertdialog");
      expect(dialog.textContent).toContain("ignoring the night window");
      expect(dialog.textContent).toContain("codex");
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

  it("disables run-now and offers resume while dispatch is paused", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = baseRpc();
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const runNow = await slot.findByRole("button", { name: "Run now" });
      expect((runNow as HTMLButtonElement).disabled).toBe(true);
      expect(runNow.getAttribute("title")).toContain("paused");
      const header = slot.container.querySelector("header")!;
      fireEvent.click(within(header as HTMLElement).getByRole("button", { name: "Resume" }));
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
      { subPath: "", panelPath: "factory" },
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
