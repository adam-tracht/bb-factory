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

    let settingsState: { values: Record<string, string | number | boolean> | undefined; isLoading: boolean } = { values: undefined, isLoading: true };
    const subscribers = new Set<() => void>();
    const originalUseSettings = runtime.__bbPluginRuntime.pluginSdkApp.useSettings;
    runtime.__bbPluginRuntime.pluginSdkApp.useSettings = () => {
      const [, forceRender] = useState(0);
      useEffect(() => {
        const subscriber = () => forceRender((value) => value + 1);
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }, []);
      return settingsState;
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
        settingsState = { values: { repositoryKey: "demo" }, isLoading: false };
        for (const subscriber of subscribers) subscriber();
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
