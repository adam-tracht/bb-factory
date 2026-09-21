// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DispatchAttempt,
  OperationalRunDetail,
  OperationalRunSummary,
  RepositoryRevision,
} from "../src/contracts.js";
import type { ViewContext } from "../src/ui/context.js";
import { runStatusLabel, Section, type FileLinkRenderer } from "../src/ui/primitives.js";
import { RunDetailView, RunsView } from "../src/ui/views/runs.js";

const h = createElement;

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

function openSection(title: string): HTMLDetailsElement {
  const details = screen.getByRole("heading", { name: title }).closest("details") as HTMLDetailsElement;
  fireEvent.click(details.querySelector("summary")!);
  return details;
}

const revision: RepositoryRevision = {
  gitCommit: "abc1234def5678",
  protocolDigest: "a".repeat(64),
  fileDigests: {},
};

const repository = {
  repositoryKey: "demo",
  repositoryRoot: "/work/demo",
  connectedHostId: "host-1",
  checkoutPath: "/work/demo",
  factoryBranch: "factory" as const,
  mainRef: "origin/main",
};

const stubFileLink: FileLinkRenderer = (props) =>
  h("a", {
    href: "#",
    className: props.className,
    "data-target": JSON.stringify(props.target),
  }, props.children);

function makeCtx(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    repository,
    environmentId: "env-ctx",
    projectId: "proj-ctx",
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
    updateSettings: vi.fn(() => Promise.resolve({ ok: true as const, message: "saved" })),
    updateRepository: vi.fn(() => Promise.resolve({ ok: true as const, message: "saved" })),
    addRepository: vi.fn(() => Promise.resolve({ ok: true as const, message: "saved" })),
    loadRegistryOptions: vi.fn(() => Promise.resolve({ hosts: [], projects: [] })),
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(),
    probeRepository: vi.fn(),
    resolveRepositoryProject: vi.fn(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<OperationalRunSummary> = {}): OperationalRunSummary {
  return {
    runId: "run-1",
    repositoryKey: "demo",
    requestedAt: "2026-09-10T12:00:00Z",
    startedAt: "2026-09-10T12:01:00Z",
    finishedAt: "2026-09-10T12:02:00Z",
    providerId: "codex",
    workerThreadId: "thr_worker",
    projectId: "proj-1",
    environmentId: "env-1",
    status: "completed",
    queueItemIds: ["MON-1"],
    repositoryRevision: revision,
    canonicalRecords: [
      {
        relativePath: "plans/factory/runs/run-1.md",
        recordType: "immutable-run" as const,
        recordId: "run-1",
        repositoryRevision: revision,
      },
    ],
    ...overrides,
  } as OperationalRunSummary;
}

const attempt: DispatchAttempt = {
  attemptId: "attempt-1",
  runId: "run-1",
  repositoryKey: "demo",
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "medium",
  workerThreadId: "thr_worker",
  status: "started",
  startedAt: "2026-09-10T12:01:00Z",
  finishedAt: null,
};

function makeDetail(
  summary: OperationalRunSummary,
  overrides: Partial<OperationalRunDetail> = {},
): OperationalRunDetail {
  return {
    summary,
    intent: {
      runId: summary.runId,
      repositoryKey: "demo",
      trigger: "manual",
      idempotencyKey: "bbf:v1:demo:run-now:00000000-0000-4000-8000-000000000001",
      requestedAt: summary.requestedAt,
      baseRevision: revision,
      queueItemIds: summary.queueItemIds,
      authorizationProvenance: [],
    },
    attempts: [attempt],
    lease: null,
    ...overrides,
  } as OperationalRunDetail;
}

describe("RunsView", () => {
  it("pins active runs above history with a live elapsed timer and thread button", () => {
    const ctx = makeCtx();
    const activeRun = makeRun({
      runId: "run-active",
      status: "started",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      finishedAt: null,
      workerThreadId: "thr_123",
      canonicalRecords: [],
    });
    const doneRun = makeRun({ runId: "run-done" });
    render(h(RunsView, { runs: { runs: [doneRun, activeRun], nextCursor: null }, ctx }));

    const activeHeading = screen.getByText("Active");
    const historyHeading = screen.getByText("History");
    expect(activeHeading.compareDocumentPosition(historyHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("5m")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    expect(ctx.onOpenThread).toHaveBeenCalledWith("thr_123");
  });

  it("renders history row fields and opens the run on click", () => {
    const ctx = makeCtx();
    render(h(RunsView, { runs: { runs: [makeRun()], nextCursor: null }, ctx }));

    const row = screen.getByRole("button", { name: /Success/ });
    expect(row.textContent).toContain("codex");
    expect(row.textContent).toContain("1m");
    expect(row.textContent).toContain("MON-1");
    expect(row.textContent).toMatch(/ago|just now/);

    fireEvent.click(row);
    expect(ctx.onOpenRun).toHaveBeenCalledWith("run-1");
  });

  it("lays out a history row as metadata over task chips with a centered chevron", () => {
    const ctx = makeCtx();
    render(h(RunsView, { runs: { runs: [makeRun({ queueItemIds: ["MON-1", "MON-2"] })], nextCursor: null }, ctx }));

    const row = screen.getByRole("button", { name: /Success/ });
    expect(row.className).toContain("min-w-0");

    const content = row.firstElementChild as HTMLElement;
    expect(content.className).toContain("flex-col");
    expect(content.className).toContain("sm:flex-row");
    expect(content.className).toContain("flex-1");

    const [metadata, chips] = Array.from(content.children) as HTMLElement[];
    expect(metadata.className).toContain("flex-wrap");
    expect(metadata.textContent).toContain("codex");
    expect(metadata.textContent).toContain("1m");
    expect(metadata.textContent).toMatch(/ago|just now/);
    expect(within(metadata).getByText("Success")).toBeTruthy();

    expect(chips.className).toContain("flex-wrap");
    expect(chips.className.split(/\s+/).some((cls) => /^w-/.test(cls))).toBe(false);
    expect(within(chips).getByText("MON-1")).toBeTruthy();
    expect(within(chips).getByText("MON-2")).toBeTruthy();

    const chevron = row.lastElementChild as HTMLElement;
    expect(chevron).not.toBe(content);
    expect(chevron.className).toContain("self-center");
  });

  it("renders a muted No tasks label when a history run has no queue item ids", () => {
    const ctx = makeCtx();
    render(h(RunsView, { runs: { runs: [makeRun({ queueItemIds: [] })], nextCursor: null }, ctx }));

    const noTasks = screen.getByText("No tasks");
    expect(noTasks.className).toContain("text-muted-foreground");
  });

  it("lets a single very long task id chip wrap inside a narrow row", () => {
    const ctx = makeCtx();
    const longId = "MON-LONG-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
    render(h(RunsView, { runs: { runs: [makeRun({ queueItemIds: [longId] })], nextCursor: null }, ctx }));

    const chip = screen.getByText(longId);
    expect(chip.className).toContain("max-w-full");
    expect(chip.className).toContain("box-border");
    expect(chip.className).toContain("break-all");
    expect(chip.style.overflowWrap).toBe("anywhere");
  });

  it("shows the empty state copy with a link to the protocol runs folder", () => {
    const ctx = makeCtx();
    render(h(RunsView, { runs: { runs: [], nextCursor: null }, ctx }));

    expect(screen.getByText("No BB-tracked runs yet for demo")).toBeTruthy();
    expect(screen.getByText("Runs recorded directly by the protocol live in plans/factory/runs/.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open runs folder" });
    const target = JSON.parse(link.getAttribute("data-target") ?? "{}") as Record<string, string>;
    expect(target).toEqual({ kind: "workspace", environmentId: "env-ctx", path: "plans/factory/runs" });
  });

  it("uses the display name in the repository-specific empty state", () => {
    render(h(RunsView, {
      runs: { runs: [], nextCursor: null },
      ctx: makeCtx({ displayName: "Demo app" }),
    }));
    expect(screen.getByText("No BB-tracked runs yet for Demo app")).toBeTruthy();
  });

  it("lets the active run row wrap so the Thread action stays inside the row", () => {
    const ctx = makeCtx();
    render(h(RunsView, {
      runs: { runs: [makeRun({ status: "started", finishedAt: null })], nextCursor: null },
      ctx,
    }));

    const thread = screen.getByRole("button", { name: "Thread" });
    const row = thread.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(within(row).getByRole("button", { name: /Running/ })).toBeTruthy();
  });
});

describe("runStatusLabel", () => {
  it("uses one sentence-case label per run status", () => {
    expect(runStatusLabel("pending")).toBe("Pending");
    expect(runStatusLabel("started")).toBe("Running");
    expect(runStatusLabel("completed")).toBe("Success");
    expect(runStatusLabel("failed-safe")).toBe("Failed safe");
    expect(runStatusLabel("blocked")).toBe("Blocked");
    expect(runStatusLabel("no-op")).toBe("No-op");
    expect(runStatusLabel("cancelled")).toBe("Cancelled");
    expect(runStatusLabel("cancel-requested")).toBe("Cancelling");
    expect(runStatusLabel("reconciliation-required")).toBe("Needs reconciliation");
  });
});

describe("RunDetailView", () => {
  it("explains reconciliation and failed-safe terminal states", () => {
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun({ status: "reconciliation-required" })), ctx }));
    expect(screen.getByRole("status").textContent).toContain("Terminal evidence is being reconciled");

    cleanup();
    const quarantinedLease = {
      leaseId: "lease-1",
      repositoryKey: "demo" as const,
      runId: "run-1",
      queueItemIds: ["MON-1"],
      workerThreadId: "thr_worker",
      authorizationProvenance: ["MON-1"],
      acquiredAt: "2026-09-10T12:01:00Z",
      expiresAt: "2026-09-10T13:01:00Z",
      status: "reconciliation-required" as const,
    };
    render(h(RunDetailView, {
      detail: makeDetail(makeRun({ status: "failed-safe" }), { lease: quarantinedLease }),
      ctx,
    }));
    expect(screen.getByRole("status").textContent).toContain("Global capacity is free");
    expect(screen.getByRole("status").textContent).toContain("ownership remains quarantined");
    expect(screen.getByRole("button", { name: "Resolve ownership" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    cleanup();
    render(h(RunDetailView, {
      detail: makeDetail(makeRun({ status: "failed-safe" }), { lease: { ...quarantinedLease, status: "released" } }),
      ctx,
    }));
    expect(screen.getByRole("status").textContent).toContain("the repository lease is released");
    expect(screen.getByRole("status").textContent).toContain("Retry is the supported next action");
  });

  it("renders the timeline and resolves canonical records to workspace targets", () => {
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.getByText("Started")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();

    const link = screen.getByRole("link", { name: "plans/factory/runs/run-1.md" });
    const target = JSON.parse(link.getAttribute("data-target") ?? "{}") as Record<string, string>;
    // The run's own environmentId wins over the context default (env-ctx).
    expect(target).toEqual({ kind: "workspace", environmentId: "env-1", path: "plans/factory/runs/run-1.md" });
  });

  it("requires typing the phrase before Stop run fires the stop action", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ status: "started", finishedAt: null }));
    render(h(RunDetailView, { detail, ctx }));

    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Stop run" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "stop" } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(ctx.onAction).toHaveBeenCalledWith({ kind: "stop" });
  });

  it("confirms Retry and dispatches the retry action with the latest attempt id", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ status: "failed-safe", finishedAt: "2026-09-10T12:05:00Z" }));
    render(h(RunDetailView, { detail, ctx }));

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Dispatches a new attempt for failed-safe run run-1.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(ctx.onAction).toHaveBeenCalledWith({ kind: "retry", attemptId: "attempt-1" });
  });

  it("renders an Open thread button that navigates to the worker thread", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ workerThreadId: "thr_abc" }));
    render(h(RunDetailView, { detail, ctx }));

    const button = screen.getByRole("button", { name: "Open thread" });
    expect(button.getAttribute("title")).toBe("Open worker thread thr_abc");

    fireEvent.click(button);
    expect(ctx.onOpenThread).toHaveBeenCalledWith("thr_abc");
  });

  it("keeps the run id inside Technical details and renders Open thread as a bordered button", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ workerThreadId: "thr_abc" }));
    render(h(RunDetailView, { detail, ctx }));

    expect(screen.queryByText("run-1")).toBeNull();

    fireEvent.click(screen.getByText("Technical details").closest("details")!.querySelector("summary")!);
    const runId = screen.getByText("run-1");
    expect(runId.closest("details")).not.toBeNull();

    const button = screen.getByRole("button", { name: "Open thread" });
    expect(button.className).toContain("border");
  });

  it("renders a Thread button on attempt rows that carry a workerThreadId", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ workerThreadId: null }), {
      attempts: [
        { ...attempt, workerThreadId: "thr_attempt" },
        { ...attempt, attemptId: "attempt-2", workerThreadId: null },
      ],
    });
    render(h(RunDetailView, { detail, ctx }));

    openSection("Attempts");
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    expect(ctx.onOpenThread).toHaveBeenCalledWith("thr_attempt");
  });

  it("renders no thread control when run and attempts have no workerThreadId", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ workerThreadId: null }), {
      attempts: [
        { ...attempt, workerThreadId: null },
        { ...attempt, attemptId: "attempt-2", workerThreadId: null },
      ],
    });
    render(h(RunDetailView, { detail, ctx }));

    openSection("Attempts");
    expect(screen.queryByRole("button", { name: "Open thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thread" })).toBeNull();
  });

  it("hides technical detail rows whose values are null", () => {
    const ctx = makeCtx();
    // A pending run may carry null thread, project, and environment ids.
    const detail = makeDetail(
      makeRun({
        status: "pending",
        startedAt: null,
        finishedAt: null,
        workerThreadId: null,
        projectId: null,
        environmentId: null,
        canonicalRecords: [],
      }),
      { attempts: [] },
    );
    render(h(RunDetailView, { detail, ctx }));

    fireEvent.click(screen.getByText("Technical details").closest("details")!.querySelector("summary")!);
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.queryByText("Environment")).toBeNull();
    expect(screen.queryByText("Attempt id")).toBeNull();
    expect(screen.getByText("Run id")).toBeTruthy();
    expect(screen.getByText("Idempotency key")).toBeTruthy();
    expect(screen.getByText("No canonical record links were recorded.")).toBeTruthy();
  });

  it("renders a Runs back control that routes to the Runs list", () => {
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    const back = screen.getByRole("button", { name: "Back to runs" });
    expect(back.textContent).toContain("Runs");
    expect(back.className).toContain("min-h-11");

    fireEvent.click(back);
    expect(ctx.onOpenSection).toHaveBeenCalledWith("runs");
  });

  it("keeps the phone summary header controls on one line with metadata wrapping below", () => {
    stubPhoneViewport(true);
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    const back = screen.getByRole("button", { name: "Back to runs" });
    const openThread = screen.getByRole("button", { name: "Open thread" });
    const header = back.parentElement as HTMLElement;
    expect(header.className).toContain("flex-wrap");
    // Open thread is a direct header child pinned right on the first line.
    expect(openThread.parentElement).toBe(header);
    expect(openThread.className).toContain("ml-auto");

    // The metadata group wraps to its own phone line (order-last, full basis)
    // and dissolves back into the header flex row at sm+.
    const meta = header.querySelector(".basis-full") as HTMLElement;
    expect(meta).not.toBeNull();
    expect(meta.className).toContain("order-last");
    expect(meta.className).toContain("sm:contents");
    expect(within(meta).getByText("manual trigger")).toBeTruthy();
    expect(within(meta).getByText("codex")).toBeTruthy();
    expect(meta.compareDocumentPosition(openThread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the attempt row action group shrinkable so the attempt id truncates", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun({ workerThreadId: null }), {
      attempts: [{
        ...attempt,
        attemptId: "attempt-very-long-identifier-0123456789",
        workerThreadId: "thr_attempt",
      }],
    });
    render(h(RunDetailView, { detail, ctx }));
    openSection("Attempts");

    const copy = screen.getByRole("button", { name: /attempt-very-long-identifier/ });
    const group = copy.parentElement as HTMLElement;
    expect(group.className).toContain("ml-auto");
    expect(group.className).toContain("min-w-0");
    expect(copy.querySelector(".truncate")).not.toBeNull();
  });
});

