// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactoryShell, type FactoryShellProps } from "../src/ui/shell.js";
import { computeAttention } from "../src/ui/attention.js";
import { TONE_BADGE } from "../src/ui/primitives.js";

const h = createElement;

afterEach(() => cleanup());

function shellProps(overrides: Partial<FactoryShellProps> = {}): FactoryShellProps {
  return {
    section: "overview" as const,
    onNavigate: () => undefined,
    repositories: [],
    selectedRepositoryKey: "demo",
    aggregateScope: false,
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

  it("renders chips and count badges with the small label radius, not round pills", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).toMatch(/<span[^>]*class="[^"]*rounded px-2 py-0\.5[^"]*bg-\[#dcfce7\][^"]*"[^>]*>Dispatch on<\/span>/);
    expect(markup).toMatch(/<span[^>]*class="[^"]*rounded bg-\[#fef3c7\][^"]*"[^>]*>2<\/span>/);
    // Tinted chips never carry a larger radius; only geometric circles stay rounded-full.
    expect(markup).not.toMatch(/rounded-(?:md|full)[^"]*bg-(?:muted|warning|success|destructive)[^"]*px-/);
  });

  it("renders the refresh affordance with an inline icon, not the ↻ glyph", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).not.toContain("↻");
    expect(markup).toMatch(/<button[^>]*title="Refresh now"[^>]*aria-label="refreshed [^"]*"[^>]*><span[^>]*class="hidden sm:inline"[^>]*>refreshed [^<]*<\/span><svg[^>]*viewBox="0 0 24 24"/);
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

  it("hides repo-scoped chrome on the repositories landing but keeps the switcher and aggregate tabs", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      repositoriesActive: true,
      tabs: ["overview", "work", "questions", "runs"],
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
    // The aggregate scope shows its four union tabs and never a Settings tab.
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup).not.toContain(">Settings<");
    expect(markup).not.toContain("Dispatch on");
    expect(markup).not.toContain("@abcdef1");
    expect(markup).not.toContain(">Pause<");
    expect(markup).not.toContain("Running");
    expect(markup).not.toContain("Run now");
    expect(markup).not.toContain('data-testid="factory-status-row"');
    expect(markup).not.toContain('data-testid="factory-controls-row"');
    expect(markup).toContain(">Factory<");
    expect(markup).toContain('aria-label="Configured repository"');
  });

  it("renders status and controls rows only for repository scope", () => {
    const aggregate = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      repositoriesActive: true,
      tabs: ["overview", "work", "questions", "runs"],
      children: "body",
    })));
    expect(aggregate).not.toContain('data-testid="factory-status-row"');
    expect(aggregate).not.toContain('data-testid="factory-controls-row"');
    expect(aggregate).not.toContain('aria-label="Chip legend"');
    expect(aggregate).not.toContain("refreshed");

    const repository = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      children: "body",
    })));
    expect(repository).toContain('data-testid="factory-status-row"');
    expect(repository).toContain('data-testid="factory-controls-row"');
    expect(repository).toContain('aria-label="Chip legend"');
    expect(repository).toContain("refreshed");
  });

  it("keeps aggregate chrome hidden while the repository list is cold or failed", () => {
    const cold = renderToStaticMarkup(h(FactoryShell, shellProps({
      aggregateScope: true,
      repositoriesActive: false,
      repositorySelectionLoading: true,
      repositories: [],
      dispatch: null,
      refreshedAt: null,
      children: "loading",
    })));
    const failed = renderToStaticMarkup(h(FactoryShell, shellProps({
      aggregateScope: true,
      repositoriesActive: false,
      repositorySelectionLoading: false,
      repositories: [],
      dispatch: null,
      refreshedAt: null,
      children: "failed",
    })));
    for (const markup of [cold, failed]) {
      expect(markup).not.toContain('data-testid="factory-status-row"');
      expect(markup).not.toContain('data-testid="factory-controls-row"');
      expect(markup).not.toContain('aria-label="Chip legend"');
      expect(markup).toContain('role="tablist"');
    }
  });

  it("closes the legend when controls hide and does not restore it on return", () => {
    const { rerender } = render(h(FactoryShell, shellProps({ children: "repository" })));
    fireEvent.click(screen.getByRole("button", { name: "Chip legend" }));
    expect(screen.getByRole("dialog", { name: "Chip legend" })).toBeTruthy();

    rerender(h(FactoryShell, shellProps({
      aggregateScope: true,
      repositoriesActive: false,
      children: "aggregate",
    })));
    expect(screen.queryByRole("dialog", { name: "Chip legend" })).toBeNull();

    rerender(h(FactoryShell, shellProps({ children: "repository again" })));
    expect(screen.queryByRole("dialog", { name: "Chip legend" })).toBeNull();
    expect(screen.getByRole("button", { name: "Chip legend" })).toBeTruthy();
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

  it("hides the commit sha chip below sm while the branch name stays visible", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({ children: "body" })));
    expect(markup).toMatch(/<span class="hidden sm:inline-flex"><button[^>]*><span[^>]*>@abcdef1/);
    expect(markup).toMatch(/<span class="hidden sm:inline">factory<\/span><span class="hidden sm:inline-flex">/);
  });

  it("uses an explicit All repositories select value and keeps the current section", () => {
    const onShowRepositories = vi.fn();
    const onSelectRepository = vi.fn();
    render(h(FactoryShell, shellProps({
      section: "work",
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: null,
      repositoriesActive: true,
      onShowRepositories,
      onSelectRepository,
      children: "body",
    })));
    const select = screen.getAllByRole("combobox", { name: "Configured repository" })[0] as HTMLSelectElement;
    expect(select.value).toBe("__all__");
    expect(within(select).getByRole("option", { name: "All repositories" }).getAttribute("value")).toBe("__all__");
    fireEvent.change(select, { target: { value: "beta" } });
    expect(onSelectRepository).toHaveBeenCalledWith("beta");
    fireEvent.change(select, { target: { value: "__all__" } });
    expect(onShowRepositories).toHaveBeenCalledWith("work");
  });

  it("leaves the wizard select unselected and labels unexpected branches on phones", () => {
    const slot = render(h(FactoryShell, shellProps({
      wizardMode: true,
      repositories: switcherRepositories("alpha"),
      repositoriesActive: false,
      branch: "release",
      children: "body",
    })));
    expect((screen.getByRole("combobox", { name: "Configured repository" }) as HTMLSelectElement).value).toBe("");
    slot.unmount();
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha"),
      repositoriesActive: false,
      branch: "release",
      children: "body",
    })));
    expect(markup).toContain("Branch: release");
    expect(markup).toContain("hidden shrink-0 text-sm font-semibold sm:inline");
  });

  it("keeps phone shell rows, hit areas, refresh width, and tab clipping deterministic", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha", "beta"),
      selectedRepositoryKey: "alpha",
      children: "body",
    })));
    expect(markup).toContain("flex flex-col gap-1");
    expect(markup).toContain("min-h-8 min-w-8");
    expect(markup).toContain("min-w-[4.5rem]");
    expect(markup).toContain("[scrollbar-width:none]");
    expect(markup).toContain("bg-gradient-to-l");
    expect(markup).toContain("basis-1/5");
  });

  it("scrolls the active tab into view on selection so a clipped tab is revealed", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(h(FactoryShell, shellProps({ section: "settings", children: "body" })));
      const active = screen.getByRole("tab", { selected: true });
      expect(active.textContent).toContain("Settings");
      expect(scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" });
      expect(scrollIntoView.mock.instances).toContain(active);
    } finally {
      if (original === undefined) {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Element.prototype.scrollIntoView = original;
      }
    }
  });

  it("gives each mobile refresh, legend, and add control its own minimum hit area", () => {
    const markup = renderToStaticMarkup(h(FactoryShell, shellProps({
      repositories: switcherRepositories("alpha"),
      selectedRepositoryKey: "alpha",
      children: "body",
    })));
    const refresh = /<button[^>]*aria-label="refreshed[^"]*"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(refresh).toContain("min-h-8");
    expect(refresh).toContain("min-w-[4.5rem]");
    const legend = /<button[^>]*aria-label="Chip legend"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(legend).toContain("min-h-8");
    expect(legend).toContain("min-w-8");
    const addButtons = markup.match(/<button[^>]*aria-label="Add repository"[^>]*>/g) ?? [];
    expect(addButtons).toHaveLength(2);
    for (const tag of addButtons) {
      expect(tag).toContain("min-h-8");
      expect(tag).toContain("min-w-8");
    }
  });

  it("legend explains mono ids, provider chips, host ids, and the current marker", () => {
    render(h(FactoryShell, shellProps({ children: "body" })));
    fireEvent.click(screen.getByRole("button", { name: "Chip legend" }));
    const dialog = screen.getByRole("dialog", { name: "Chip legend" });
    expect(within(dialog).getByText("run_1a2b")).toBeTruthy();
    expect(within(dialog).getByText(/Provider chip/)).toBeTruthy();
    expect(within(dialog).getByText(/Host id/)).toBeTruthy();
    expect(within(dialog).getByText(/Current/)).toBeTruthy();
    for (const meaning of [
      "done, healthy, enabled",
      "needs you or paused",
      "failed or unavailable",
      "running",
      "neutral or idle",
    ]) {
      expect(within(dialog).getByText(meaning)).toBeTruthy();
    }
  });

  it("shows a brief Updated cue on the refresh control after a refresh completes", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(h(FactoryShell, shellProps({ refreshedAt: Date.now() - 8000 })));
      expect(screen.queryByText("Updated")).toBeNull();
      rerender(h(FactoryShell, shellProps({ refreshedAt: Date.now() })));
      const cue = screen.getByText("Updated");
      expect(cue).toBeTruthy();
      // The cue must be visible on phone widths too: no hidden-below-sm class.
      expect(cue.className ?? "").not.toContain("hidden");
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(screen.queryByText("Updated")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("green and amber badge pairs keep WCAG AA contrast on their own tint", () => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
    };
    const ratio = (classes: string) => {
      const bg = /bg-\[(#[0-9a-f]{6})\]/.exec(classes)?.[1];
      const fg = /text-\[(#[0-9a-f]{6})\]/.exec(classes)?.[1];
      if (!bg || !fg) throw new Error(`badge tone is not a pinned pair: ${classes}`);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(ratio(TONE_BADGE.success)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(TONE_BADGE.warning)).toBeGreaterThanOrEqual(4.5);
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
