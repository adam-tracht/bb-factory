// @vitest-environment jsdom
import { fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FactoryViewProps } from "../src/ui/FactoryView.js";
import type { FactoryRpcContract } from "../src/rpc.js";
import { parseFactoryRoute, runDetailPath, sectionPath } from "../src/ui/routes.js";

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
      id: "GATED-1",
      title: "Gated work",
      status: { kind: "blocked-by" as const, questionId: "Q1" },
      priority: 1,
      dependsOn: [],
      risk: "low" as const,
      planPath: "plans/gated.md",
      approved: { kind: "none" as const, source: "none" as const },
      acceptance: [],
      validate: [],
      notes: null,
      blockingQuestionIds: ["Q1"],
      staleBlockingQuestionIds: [],
      blockedBy: ["Q1"],
      eligible: false,
      eligibilityReasons: ["blocking-question" as const],
    },
  ],
  questions: [
    {
      id: "Q1",
      date: "2026-09-10",
      classification: "blocking" as const,
      dashboardId: "GATED-1",
      question: "Which source is authoritative?",
      context: "Two candidates exist.",
      assumed: null,
      answer: null,
    },
  ],
  dashboard: {
    canonicalPath: "plans/README.md" as const,
    factoryBranch: "factory" as const,
    mainRef: "origin/main" as const,
    factoryAhead: 0,
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

const healthProjection = {
  repositoryKey: "demo",
  providers: [{ providerId: "codex", model: "gpt-5", reasoningLevel: "medium" as const, availability: "available" as const, limitedUntil: null, activeThreadCount: 0, lastError: null }],
  host: { hostId: "host-1", status: "online" as const, checkoutExists: true, branch: "factory", requiredTools: { pnpm: true }, browserAvailable: null, dbtStudioAvailable: null, ok: true, reasons: [] },
};

function baseRpc() {
  return {
    factory_repositories: () => repositorySelection,
    factory_snapshot: () => snapshot,
    factory_settings: () => settingsProjection,
    factory_health: () => healthProjection,
    factory_interactions: () => ({ repositoryKey: "demo", interactions: [] }),
    factory_runs: () => ({ runs: [], nextCursor: null }),
    factory_run_detail: () => { throw new Error("unused"); },
    factory_action: vi.fn(() => ({ ok: false as const, error: { category: "internal", message: "unused" } })),
  } as unknown as PluginRpcTestHandlers<FactoryRpcContract>;
}

/**
 * Simulates the host's subPath handling: each path segment is
 * percent-encoded when the panel URL is built, so '#' or '?' inside a
 * segment never survives, while the '/' structure does.
 */
function hostEncode(subPath: string): string {
  return subPath.split("/").map(encodeURIComponent).join("/");
}

beforeAll(() => {
  installTestPluginRuntime();
});

describe("factory route paths", () => {
  it("builds section paths with the anchor as a path segment, never a hash", () => {
    expect(sectionPath("questions", "question-Q3")).toBe("questions/question-Q3");
    expect(sectionPath("work", "work-T1")).toBe("work/work-T1");
    expect(sectionPath("questions")).toBe("questions");
    expect(sectionPath("questions", "question-Q3")).not.toContain("#");
  });

  it("parses segment anchors on every tab section and the queue alias", () => {
    expect(parseFactoryRoute("questions/question-Q3")).toMatchObject({ section: "questions", anchor: "question-Q3" });
    expect(parseFactoryRoute("work/work-T1")).toMatchObject({ section: "work", anchor: "work-T1" });
    expect(parseFactoryRoute("settings/some-anchor")).toMatchObject({ section: "settings", anchor: "some-anchor" });
    expect(parseFactoryRoute("queue/work-T1")).toMatchObject({ section: "work", anchor: "work-T1" });
    expect(parseFactoryRoute("questions")).toMatchObject({ section: "questions", anchor: null });
  });

  it("still resolves literal-hash and host-encoded-hash anchors", () => {
    expect(parseFactoryRoute("questions#question-Q3")).toMatchObject({ section: "questions", anchor: "question-Q3" });
    // The wire form the bug produced: the host encoded '#' to %23.
    expect(parseFactoryRoute("questions%23question-Q3")).toMatchObject({ section: "questions", anchor: "question-Q3" });
    expect(parseFactoryRoute("work%23work-T1")).toMatchObject({ section: "work", anchor: "work-T1" });
  });

  it("round-trips anchors through the host's per-segment encoding", () => {
    for (const anchor of ["question-Q3", "work-EXT-2.01", "odd anchor/50%"]) {
      const emitted = sectionPath("questions", anchor);
      expect(emitted).not.toContain("#");
      expect(parseFactoryRoute(emitted)).toMatchObject({ section: "questions", anchor });
      expect(parseFactoryRoute(hostEncode(emitted))).toMatchObject({ section: "questions", anchor });
    }
  });

  it("keeps runs/<id> a run detail, not an anchor", () => {
    expect(parseFactoryRoute("runs/run-1")).toMatchObject({ section: "runs", runId: "run-1", anchor: null });
    expect(parseFactoryRoute("runs")).toMatchObject({ section: "runs", runId: null });
    expect(parseFactoryRoute(runDetailPath("run-1"))).toMatchObject({ section: "runs", runId: "run-1" });
    expect(parseFactoryRoute(runDetailPath("run/2026"))).toMatchObject({ section: "runs", runId: "run/2026" });
  });

  it("keeps plain sections, the queue alias, and repository routes working", () => {
    expect(parseFactoryRoute("")).toMatchObject({ section: "overview", scope: "all", anchor: null });
    expect(parseFactoryRoute("queue")).toMatchObject({ section: "work", anchor: null });
    expect(parseFactoryRoute("repositories")).toMatchObject({ section: "overview", scope: "all" });
    expect(parseFactoryRoute("repositories/new")).toMatchObject({ section: "add-repository" });
    expect(parseFactoryRoute("unexpected/path")).toMatchObject({ section: "not-found", raw: "unexpected/path" });
  });

  it("parses the aggregate scope: union tabs, pinned run detail, and no aggregate settings", () => {
    expect(parseFactoryRoute("all")).toMatchObject({ section: "overview", scope: "all" });
    expect(parseFactoryRoute("all/overview")).toMatchObject({ section: "overview", scope: "all" });
    expect(parseFactoryRoute("all/work")).toMatchObject({ section: "work", scope: "all", runId: null });
    expect(parseFactoryRoute("all/questions")).toMatchObject({ section: "questions", scope: "all" });
    expect(parseFactoryRoute("all/runs")).toMatchObject({ section: "runs", scope: "all", runId: null });
    // The run detail pins the exact repository so a selection change cannot misattribute it.
    expect(parseFactoryRoute("all/runs/monorepo/run-9")).toMatchObject({
      section: "runs",
      scope: "all",
      runRepositoryKey: "monorepo",
      runId: "run-9",
    });
    expect(parseFactoryRoute("all/runs/monorepo")).toMatchObject({ section: "not-found", scope: "all" });
    expect(parseFactoryRoute("all/settings")).toMatchObject({ section: "not-found", scope: "all" });
    // Aggregate anchors carry the owning repository as "<repoKey>/<inner>".
    expect(parseFactoryRoute("all/work/monorepo/work-A-1")).toMatchObject({
      section: "work",
      scope: "all",
      anchor: "monorepo/work-A-1",
    });
  });
});

describe("Factory view anchor navigation", () => {
  it("sends a question chip click to the questions section with a segment anchor", async () => {
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath: "work", panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByText("Gated work");
      const row = slot.container.querySelector("#work-GATED-1") as HTMLElement;
      expect(row).not.toBeNull();
      // Expand the row so the "Blocked by:" question chips mount.
      fireEvent.click(within(row).getAllByRole("button")[0]!);
      fireEvent.click(within(row).getByRole("button", { name: "Q1" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "factory",
        options: { subPath: "questions/question-Q1" },
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it.each([
    ["questions/question-Q1", "the segment form"],
    ["questions%23question-Q1", "the legacy host-encoded form"],
  ])("lands on the focused question card for %s (%s)", async (subPath) => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const { FactoryView } = await import("../src/ui/FactoryView.js");
    const slot = renderSlot<FactoryViewProps, FactoryRpcContract>(
      { component: FactoryView },
      { subPath, panelPath: "factory" },
      { rpc: baseRpc(), settings: { repositoryKey: "demo" } },
    );
    try {
      await slot.findByText("Which source is authoritative?");
      expect(slot.queryByText("Page not found")).toBeNull();
      expect(slot.container.querySelector("#question-Q1")).not.toBeNull();
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });
});
