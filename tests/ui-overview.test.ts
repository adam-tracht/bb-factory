// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HealthProjection,
  OperationalRunListProjection,
  OperationalRunSummary,
  ProtocolSnapshot,
  RepositoryConfiguration,
  RepositoryRevision,
  SettingsProjection,
} from "../src/contracts.js";
import type { AttentionItem } from "../src/ui/attention.js";
import type { ViewContext } from "../src/ui/context.js";
import type { FileLinkRenderer } from "../src/ui/primitives.js";
import { OverviewView } from "../src/ui/views/overview.js";

const h = createElement;

const revision: RepositoryRevision = {
  gitCommit: "abcdef1234567890",
  protocolDigest: "a".repeat(64),
  fileDigests: { "plans/factory/queue.md": "b".repeat(64) },
};

const repository: RepositoryConfiguration = {
  repositoryKey: "demo",
  repositoryRoot: "/work/demo",
  connectedHostId: "host-1",
  checkoutPath: "/work/demo-factory",
  factoryBranch: "factory",
  mainRef: "origin/main",
};

const snapshot: ProtocolSnapshot = {
  repository,
  revision,
  capturedAt: "2026-09-10T12:00:00Z",
  foremanTemplate: {
    authority: "repository-protocol",
    relativePath: "plans/factory/foreman.md",
    contentSha256: "c".repeat(64),
    repositoryRevision: revision,
  },
  queue: [],
  questions: [],
  dashboard: {
    canonicalPath: "plans/README.md",
    factoryBranch: "factory",
    mainRef: "origin/main",
    factoryAhead: 2,
    mainBehind: 0,
    taskCommits: [
      { sha: "1111111aaaaaaaaa", subject: "task: first" },
      { sha: "2222222bbbbbbbbb", subject: "task: second" },
    ],
    safeFastForward: true,
    canonicalDashboardUrl: null,
  },
  currentRun: {
    state: "no-op",
    lastRunAt: "2026-09-10T12:02:00Z",
    currentPath: "plans/factory/current.md",
    latestRunPath: "plans/factory/runs/run-1.md",
  },
};

const settingsProjection: SettingsProjection = {
  settings: {
    repositoryKey: "demo",
    repositoryRoot: "/work/demo",
    connectedHostId: "host-1",
    checkoutPath: "/work/demo-factory",
    scheduleCron: "0 * * * *",
    timeZone: "server-local",
    nightWindowEndHour: 6,
    runtimeCapSeconds: 10800,
    providerPreference: "codex",
    minimumStartGapSeconds: 3600,
    concurrencyLimit: 1,
    dispatchMode: "enabled",
  },
  validation: { valid: true, fieldErrors: {} },
  dispatch: { mode: "enabled", repositoryPaused: false, acceptingNewRuns: true, activeRunCount: 0, reason: null },
};

const healthProjection: HealthProjection = {
  repositoryKey: "demo",
  providers: [
    {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      availability: "available",
      limitedUntil: null,
      activeThreadCount: 0,
      lastError: null,
    },
  ],
  host: {
    hostId: "host-1",
    status: "online",
    checkoutExists: true,
    branch: "factory",
    requiredTools: {},
    browserAvailable: null,
    dbtStudioAvailable: null,
    ok: true,
    reasons: [],
  },
};

const runSummary: OperationalRunSummary = {
  runId: "run-1",
  repositoryKey: "demo",
  requestedAt: "2026-09-10T12:00:00Z",
  startedAt: "2026-09-10T12:01:00Z",
  finishedAt: "2026-09-10T12:02:00Z",
  providerId: "codex",
  workerThreadId: "thr_1",
  projectId: "project-1",
  environmentId: "environment-1",
  status: "completed",
  queueItemIds: ["T1"],
  repositoryRevision: revision,
  canonicalRecords: [],
};

const runsProjection: OperationalRunListProjection = { runs: [runSummary], nextCursor: null };

