// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactoryShell, type FactoryShellProps } from "../src/ui/shell.js";
import { computeAttention } from "../src/ui/attention.js";

const h = createElement;

function shellProps(overrides: Partial<FactoryShellProps> = {}): FactoryShellProps {
  return {
    section: "overview" as const,
    onNavigate: () => undefined,
    repositories: [],
    selectedRepositoryKey: "demo",
    repositorySelectionLoading: false,
    onSelectRepository: () => undefined,
    onShowRepositories: () => undefined,
    onAddRepository: () => undefined,
    dispatch: { mode: "enabled" as const, repositoryPaused: false, acceptingNewRuns: true, activeRunCount: 0, reason: null },
    branch: "factory",
    commit: "abcdef1234567890",
    activeRun: null,
    badges: { work: 2, questions: 1, runsActive: false },
    refreshedAt: Date.now() - 8000,
    onRefresh: () => undefined,
    onPause: () => undefined,
    onResume: () => undefined,
    runNow: null,
    actionPending: false,
    connectionState: "connected" as const,
    malformedSignal: false,
    children: null,
    ...overrides,
  };
}

describe("FactoryShell", () => {
  it("owns scrolling: a fixed header plus a min-h-0 overflow-y-auto content region", () => {
    const markup = renderToStaticMarkup(
      h(FactoryShell, shellProps({ children: h("div", { style: { height: "4000px" } }, "tall") })),
    );
    expect(markup).toContain('data-testid="factory-scroll"');
    expect(markup).toMatch(/min-h-0[^"]*overflow-y-auto/);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Configured repository"');
  });

  it("shows dispatch state and tab badges in the strip", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).toContain("Dispatch on");
    expect(markup).toContain(">2</span>");
    expect(markup).toContain(">1</span>");
    expect(markup).toContain("factory");
    expect(markup).toContain("@abcdef1");
    expect(markup).toContain("Pause");
    expect(markup).toContain("refreshed");
  });

  it("surfaces a repo pause and an active run", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      dispatch: { mode: "enabled" as const, repositoryPaused: true, acceptingNewRuns: false, activeRunCount: 1, reason: null },
      activeRun: {
        runId: "run-9",
        repositoryKey: "demo",
        requestedAt: "2026-09-10T12:00:00Z",
        startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
        finishedAt: null,
        providerId: "codex",
        workerThreadId: "th_1",
        projectId: "p1",
        environmentId: "e1",
        status: "started",
        queueItemIds: ["A-1"],
        repositoryRevision: { gitCommit: "abc1234", protocolDigest: "d".repeat(64), fileDigests: {} },
        canonicalRecords: [],
      },
      children: "body",
    })));
    expect(markup).toContain("Repo paused");
    expect(markup).toContain("Running");
    expect(markup).toContain("codex");
  });
});

describe("computeAttention", () => {
  it("flags blocking questions, approvals, and paused dispatch without snapshot data", () => {
    const items = computeAttention({
      snapshot: null,
      snapshotError: false,
      settings: {
        settings: { dispatchMode: "paused", concurrencyLimit: 1 },
        validation: { valid: true, fieldErrors: {} },
        dispatch: { mode: "paused", repositoryPaused: false, acceptingNewRuns: false, activeRunCount: 0, reason: "paused" },
      } as never,
      health: null,
      runs: null,
      interactions: null,
    });
    expect(items.some((item) => item.id === "dispatch-paused")).toBe(true);
  });
});
