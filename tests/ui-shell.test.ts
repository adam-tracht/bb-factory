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
    repositoriesActive: false,
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

function switcherRepositories(...keys: string[]): FactoryShellProps["repositories"] {
  return keys.map((repositoryKey) => ({
    configuration: {
      repositoryKey,
      repositoryRoot: `/work/${repositoryKey}`,
      connectedHostId: "host-1",
      checkoutPath: `/work/${repositoryKey}`,
      factoryBranch: "factory" as const,
      mainRef: "origin/main",
    },
    projectId: `project-${repositoryKey}`,
    environmentId: `env-${repositoryKey}`,
    dispatchPaused: false,
    selected: true,
    available: true,
    reasons: [],
  }));
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

  it("renders chips and count badges with the smaller label radius, not rounded-full pills", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).toMatch(/<span[^>]*class="[^"]*rounded-md[^"]*bg-success\/10[^"]*"[^>]*>Dispatch on<\/span>/);
    expect(markup).toMatch(/<span[^>]*class="[^"]*rounded-md bg-warning\/15[^"]*"[^>]*>2<\/span>/);
    // Text chips never keep the pill radius; the only rounded-full left are geometric circles.
    expect(markup).not.toMatch(/rounded-full[^"]*px-1\.5/);
  });

  it("renders the refresh affordance with an inline icon, not the ↻ glyph", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).not.toContain("↻");
    expect(markup).toMatch(/<button[^>]*title="Refresh now"[^>]*aria-label="refreshed [^"]*"[^>]*><span class="hidden sm:inline">refreshed [^<]*<\/span><svg[^>]*viewBox="0 0 24 24"/);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("marks the All pill active and every repo pill inactive on the repositories landing", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      repositoriesActive: true,
      children: "body",
    })));
    const group = /<div[^>]*role="group"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
    // "All" carries the same active pill styling a selected repository gets.
    expect(group).toMatch(/aria-pressed="true" class="[^"]*bg-background text-foreground shadow-sm[^"]*"[^>]*>All<\/button>/);
    expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
    // Both repo pills render inactive, including the still-selected "alpha".
    expect(group.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(group).toContain(">alpha</button>");
    expect(group).not.toMatch(/aria-pressed="false"[^>]*class="[^"]*shadow-sm/);
  });

  it("hides repo-scoped chrome on the repositories landing but keeps the switcher and shared controls", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      repositoriesActive: true,
      runNow: { disabled: false, reason: null, confirmTitle: "Run?", confirmBody: "body", onConfirm: () => undefined },
      activeRun: {
        runId: "run-9",
        repositoryKey: "alpha",
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
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("Dispatch on");
    expect(markup).not.toContain("@abcdef1");
    expect(markup).not.toContain(">Pause<");
    expect(markup).not.toContain("Running");
    expect(markup).not.toContain("Run now");
    expect(markup).toContain(">Factory<");
    expect(markup).toContain('aria-label="Configured repository"');
    expect(markup).toContain("refreshed");
    expect(markup).toContain('aria-label="Chip legend"');
  });

  it("keeps the selected repository pill active off the landing", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      children: "body",
    })));
    const group = /<div[^>]*role="group"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
    expect(group).toMatch(/aria-pressed="false"[^>]*>All<\/button>/);
    expect(group).toMatch(/aria-pressed="true" class="[^"]*bg-background text-foreground shadow-sm[^"]*"[^>]*>alpha<\/button>/);
  });

  it("highlights the All button in the >4 repositories select fallback on the landing", () => {
    const repositories = switcherRepositories("a", "b", "c", "d", "e");
    const active = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories,
      selectedRepositoryKey: "a",
      repositoriesActive: true,
      children: "body",
    })));
    expect(active).toContain("<select");
    // The secondary variant reads as selected next to the ghost "+" control.
    expect(active).toMatch(/<button[^>]*class="[^"]*border border-border bg-card text-foreground[^"]*"[^>]*>All<\/button>/);
    const inactive = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories,
      selectedRepositoryKey: "a",
      children: "body",
    })));
    expect(inactive).toMatch(/<button[^>]*class="[^"]*text-muted-foreground hover:bg-state-hover[^"]*"[^>]*>All<\/button>/);
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

  it("scrolls the tab strip horizontally and renders the select switcher under sm", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      children: "body",
    })));
    const nav = /<nav[^>]*role="tablist"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(nav).toContain("overflow-x-auto");
    expect(markup.match(/role="tab"[^>]*class="[^"]*shrink-0/g)).toHaveLength(5);
    // Both switcher variants render; responsive classes pick one per breakpoint.
    expect(markup).toContain("<select");
    expect(markup).toMatch(/<div[^>]*class="[^"]*sm:hidden[^"]*"[^>]*aria-busy/);
    expect(markup).toMatch(/<div[^>]*class="[^"]*hidden[^"]*sm:flex[^"]*"[^>]*role="group"/);
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