const stubFileLink: FileLinkRenderer = ({ target, className, children }) =>
  h("a", { href: "#stub", className, "data-target": JSON.stringify(target) }, children);

function makeCtx(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    repository,
    environmentId: "environment-1",
    projectId: "project-1",
    dispatchPaused: false,
    revision,
    fileLink: stubFileLink,
    feedback: null,
    pendingTarget: null,
    onOpenSection: vi.fn(),
    onOpenRepository: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenProject: vi.fn(),
    onAction: vi.fn(),
    updateSettings: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    updateRepository: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    addRepository: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    loadRegistryOptions: vi.fn(async () => ({ hosts: [], projects: [] })),
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(),
    probeRepository: vi.fn(),
    resolveRepositoryProject: vi.fn(),
    ...overrides,
  };
}

type OverviewProps = Parameters<typeof OverviewView>[0];

function renderOverview(overrides: Partial<OverviewProps> = {}, ctx: ViewContext = makeCtx()) {
  return render(h(OverviewView, {
    snapshot,
    snapshotError: null,
    settings: settingsProjection,
    health: healthProjection,
    runs: runsProjection,
    attention: [],
    activeRun: null,
    ctx,
    ...overrides,
  }));
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

function stubPhoneViewport(phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  }));
}

describe("OverviewView", () => {
  it("renders attention rows whose actions navigate or mutate", () => {
    const attention: AttentionItem[] = [
      { id: "blocking-questions", severity: "action", section: "questions", title: "1 blocking question open", detail: "Gates T1" },
      { id: "approvals", severity: "action", section: "work", title: "2 items need approval", detail: "T2, T3" },
      { id: "failed-run", severity: "warning", section: "runs", title: "A run failed safe", detail: "run-9" },
      { id: "provider-degraded", severity: "warning", section: "settings", title: "Preferred provider codex is limited", detail: "quota" },
      { id: "dispatch-paused", severity: "info", section: "settings", title: "Dispatch is paused", detail: "No new runs start until it is resumed." },
      { id: "repository-paused", severity: "info", section: "settings", title: "Dispatch paused for this repository", detail: "Turn it back on in Settings." },
    ];
    const ctx = makeCtx();
    const { container } = renderOverview({ attention }, ctx);
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("1 blocking question open")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("work");
    fireEvent.click(screen.getByRole("button", { name: "Review run" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("runs");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("settings");

    const dispatchRow = container.querySelector("[data-attention-id='dispatch-paused']") as HTMLElement;
    fireEvent.click(within(dispatchRow).getByRole("button", { name: "Resume" }));
    expect(ctx.onAction).toHaveBeenCalledWith({ kind: "resume" });

    const repoRow = container.querySelector("[data-attention-id='repository-paused']") as HTMLElement;
    fireEvent.click(within(repoRow).getByRole("button", { name: "Resume" }));
    expect(ctx.updateRepository).toHaveBeenCalledWith({ repositoryKey: "demo", dispatchPaused: false });
  });

  it("shows a success line when nothing needs attention", () => {
    renderOverview();
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });

  it("adds a muted subline to the empty state when dispatch is paused", () => {
    const paused: SettingsProjection = {
      ...settingsProjection,
      dispatch: { mode: "paused", repositoryPaused: false, acceptingNewRuns: false, activeRunCount: 0, reason: null },
    };
    renderOverview({ settings: paused });
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
    expect(screen.getByText("Dispatch is paused; no new runs will start.")).toBeTruthy();
  });

  it("derives the health line from host reasons and provider availability", () => {
    const hostDown: HealthProjection = {
      ...healthProjection,
      host: { ...healthProjection.host, ok: false, reasons: ["checkout missing on host"] },
    };
    const first = renderOverview({ health: hostDown });
    expect(screen.getByText("Degraded: checkout missing on host")).toBeTruthy();
    first.unmount();

    const providerLimited: HealthProjection = {
      ...healthProjection,
      providers: [{ ...healthProjection.providers[0], availability: "limited", lastError: "100% weekly" }],
    };
    renderOverview({ health: providerLimited });
    expect(screen.getByText("Degraded: codex limited: 100% weekly")).toBeTruthy();
  });

  it("still renders the dispatch card from settings when the snapshot fails", () => {
    renderOverview({ snapshot: null, snapshotError: "queue.md: unsupported status" });
    expect(screen.getByRole("alert").textContent).toContain("queue.md: unsupported status");
    expect(screen.getByText("Dispatch")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("1 hr")).toBeTruthy();
  });

  it("keeps the task commit list inside a collapsed disclosure", () => {
    renderOverview();
    const summary = screen.getByText("2 task commits");
    const details = summary.closest("details") as HTMLElement | null;
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(within(details as HTMLElement).queryByText("task: first")).toBeNull();
    fireEvent.click(details!.querySelector("summary")!);
    expect(within(details as HTMLElement).getByText("task: first")).toBeTruthy();
    expect(within(details as HTMLElement).getByText("1111111")).toBeTruthy();
  });

  it("does not duplicate the run-now action owned by the shell header", () => {
    renderOverview();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("scopes protocol file links to the repository workspace environment", () => {
    const { container } = renderOverview();
    const targets = Array.from(container.querySelectorAll("a[data-target]"))
      .map((anchor) => JSON.parse(anchor.getAttribute("data-target") ?? "{}") as Record<string, string>);
    for (const path of [
      "plans/factory/current.md",
      "plans/factory/foreman.md",
      "plans/factory/runs/run-1.md",
      "plans/README.md",
    ]) {
      expect(targets).toContainEqual({ kind: "workspace", environmentId: "environment-1", path });
    }
  });

  it("shows the live run with a thread link, and links the last finished run", () => {
    const ctx = makeCtx();
    const active: OperationalRunSummary = {
      ...runSummary,
      status: "started",
      finishedAt: null,
      workerThreadId: "thr_live",
    };
    renderOverview({ activeRun: active }, ctx);
    expect(screen.getByText(/Running/)).toBeTruthy();
    expect(screen.getByText("Pause stops new runs; this one continues.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(ctx.onOpenThread).toHaveBeenCalledWith("thr_live");

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(ctx.onOpenRun).toHaveBeenCalledWith("run-1");
  });
});

describe("OverviewView phone layout", () => {
  it("clamps Needs attention detail text and keeps the full text on the title attribute", () => {
    const detail =
      "T2 waits on approval text that runs long, and T3 still needs a dependency review before it can dispatch.";
    renderOverview({
      attention: [
        { id: "approvals", severity: "action", section: "work", title: "2 items need approval", detail },
      ],
    });
    const detailEl = screen.getByText(detail);
    expect(detailEl.className).toContain("line-clamp-2");
    expect(detailEl.getAttribute("title")).toBe(detail);
  });

  it("expands a Needs attention row to reveal the full detail and keeps the action outside the summary", () => {
    const detail =
      "T2 waits on approval text that runs long, and T3 still needs a dependency review before it can dispatch.";
    const { container } = renderOverview({
      attention: [
        { id: "approvals", severity: "action", section: "work", title: "2 items need approval", detail },
      ],
    });
    const row = container.querySelector("[data-attention-id='approvals']") as HTMLElement;
    const details = row.querySelector("details") as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    const summary = details!.querySelector("summary") as HTMLElement;
    expect(within(row).getAllByText(detail)).toHaveLength(1);

    fireEvent.click(summary);
    expect(details!.open).toBe(true);
    expect(within(row).getAllByText(detail)).toHaveLength(2);

    const action = within(row).getByRole("button", { name: "Review" });
    expect(summary.contains(action)).toBe(false);
    expect(details!.contains(action)).toBe(false);
  });

  it("wraps long current-run task ids instead of overflowing", () => {
    const longId = "BBF-0033-WITH-A-LONG-TASK-IDENTIFIER-0123456789";
    renderOverview({
      activeRun: { ...runSummary, status: "started", finishedAt: null, queueItemIds: [longId] },
    });
    const chip = screen.getByText(longId);
    expect(chip.className).toContain("break-all");
    expect(chip.className).toContain("max-w-full");
  });

  it("describes the dispatch schedule cron as a sentence (0037)", () => {
    const custom: SettingsProjection = {
      ...settingsProjection,
      settings: { ...settingsProjection.settings, scheduleCron: "*/10 1-5 * * *" },
    };
    renderOverview({ settings: custom });
    expect(screen.getByText("Every 10 minutes between 01:00 and 05:59, every day")).toBeTruthy();
  });
});

describe("OverviewView section disclosure", () => {
  const attention: AttentionItem[] = [
    { id: "blocking-questions", severity: "action", section: "questions", title: "1 blocking question open", detail: "Gates T1" },
  ];

  it("keeps Needs attention open by default and honors a stored closed choice", () => {
    renderOverview({ attention });
    const details = screen.getByRole("heading", { name: "Needs attention" }).closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);

    cleanup();
    window.sessionStorage.setItem("bb-factory:section:demo:overview:needs-attention", "0");
    renderOverview({ attention });
    const closed = screen.getByRole("heading", { name: "Needs attention" }).closest("details") as HTMLDetailsElement;
    expect(closed.open).toBe(false);
    // The count badge still signals the hidden rows.
    expect(within(closed).getByText("1")).toBeTruthy();
    expect(screen.queryByText("1 blocking question open")).toBeNull();

    fireEvent.click(closed.querySelector("summary")!);
    expect(window.sessionStorage.getItem("bb-factory:section:demo:overview:needs-attention")).toBe("1");
  });

  it("keeps Technical details collapsed until toggled and persists the choice", () => {
    renderOverview();
    const details = screen.getByRole("heading", { name: "Technical details" }).closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.queryByText("Protocol digest")).toBeNull();

    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("Protocol digest")).toBeTruthy();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:overview:technical-details")).toBe("1");
  });

  it("collapses every secondary section on phone widths while Needs attention stays open", () => {
    stubPhoneViewport(true);
    renderOverview({ attention, activeRun: { ...runSummary, status: "started", finishedAt: null } });

    const needs = screen.getByRole("heading", { name: "Needs attention" }).closest("details") as HTMLDetailsElement;
    expect(needs.open).toBe(true);
    for (const title of ["Current run", "Last run", "Dispatch", "Repository", "Technical details"]) {
      const details = screen.getByRole("heading", { name: title }).closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(false);
    }
  });

  it("opens secondary sections by default on desktop while Technical details stays closed", () => {
    renderOverview({ attention, activeRun: { ...runSummary, status: "started", finishedAt: null } });

    for (const title of ["Needs attention", "Current run", "Last run", "Dispatch", "Repository"]) {
      const details = screen.getByRole("heading", { name: title }).closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(true);
    }
    const technical = screen.getByRole("heading", { name: "Technical details" }).closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    // Grouped content is still present inside the open sections.
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("Current state:")).toBeTruthy();
  });

  it("opens settings without toggling Dispatch when its Edit action is clicked", () => {
    const ctx = makeCtx();
    renderOverview({}, ctx);

    const dispatch = screen.getByRole("heading", { name: "Dispatch" }).closest("details") as HTMLDetailsElement;
    expect(dispatch.open).toBe(true);

    const edit = within(dispatch.querySelector("summary")!).getByRole("button", { name: "Edit" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(edit, click);

    expect(ctx.onOpenSection).toHaveBeenCalledWith("settings");
    expect(click.defaultPrevented).toBe(false);
    expect(dispatch.open).toBe(true);
    expect(window.sessionStorage.getItem("bb-factory:section:demo:overview:dispatch")).toBeNull();
  });
});
