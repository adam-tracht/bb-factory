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
import type { FileLinkRenderer } from "../src/ui/primitives.js";
import { RunDetailView, RunsView } from "../src/ui/views/runs.js";

const h = createElement;

afterEach(() => cleanup());

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

    const row = screen.getByRole("button", { name: /Completed/ });
    expect(row.textContent).toContain("codex");
    expect(row.textContent).toContain("1m");
    expect(row.textContent).toContain("MON-1");
    expect(row.textContent).toMatch(/ago|just now/);

    fireEvent.click(row);
    expect(ctx.onOpenRun).toHaveBeenCalledWith("run-1");
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
});

describe("RunDetailView", () => {
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
    const detail = makeDetail(makeRun({ status: "started", finishedAt: null }));
    render(h(RunDetailView, { detail, ctx }));

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Dispatches a new attempt for run run-1");

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
    // Two attempts keep the collapsible Attempts section open by default.
    const detail = makeDetail(makeRun({ workerThreadId: null }), {
      attempts: [
        { ...attempt, workerThreadId: "thr_attempt" },
        { ...attempt, attemptId: "attempt-2", workerThreadId: null },
      ],
    });
    render(h(RunDetailView, { detail, ctx }));

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
});