describe("RunDetailView section disclosure", () => {
  it("collapses Attempts by default with the count badge still visible", () => {
    const ctx = makeCtx();
    const detail = makeDetail(makeRun(), {
      attempts: [attempt, { ...attempt, attemptId: "attempt-2" }],
    });
    render(h(RunDetailView, { detail, ctx }));

    const details = screen.getByRole("heading", { name: "Attempts" }).closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("2")).toBeTruthy();
    expect(screen.queryByText("attempt-1")).toBeNull();

    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("attempt-1")).toBeTruthy();
  });

  it("keeps the Summary section and its controls visible and uncollapsed", () => {
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    expect(screen.getByRole("heading", { name: "Summary" }).closest("details")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to runs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open thread" })).toBeTruthy();
  });

  it("collapses secondary sections on phone widths while Summary stays visible", () => {
    stubPhoneViewport(true);
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    expect(screen.getByRole("button", { name: "Back to runs" })).toBeTruthy();
    for (const title of ["Timeline", "Worked on", "Canonical records", "Attempts", "Technical details"]) {
      const details = screen.getByRole("heading", { name: title }).closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(false);
    }
    expect(screen.queryByText("MON-1")).toBeNull();
  });

  it("restores a stored open choice and a stored closed choice beats the default", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:runs:attempts", "1");
    window.sessionStorage.setItem("bb-factory:section:demo:runs:worked-on", "0");
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));

    const attempts = screen.getByRole("heading", { name: "Attempts" }).closest("details") as HTMLDetailsElement;
    expect(attempts.open).toBe(true);
    expect(screen.getByText("attempt-1")).toBeTruthy();

    const workedOn = screen.getByRole("heading", { name: "Worked on" }).closest("details") as HTMLDetailsElement;
    expect(workedOn.open).toBe(false);
    expect(screen.queryByText("MON-1")).toBeNull();
  });

  it("persists a toggle to session storage across remounts", () => {
    const ctx = makeCtx();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));
    fireEvent.click(
      screen.getByRole("heading", { name: "Attempts" }).closest("details")!.querySelector("summary")!,
    );
    expect(window.sessionStorage.getItem("bb-factory:section:demo:runs:attempts")).toBe("1");

    cleanup();
    render(h(RunDetailView, { detail: makeDetail(makeRun()), ctx }));
    const attempts = screen.getByRole("heading", { name: "Attempts" }).closest("details") as HTMLDetailsElement;
    expect(attempts.open).toBe(true);
  });

  it("forceOpen reveals a stored-closed section without rewriting the stored choice", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:runs:attempts", "0");
    render(h(Section, {
      title: "Attempts",
      count: 2,
      collapsible: true,
      defaultOpen: false,
      forceOpen: true,
      storageKey: "bb-factory:section:demo:runs:attempts",
      children: h("p", null, "attempt body"),
    }));

    const details = screen.getByRole("heading", { name: "Attempts" }).closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText("attempt body")).toBeTruthy();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:runs:attempts")).toBe("0");
  });

  it("lets the user close a forced-open section", () => {
    render(h(Section, {
      title: "Attempts",
      count: 2,
      collapsible: true,
      defaultOpen: false,
      forceOpen: true,
      storageKey: "bb-factory:section:demo:runs:attempts",
      children: h("p", null, "attempt body"),
    }));

    const details = screen.getByRole("heading", { name: "Attempts" }).closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);

    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(false);
    expect(screen.queryByText("attempt body")).toBeNull();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:runs:attempts")).toBe("0");
  });

  it("leaves a click on an action button inside the summary alone", () => {
    const onEdit = vi.fn();
    render(h(Section, {
      title: "Dispatch",
      collapsible: true,
      defaultOpen: false,
      storageKey: "bb-factory:section:demo:overview:dispatch",
      actions: h("button", { type: "button", onClick: onEdit }, "Edit"),
      children: h("p", null, "dispatch body"),
    }));

    const details = screen.getByRole("heading", { name: "Dispatch" }).closest("details") as HTMLDetailsElement;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(details.querySelector("button")!, click);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(false);
    expect(details.open).toBe(false);
    expect(screen.queryByText("dispatch body")).toBeNull();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:overview:dispatch")).toBeNull();
  });

});
