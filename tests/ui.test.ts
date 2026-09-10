// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { createElement, useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FactoryViewProps } from "../src/ui/FactoryView.js";
import type { FactoryRpcContract } from "../src/rpc.js";
import {
  Badge,
  ConnectionBanner,
  ErrorNotice,
  QueueView,
  RepositorySelectionView,
  RunsView,
  formatEligibilityReason,
  parseFactoryRoute,
  runStatusLabel,
} from "../src/ui/views.js";

const h = createElement;

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
      eligible: true,
      eligibilityReasons: [],
    },
  ],
  questions: [],
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
  repositories: [{ configuration: repository, selected: true, available: true, reasons: [] }],
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
  dispatch: { mode: "paused" as const, acceptingNewRuns: false, activeRunCount: 0, reason: null },
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

beforeAll(() => {
  installTestPluginRuntime();
});

describe("Factory read-only UI helpers", () => {
  it("parses semantic panel routes and safely decodes run ids", () => {
    expect(parseFactoryRoute("")).toEqual({ section: "overview", runId: null });
    expect(parseFactoryRoute("runs/run%2F2026")).toEqual({ section: "runs", runId: "run/2026" });
    expect(parseFactoryRoute("unexpected/path")).toEqual({ section: "not-found", raw: "unexpected/path" });
  });

  it("explains frozen queue eligibility reasons and run statuses", () => {
    expect(formatEligibilityReason("missing-authorization")).toContain("approval");
    expect(runStatusLabel("failed-safe")).toBe("Failed safe");
  });

  it("renders repository-backed queue detail and read-only run links", () => {
    const queueMarkup = renderToStaticMarkup(h(QueueView, { snapshot }));
    expect(queueMarkup).toContain("Repository-backed queue");
    expect(queueMarkup).toContain("All recorded eligibility checks pass.");
    expect(queueMarkup).toContain("plans/ready.md");
    expect(queueMarkup).toContain("queue.approved");
    expect(queueMarkup).toContain("approved by Adam");

    const runsMarkup = renderToStaticMarkup(h(RunsView, {
      runs: [{
        runId: "run-1",
        repositoryKey: "demo",
        requestedAt: "2026-09-10T12:00:00Z",
        startedAt: null,
        finishedAt: null,
        providerId: null,
        workerThreadId: null,
        projectId: null,
        environmentId: null,
        status: "pending" as const,
        queueItemIds: ["ready-item"],
        repositoryRevision: revision,
        canonicalRecords: [],
      }],
      nextCursor: null,
      onOpenRun: () => undefined,
      onOpenThread: () => undefined,
      onOpenProject: () => undefined,
    }));
    expect(runsMarkup).toContain("Thread pending");
    expect(runsMarkup).toContain("Environment pending");
    expect(runsMarkup).toContain("Canonical records: 0");
  });

  it("shows terminal queue items as done instead of blocked", () => {
    const completedSnapshot = {
      ...snapshot,
      queue: [{ ...snapshot.queue[0]!, status: { kind: "done" as const, detail: "Completed" }, eligible: false, eligibilityReasons: ["not-ready" as const] }],
    };
    const markup = renderToStaticMarkup(h(QueueView, { snapshot: completedSnapshot }));
    expect(markup).toContain(">Done: Completed</span>");
    expect(markup).not.toContain(">Blocked</span>");
  });

  it("uses host token classes for semantic status badges", () => {
    const markup = renderToStaticMarkup(h(Badge, { label: "Healthy", tone: "success" }));
    expect(markup).toContain("bg-success/10");
    expect(markup).toContain("text-success");
  });

  it("keeps disconnected and malformed-read states actionable", () => {
    const disconnected = renderToStaticMarkup(h(ConnectionBanner, { state: "reconnecting", malformedSignal: false }));
    expect(disconnected).toContain("Durable state will reload when it reconnects.");

    const malformed = renderToStaticMarkup(h(ErrorNotice, { message: "snapshot returned malformed data", onRetry: () => undefined }));
    expect(malformed).toContain("snapshot returned malformed data");
    expect(malformed).toContain(">Retry</button>");

    const noRepository = renderToStaticMarkup(h(RepositorySelectionView, { projection: { repositories: [], selectedRepositoryKey: null } }));
    expect(noRepository).toContain("Configure a repository in the host settings");
  });

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
    const rpc = {
      factory_repositories: () => repositorySelection,
      factory_snapshot: () => snapshot,
      factory_settings: () => settingsProjection,
      factory_health: () => healthProjection,
      factory_interactions: () => ({ repositoryKey: "demo", interactions: [] }),
      factory_runs: () => ({ runs: [runSummary], nextCursor: null }),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      await act(async () => undefined);
      expect(slot.inspection.rpcCalls).toHaveLength(0);

      await act(async () => {
        controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
        for (const subscriber of controlledSettingsSubscribers) subscriber();
      });
      await slot.findByRole("heading", { name: "Repository health" });

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

  it("switches multiple configured repositories through the accessible local selector", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
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
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryRegistry: registry } },
    );
    try {
      await slot.findByRole("heading", { name: "monorepo" });
      const selector = await slot.findByRole("combobox", { name: "Configured repository" });
      expect((selector as HTMLSelectElement).value).toBe("monorepo");

      fireEvent.change(selector, { target: { value: "data" } });
      await slot.findByRole("heading", { name: "data" });
      expect((await slot.findByRole("combobox", { name: "Configured repository" }) as HTMLSelectElement).value).toBe("data");

      expect(rpc.factory_repositories).toHaveBeenCalledTimes(2);
      expect(rpc.factory_repositories).toHaveBeenNthCalledWith(1, { selectedRepositoryKey: null });
      expect(rpc.factory_repositories).toHaveBeenNthCalledWith(2, { selectedRepositoryKey: "data" });
      for (const method of ["factory_snapshot", "factory_settings", "factory_health", "factory_interactions", "factory_runs"]) {
        const calls = slot.inspection.rpcCalls.filter((call) => call.method === method);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(expect.objectContaining({ input: expect.objectContaining({ repositoryKey: "data" }) }));
      }
      expect(slot.inspection.rpcCalls).not.toContainEqual(expect.objectContaining({ method: "factory_action" }));
    } finally {
      slot.lifecycle.unmount();
      controlledSettingsState = { values: { repositoryKey: "demo" }, isLoading: false };
    }
  });

  it("reloads every durable projection after recovery and invalidation", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      factory_repositories: () => repositorySelection,
      factory_snapshot: () => snapshot,
      factory_settings: () => settingsProjection,
      factory_health: () => healthProjection,
      factory_interactions: () => ({ repositoryKey: "demo", interactions: [] }),
      factory_runs: () => ({ runs: [runSummary], nextCursor: null }),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" }, realtimeConnectionState: "reconnecting" },
    );
    try {
      await slot.findByRole("heading", { name: "Repository health" });
      const readMethods = ["factory_repositories", "factory_snapshot", "factory_settings", "factory_health", "factory_interactions", "factory_runs"];
      for (const method of readMethods) expect(slot.inspection.rpcCalls.filter((call) => call.method === method)).toHaveLength(1);

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

  it("uses explicit host and workspace file targets for canonical paths", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = {
      factory_repositories: () => repositorySelection,
      factory_snapshot: () => snapshot,
      factory_settings: () => settingsProjection,
      factory_health: () => healthProjection,
      factory_interactions: () => ({ repositoryKey: "demo", interactions: [] }),
      factory_runs: () => ({ runs: [runSummary], nextCursor: null }),
      factory_run_detail: () => runDetail,
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" }, openFilePreview: () => true },
    );
    try {
      const dashboardLink = await slot.findByRole("link", { name: "Open plans/README.md" });
      expect(dashboardLink.getAttribute("href")).toContain(encodeURIComponent("/work/demo/plans/README.md"));
      fireEvent.click(dashboardLink);
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host-1", path: "/work/demo/plans/README.md" }, location: null } });

      slot.lifecycle.rerender(h(FactoryView, { subPath: "runs/run-1", panelPath: "factory" }));
      const runLink = await slot.findByRole("link", { name: "plans/factory/runs/run-1.md" });
      expect(runLink.getAttribute("href")).toContain(encodeURIComponent("plans/factory/runs/run-1.md"));
      fireEvent.click(runLink);
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "environment-1", path: "plans/factory/runs/run-1.md" }, location: null } });
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
      id: "blocked-item",
      status: { kind: "blocked-by" as const, questionId: "Q1", detail: "Waiting on Q1" },
      approved: { kind: "none" as const, source: "none" as const },
      eligible: false,
      eligibilityReasons: ["not-ready" as const],
    }],
  };

  const actionResult = (action: string) => ({
    ok: true as const,
    revision,
    result: {
      status: "accepted" as const,
      message: `${action} applied.`,
      revision,
      runId: action === "run-now" ? "run-2" : null,
      leaseId: null,
      queueItemId: action === "approve-queue" ? "blocked-item" : null,
      action,
      questionId: null,
      interactionId: null,
    },
  });

  function actionRpc(overrides: Record<string, unknown> = {}) {
    return {
      factory_repositories: () => repositorySelection,
      factory_snapshot: () => overrides.snapshot ?? snapshot,
      factory_settings: () => overrides.settings ?? settingsProjection,
      factory_health: () => healthProjection,
      factory_interactions: () => ({ repositoryKey: "demo", interactions: [] }),
      factory_runs: () => ({ runs: [runSummary], nextCursor: null }),
      factory_run_detail: () => runDetail,
      factory_action: vi.fn((input: { action: { kind: string } }) => actionResult(input.action.kind)),
    } as unknown as PluginRpcTestHandlers<FactoryRpcContract> & { factory_action: ReturnType<typeof vi.fn> };
  }

  it("submits a guarded queue approval with the recorded authorization text", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = actionRpc({ snapshot: blockedSnapshot });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "queue", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const input = await slot.findByRole("textbox");
      fireEvent.change(input, { target: { value: "no gated actions" } });
      fireEvent.click(await slot.findByRole("button", { name: "Approve as ready" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({
          repositoryKey: "demo",
          expectedRevision: revision,
          action: { kind: "approve-queue", queueItemId: "blocked-item", approvedText: "no gated actions" },
        }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps ready queue entries free of approval controls", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const rpc = actionRpc();
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "queue", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByRole("heading", { name: "Ready work" });
      const buttons = Array.from(slot.container.querySelectorAll("button"));
      expect(buttons.some((button) => button.textContent === "Approve as ready")).toBe(false);
      expect(slot.container.querySelector("input[type='text']")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("dispatches run-now from the overview when dispatch is enabled", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const enabledSettings = {
      ...settingsProjection,
      settings: { ...settingsProjection.settings, dispatchMode: "enabled" as const },
      dispatch: { mode: "enabled" as const, acceptingNewRuns: true, activeRunCount: 0, reason: null },
    };
    const rpc = actionRpc({ settings: enabledSettings });
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Run now" }));
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
    const rpc = actionRpc();
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "", panelPath: "factory" },
      { rpc, settings: { repositoryKey: "demo" } },
    );
    try {
      const runNow = await slot.findByRole("button", { name: "Run now" });
      expect((runNow as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(await slot.findByRole("button", { name: "Resume dispatch" }));
      await vi.waitFor(() => {
        expect(rpc.factory_action).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: "resume" } }));
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
