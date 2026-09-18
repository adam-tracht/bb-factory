// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type {
  ProtocolSnapshot,
  ProviderStatus,
  QueueEntry,
  RepositoryConfiguration,
  RepositoryRevision,
} from "../src/contracts.js";
import type { ViewContext } from "../src/ui/context.js";
import type { FileLinkRenderer } from "../src/ui/primitives.js";

let WorkView: (typeof import("../src/ui/views/work.js"))["WorkView"];
let doneProvenance: (typeof import("../src/ui/views/work.js"))["doneProvenance"];

beforeAll(async () => {
  installTestPluginRuntime();
  ({ WorkView, doneProvenance } = await import("../src/ui/views/work.js"));
});

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

const baseSnapshot: ProtocolSnapshot = {
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
    factoryAhead: 0,
    mainBehind: 0,
    taskCommits: [],
    safeFastForward: true,
    canonicalDashboardUrl: null,
  },
  currentRun: {
    state: "no-op",
    lastRunAt: null,
    currentPath: "plans/factory/current.md",
    latestRunPath: null,
  },
};

function snapshotWith(queue: QueueEntry[]): ProtocolSnapshot {
  return { ...baseSnapshot, queue };
}

function makeEntry(overrides: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    title: `${overrides.id} title`,
    status: { kind: "ready" },
    priority: 2,
    dependsOn: [],
    risk: "low",
    planPath: `plans/${overrides.id}.md`,
    approved: { kind: "none", source: "none" },
    acceptance: [],
    validate: [],
    notes: null,
    blockingQuestionIds: [],
    staleBlockingQuestionIds: [],
    blockedBy: [],
    eligible: false,
    eligibilityReasons: [],
    ...overrides,
  };
}

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

function renderWork(
  queue: QueueEntry[],
  ctx: ViewContext = makeCtx(),
  focusItemId?: string | null,
  options: { providers?: readonly ProviderStatus[]; preferredProviderId?: string | null } = {},
) {
  return render(h(WorkView, {
    snapshot: snapshotWith(queue),
    ctx,
    focusItemId,
    providers: options.providers,
    preferredProviderId: options.preferredProviderId,
  }));
}

function sectionOf(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("details") ?? heading.closest("section");
  if (!section) throw new Error(`no section element for ${title}`);
  return section as HTMLElement;
}

function rowOf(id: string): HTMLElement {
  const row = document.getElementById(`work-${id}`);
  if (!row) throw new Error(`no row anchored at work-${id}`);
  return row;
}

/** The row's clickable summary line is the first role=button inside the row. */
function expandRow(id: string): void {
  fireEvent.click(within(rowOf(id)).getAllByRole("button")[0]!);
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

describe("WorkView grouping", () => {
  const queue = [
    makeEntry({ id: "NEEDS-APPROVAL", eligibilityReasons: ["missing-authorization"] }),
    makeEntry({
      id: "GATED-1",
      status: { kind: "blocked-by", questionId: "Q13" },
      blockingQuestionIds: ["Q13"],
      blockedBy: ["Q13"],
      eligibilityReasons: ["blocking-question"],
    }),
    makeEntry({ id: "READY-1", eligible: true }),
    makeEntry({ id: "BLOCKED-1", dependsOn: ["READY-1"], eligibilityReasons: ["unmet-dependency"] }),
    makeEntry({ id: "UNKNOWN-1", status: { kind: "unknown", raw: "mystery-state" }, eligibilityReasons: ["not-ready"] }),
    makeEntry({ id: "RUN-1", status: { kind: "in-progress", detail: "foreman running" } }),
    makeEntry({ id: "DRAFT-1", status: { kind: "draft" }, eligibilityReasons: ["not-ready"] }),
    makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" }, eligibilityReasons: ["not-ready"] }),
  ];

  it("renders Needs you, Ready, Blocked, Running, Drafts, Done in order with counts", () => {
    renderWork(queue);
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Needs you", "Ready", "Blocked", "Running", "Drafts", "Done"]);
    expect(within(sectionOf("Needs you")).getByText("2")).toBeTruthy();
    expect(within(sectionOf("Done")).getByText("1")).toBeTruthy();
  });

  it("partitions every entry into exactly one expected group", () => {
    renderWork(queue);
    // Done and Drafts render collapsed by default; expand them so rows mount.
    fireEvent.click(sectionOf("Done").querySelector("summary")!);
    fireEvent.click(sectionOf("Drafts").querySelector("summary")!);
    const expectations: Array<[string, string[]]> = [
      ["Needs you", ["NEEDS-APPROVAL", "GATED-1"]],
      ["Ready", ["READY-1"]],
      ["Blocked", ["BLOCKED-1", "UNKNOWN-1"]],
      ["Running", ["RUN-1"]],
      ["Drafts", ["DRAFT-1"]],
      ["Done", ["DONE-1"]],
    ];
    for (const [title, ids] of expectations) {
      const section = sectionOf(title);
      for (const id of ids) {
        expect(within(section).getByText(id)).toBeTruthy();
      }
    }
    for (const entry of queue) {
      expect(screen.getAllByText(entry.id)).toHaveLength(1);
    }
  });

  it("keeps Drafts collapsed by default", () => {
    renderWork(queue);
    const drafts = sectionOf("Drafts");
    expect(drafts.tagName).toBe("DETAILS");
    expect(drafts.hasAttribute("open")).toBe(false);
    expect(document.getElementById("work-DRAFT-1")).toBeNull();
  });

  it("keeps Done collapsed by default and never renders eligibility reasons for done items", () => {
    renderWork(queue);
    const done = sectionOf("Done");
    expect(done.tagName).toBe("DETAILS");
    expect(done.hasAttribute("open")).toBe(false);
    expect(document.getElementById("work-DONE-1")).toBeNull();

    fireEvent.click(done.querySelector("summary")!);
    expandRow("DONE-1");
    expect(within(rowOf("DONE-1")).getByText(/Plan:/)).toBeTruthy();
    expect(screen.queryByText(/Status is not ready/)).toBeNull();
  });

  it("shows eligibility reasons prominently for blocked items", () => {
    renderWork(queue);
    expandRow("BLOCKED-1");
    // Collapsed status detail and the expanded detail both carry the reason.
    expect(within(rowOf("BLOCKED-1")).getAllByText("Waiting on dependencies")).toHaveLength(2);
  });
});

describe("WorkView rows", () => {
  it("renders a quiet Draft badge in the Drafts group with the Approve CTA", () => {
    renderWork([makeEntry({ id: "DRAFT-1", status: { kind: "draft" }, eligibilityReasons: ["not-ready"] })]);
    fireEvent.click(sectionOf("Drafts").querySelector("summary")!);
    const row = rowOf("DRAFT-1");
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).queryByText("Unrecognized status")).toBeNull();
    expect(within(row).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Answer/ })).toBeNull();
  });

  it("renders raw status, warning copy, and a queue.md link for unknown status", () => {
    renderWork([makeEntry({ id: "UNKNOWN-1", status: { kind: "unknown", raw: "mystery-state" }, eligibilityReasons: ["not-ready"] })]);
    expect(within(rowOf("UNKNOWN-1")).getByText("Unrecognized status")).toBeTruthy();
    expandRow("UNKNOWN-1");
    const row = rowOf("UNKNOWN-1");
    expect(within(row).getByText("Raw status: mystery-state")).toBeTruthy();
    expect(within(row).getByText(/did not recognize this status/)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "plans/factory/queue.md" })).toBeTruthy();
  });

  it("shows an Answer CTA for question-gated items that opens the questions anchor", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({
      id: "GATED-1",
      status: { kind: "blocked-by", questionId: "Q13" },
      blockingQuestionIds: ["Q13"],
      blockedBy: ["Q13"],
      eligibilityReasons: ["blocking-question"],
    })], ctx);
    fireEvent.click(screen.getByRole("button", { name: "Answer Q13" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions", "question-Q13");
  });

  it("renders a stale question gate in Needs you with a Review CTA and keeps the id in the badge", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({
      id: "STALE-1",
      status: { kind: "blocked-by", questionId: "Q6", detail: "(pipe outstanding)" },
      blockingQuestionIds: [],
      staleBlockingQuestionIds: ["Q6"],
      blockedBy: ["Q6"],
      eligibilityReasons: ["not-ready", "stale-question-gate"],
    })], ctx);
    const row = rowOf("STALE-1");
    expect(within(sectionOf("Needs you")).getByText("STALE-1")).toBeTruthy();
    expect(within(row).getByText("Blocked by Q6")).toBeTruthy();
    expect(within(row).queryByText("Blocked by Q6: (pipe outstanding)")).toBeNull();
    const detail = within(row).getByText("(pipe outstanding)");
    expect(within(row).getByRole("button", { expanded: false }).getAttribute("aria-describedby")).toBe(detail.id);
    fireEvent.click(within(row).getByRole("button", { name: "Review Q6" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions", "question-Q6");
  });

  it("keeps an answered question reference visible in the blocked detail and reachable", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({
      id: "STALE-2",
      status: { kind: "blocked-by", questionId: "Q6" },
      blockingQuestionIds: [],
      staleBlockingQuestionIds: ["Q6"],
      blockedBy: ["Q6"],
      eligibilityReasons: ["not-ready", "stale-question-gate"],
    })], ctx);
    expandRow("STALE-2");
    const row = rowOf("STALE-2");
    fireEvent.click(within(row).getByRole("button", { name: "Q6" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions", "question-Q6");
    expect(within(row).getByText(/Gating question is answered or missing/)).toBeTruthy();
  });

  it("renders a ready item gated by open questions as blocked and prefers Answer over Approve", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({
      id: "GATED-READY",
      status: { kind: "ready" },
      blockingQuestionIds: ["Q13", "Q17"],
      blockedBy: ["Q13", "Q17"],
      eligibilityReasons: ["blocking-question", "missing-authorization"],
    })], ctx);
    const row = rowOf("GATED-READY");
    expect(within(row).getByText("Blocked by Q13")).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    expect(within(sectionOf("Needs you")).getByText("GATED-READY")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Answer Q13" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions", "question-Q13");
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("hides the approve composer while open questions gate the item", () => {
    renderWork([makeEntry({
      id: "GATED-READY",
      blockingQuestionIds: ["Q13"],
      blockedBy: ["Q13"],
      eligibilityReasons: ["blocking-question", "missing-authorization"],
    })]);
    expandRow("GATED-READY");
    const row = rowOf("GATED-READY");
    expect(within(row).getByRole("button", { name: "Q13" })).toBeTruthy();
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows a blocked chip and the Approve CTA for an approval-gated entry once questions clear", () => {
    renderWork([
      makeEntry({
        id: "CLEARED-1",
        blockedBy: ["Q13"],
        eligibilityReasons: ["missing-authorization"],
      }),
      makeEntry({
        id: "CLEARED-2",
        eligible: true,
        blockedBy: ["Q13"],
        approved: { kind: "explicit", source: "queue.approved", text: "ok" },
      }),
    ]);
    const unapproved = rowOf("CLEARED-1");
    expect(within(unapproved).getByText("Blocked")).toBeTruthy();
    expect(within(unapproved).queryByText("Ready")).toBeNull();
    expect(within(unapproved).getByRole("button", { name: "Approve" })).toBeTruthy();
    const detail = document.getElementById("work-CLEARED-1-status-detail");
    expect(detail?.textContent).toContain("Needs an approved line");
    const approved = rowOf("CLEARED-2");
    expect(within(approved).getByText("Ready")).toBeTruthy();
    expect(within(approved).queryByRole("button", { name: /Approve|Answer/u })).toBeNull();
    expect(within(sectionOf("Ready")).getByText("CLEARED-2")).toBeTruthy();
  });

  it("links each .md token in the plan field while keeping commentary as plain text", () => {
    renderWork([makeEntry({
      id: "PLAN-1",
      eligible: true,
      planPath: "plans/alpha.md (Needs review questions) and plans/beta.md (Known gaps)",
    })]);
    expandRow("PLAN-1");
    const row = rowOf("PLAN-1");
    const links = within(row).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["plans/alpha.md", "plans/beta.md"]);
    expect(JSON.parse(links[0]!.getAttribute("data-target") ?? "{}")).toEqual({
      kind: "workspace",
      environmentId: "environment-1",
      path: "plans/alpha.md",
    });
    expect(row.textContent).toContain("(Needs review questions)");
    expect(row.textContent).toContain("(Known gaps)");
  });

  it("routes dependency buttons to in-repo and cross-repo work anchors", () => {
    const ctx = makeCtx();
    renderWork([
      makeEntry({ id: "DEP-1", eligible: true, dependsOn: ["READY-1", "other-repo:EXT-2.01"] }),
      makeEntry({ id: "READY-1", eligible: true }),
    ], ctx);
    expandRow("DEP-1");
    const row = rowOf("DEP-1");
    fireEvent.click(within(row).getByRole("button", { name: "READY-1" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("work", "work-READY-1");
    fireEvent.click(within(row).getByRole("button", { name: "other-repo:EXT-2.01" }));
    expect(ctx.onOpenRepository).toHaveBeenCalledWith("other-repo", "work", "work-EXT-2.01");
  });

  it("routes expanded question-gate buttons to the questions anchor", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({ id: "GATED-1", blockingQuestionIds: ["Q7", "Q8"], eligibilityReasons: ["blocking-question"] })], ctx);
    expandRow("GATED-1");
    fireEvent.click(within(rowOf("GATED-1")).getByRole("button", { name: "Q8" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("questions", "question-Q8");
  });
});

describe("WorkView approve flow", () => {
  const pendingEntry = () => makeEntry({ id: "NEEDS-1", eligibilityReasons: ["missing-authorization"], risk: "high" });

  const providers: ProviderStatus[] = [
    { providerId: "codex", model: "gpt-5", reasoningLevel: "medium", availability: "available", limitedUntil: null, activeThreadCount: 0, lastError: null },
    { providerId: "claude-code", model: "claude-sonnet-4", reasoningLevel: "high", availability: "limited", limitedUntil: "2026-09-11T00:00:00Z", activeThreadCount: 0, lastError: null },
  ];

  it("explains the approval risk and gated action scope above the composer", () => {
    const entry = makeEntry({
      id: "NEEDS-1",
      eligibilityReasons: ["missing-authorization"],
      risk: "medium",
      acceptance: ["the task is done"],
      validate: ["pnpm test"],
    });
    renderWork([entry]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const row = rowOf("NEEDS-1");
    expect(within(row).getByText("Risk: medium. Approval is required before this item can run.")).toBeTruthy();
    expect(within(row).getByText(
      "Approval lists what the factory may do beyond routine work: merges, deploys, migrations, adding or upgrading dependencies, touching secrets, deleting data, customer-facing changes. Anything unlisted stays off-limits.",
    )).toBeTruthy();
  });

  it("expands on the Approve CTA, confirms, and emits the exact approve-queue payload", () => {
    const ctx = makeCtx();
    renderWork([pendingEntry()], ctx);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const row = rowOf("NEEDS-1");
    const textarea = within(row).getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "  no gated actions  " } });

    const approveButtons = within(row).getAllByRole("button", { name: "Approve" });
    fireEvent.click(approveButtons[approveButtons.length - 1]!);

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(
      "Writes queue.approved: 'no gated actions' to plans/factory/queue.md for NEEDS-1.",
    )).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "approve-queue",
      queueItemId: "NEEDS-1",
      approvedText: "no gated actions",
    });
  });

  it("confirms routine scope and emits the canned approve-queue payload", () => {
    const ctx = makeCtx();
    renderWork([pendingEntry()], ctx);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const row = rowOf("NEEDS-1");
    fireEvent.click(within(row).getByRole("button", { name: "Routine scope only" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(
      "Writes queue.approved: 'routine implementation per plan; no merges, deploys, migrations, dependency changes, secrets, data deletion, or customer-facing changes' to plans/factory/queue.md for NEEDS-1.",
    )).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "approve-queue",
      queueItemId: "NEEDS-1",
      approvedText: "routine implementation per plan; no merges, deploys, migrations, dependency changes, secrets, data deletion, or customer-facing changes",
    });
  });

  it("opens the provider picker and dispatches recommend-approval", () => {
    const ctx = makeCtx();
    renderWork([pendingEntry()], ctx, undefined, { providers });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const row = rowOf("NEEDS-1");
    fireEvent.click(within(row).getByRole("button", { name: "Draft with agent" }));
    const dialog = screen.getByRole("alertdialog");
    const picker = within(dialog).getByTestId("bb-provider-model-picker");
    expect(picker.getAttribute("data-routing-kind")).toBe("environment");
    expect(picker.getAttribute("data-routing-id")).toBe("environment-1");

    fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "claude-sonnet-4" } });
    fireEvent.change(within(picker).getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));

    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "recommend-approval",
      queueItemId: "NEEDS-1",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
    });
  });

  it("keeps draft-with-agent disabled without a provider catalog", () => {
    const ctx = makeCtx();
    renderWork([pendingEntry()], ctx);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(within(rowOf("NEEDS-1")).getByRole("button", { name: "Draft with agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the recorded approval text instead of the composer when already approved", () => {
    renderWork([makeEntry({
      id: "APPROVED-1",
      eligible: true,
      approved: { kind: "explicit", source: "queue.approved", text: "approved by Adam" },
    })]);
    expandRow("APPROVED-1");
    const row = rowOf("APPROVED-1");
    expect(within(row).getByText("approved by Adam")).toBeTruthy();
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("emits the approve-queue payload from a draft entry's composer", () => {
    const ctx = makeCtx();
    renderWork([makeEntry({ id: "DRAFT-1", status: { kind: "draft" }, eligibilityReasons: ["not-ready"] })], ctx);
    fireEvent.click(sectionOf("Drafts").querySelector("summary")!);

    fireEvent.click(within(rowOf("DRAFT-1")).getByRole("button", { name: "Approve" }));
    const row = rowOf("DRAFT-1");
    expect(within(row).getByText("Approving marks this draft ready and writes its approved: line.")).toBeTruthy();
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "  routine work only  " } });

    const approveButtons = within(row).getAllByRole("button", { name: "Approve" });
    fireEvent.click(approveButtons[approveButtons.length - 1]!);

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(
      "Marks DRAFT-1 ready and writes queue.approved: 'routine work only' to plans/factory/queue.md.",
    )).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "approve-queue",
      queueItemId: "DRAFT-1",
      approvedText: "routine work only",
    });
  });
});

describe("WorkView draft tasks", () => {
  const providers: ProviderStatus[] = [
    { providerId: "codex", model: "gpt-5", reasoningLevel: "medium", availability: "available", limitedUntil: null, activeThreadCount: 0, lastError: null },
    { providerId: "claude-code", model: "claude-sonnet-4", reasoningLevel: "high", availability: "limited", limitedUntil: "2026-09-11T00:00:00Z", activeThreadCount: 0, lastError: null },
  ];

  it("renders the Draft tasks button and opens the dialog", () => {
    renderWork([]);
    fireEvent.click(screen.getByRole("button", { name: "Draft tasks" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/appends status: draft entries/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Goal")).toBeTruthy();
    expect(within(dialog).getByLabelText("Plan file (optional)")).toBeTruthy();
    // No provider catalog: only the automatic line renders, no radios.
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByText(/configured provider defaults are used/)).toBeTruthy();
  });

  it("keeps Start chat disabled until a goal is typed", () => {
    renderWork([]);
    fireEvent.click(screen.getByRole("button", { name: "Draft tasks" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Start chat" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "   " } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "Break the rollout into tasks" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("emits draft-tasks with the goal alone when Automatic is selected", () => {
    const ctx = makeCtx();
    renderWork([], ctx, undefined, { providers });
    fireEvent.click(screen.getByRole("button", { name: "Draft tasks" }));
    const dialog = screen.getByRole("alertdialog");
    expect((within(dialog).getByRole("radio", { name: "Automatic" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "  Draft the rollout tasks  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));
    expect(ctx.onAction).toHaveBeenCalledWith({ kind: "draft-tasks", goal: "Draft the rollout tasks" });
  });

  it("includes planPath when one is typed", () => {
    const ctx = makeCtx();
    renderWork([], ctx);
    fireEvent.click(screen.getByRole("button", { name: "Draft tasks" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "Draft the rollout tasks" } });
    fireEvent.change(within(dialog).getByLabelText("Plan file (optional)"), { target: { value: "  plans/roadmap.md  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));
    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "draft-tasks",
      goal: "Draft the rollout tasks",
      planPath: "plans/roadmap.md",
    });
  });

  it("sends the picked provider triple when Choose provider is selected", () => {
    const ctx = makeCtx();
    renderWork([], ctx, undefined, { providers });
    fireEvent.click(screen.getByRole("button", { name: "Draft tasks" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "Draft the rollout tasks" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Choose provider" }));

    const picker = within(dialog).getByTestId("bb-provider-model-picker");
    expect(picker.getAttribute("data-routing-kind")).toBe("environment");
    expect(picker.getAttribute("data-routing-id")).toBe("environment-1");
    fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "claude-sonnet-4" } });
    fireEvent.change(within(picker).getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));

    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "draft-tasks",
      goal: "Draft the rollout tasks",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
    });
  });
});

describe("WorkView focus and empty state", () => {
  it("auto-expands the focused item, exposes work-<id> anchors, and scrolls into view", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      renderWork([
        makeEntry({ id: "READY-1", eligible: true }),
        makeEntry({ id: "READY-2", eligible: true }),
      ], makeCtx(), "READY-1");
      expect(document.getElementById("work-READY-1")).not.toBeNull();
      expect(document.getElementById("work-READY-2")).not.toBeNull();
      expect(scrollSpy).toHaveBeenCalled();
      expect(within(rowOf("READY-1")).getByRole("link", { name: "plans/READY-1.md" })).toBeTruthy();
      expect(within(rowOf("READY-2")).queryByRole("link")).toBeNull();
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("scrolls to a focused row whose closed section opens after the view is already mounted", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const queue = [
      makeEntry({ id: "READY-1", eligible: true }),
      makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" }, eligibilityReasons: ["not-ready"] }),
    ];
    const ctx = makeCtx();
    try {
      const view = renderWork(queue, ctx);
      expect(document.getElementById("work-DONE-1")).toBeNull();

      view.rerender(h(WorkView, { snapshot: snapshotWith(queue), ctx, focusItemId: "DONE-1" }));

      expect((sectionOf("Done") as HTMLDetailsElement).open).toBe(true);
      const row = document.getElementById("work-DONE-1");
      expect(row).not.toBeNull();
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalled());
      expect(within(row!).getByRole("link", { name: "plans/DONE-1.md" })).toBeTruthy();
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("expands an already-mounted collapsed row when focus lands on it, and stays user-collapsible", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const queue = [
      makeEntry({ id: "READY-1", eligible: true }),
      makeEntry({ id: "READY-2", eligible: true }),
    ];
    const ctx = makeCtx();
    try {
      const view = renderWork(queue, ctx);
      expect(within(rowOf("READY-1")).queryByRole("link")).toBeNull();

      view.rerender(h(WorkView, { snapshot: snapshotWith(queue), ctx, focusItemId: "READY-1" }));
      expect(within(rowOf("READY-1")).getByRole("link", { name: "plans/READY-1.md" })).toBeTruthy();
      expect(within(rowOf("READY-2")).queryByRole("link")).toBeNull();
      expect(scrollSpy).toHaveBeenCalled();

      expandRow("READY-1");
      expect(within(rowOf("READY-1")).queryByRole("link")).toBeNull();
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("renders the empty notice with a queue.md link when the queue is empty", () => {
    renderWork([]);
    expect(screen.getByText("The queue is empty")).toBeTruthy();
    expect(screen.getByText("Items appear here when plans/factory/queue.md defines them.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "plans/factory/queue.md" })).toBeTruthy();
  });
});

describe("WorkView truthful chips and provenance", () => {
  it("shows a Blocked chip and the blocking reason for a ready-status entry in the Blocked group", () => {
    renderWork([makeEntry({
      id: "BLOCKED-READY",
      status: { kind: "ready" },
      dependsOn: ["OTHER-1"],
      eligibilityReasons: ["unmet-dependency"],
    })]);
    expect(within(sectionOf("Blocked")).getByText("BLOCKED-READY")).toBeTruthy();
    const row = rowOf("BLOCKED-READY");
    expect(within(row).getByText("Blocked")).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    const detail = document.getElementById("work-BLOCKED-READY-status-detail");
    expect(detail?.textContent).toContain("Waiting on dependencies");
  });

  it("shows a Blocked chip and the reason for an approval-gated ready entry in Needs you", () => {
    renderWork([makeEntry({
      id: "NEEDS-APPROVAL",
      eligibilityReasons: ["missing-authorization"],
    })]);
    expect(within(sectionOf("Needs you")).getByText("NEEDS-APPROVAL")).toBeTruthy();
    const row = rowOf("NEEDS-APPROVAL");
    expect(within(row).getByText("Blocked")).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    expect(within(row).getByRole("button", { name: "Approve" })).toBeTruthy();
    const detail = document.getElementById("work-NEEDS-APPROVAL-status-detail");
    expect(detail?.textContent).toContain("Needs an approved line");
  });

  it("renders a muted line in Needs you when nothing needs you", () => {
    renderWork([makeEntry({ id: "READY-1", eligible: true })]);
    expect(within(sectionOf("Needs you")).getByText("Nothing needs you right now")).toBeTruthy();
  });

  it("renders a muted line in another empty group once expanded", () => {
    renderWork([makeEntry({ id: "READY-1", eligible: true })]);
    const done = sectionOf("Done");
    expect(within(done).queryByText("Nothing done yet")).toBeNull();
    fireEvent.click(done.querySelector("summary")!);
    expect(within(done).getByText("Nothing done yet")).toBeTruthy();
  });

  it("renders done provenance with the run id as a mono chip", () => {
    renderWork([makeEntry({
      id: "DONE-RUN",
      status: { kind: "done", detail: "run run_abc123 2026-09-12" },
    })]);
    fireEvent.click(sectionOf("Done").querySelector("summary")!);
    const detail = document.getElementById("work-DONE-RUN-status-detail");
    expect(detail?.textContent).toMatch(/^Done .+ via run run_abc123$/);
    expect(rowOf("DONE-RUN").textContent).not.toContain("run run_abc123 2026-09-12");
  });

  describe("doneProvenance", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");

    it("returns a bare Done for a missing or blank detail", () => {
      expect(doneProvenance(undefined, now)).toEqual({ text: "Done", id: null });
      expect(doneProvenance("   ", now)).toEqual({ text: "Done", id: null });
    });

    it("renders a relative date and retains the free text when the detail has no id", () => {
      expect(doneProvenance("hand merged 2026-09-11", now))
        .toEqual({ text: "Done 2d ago: hand merged", id: null });
    });

    it("treats a date-only orchestrated session as via run", () => {
      expect(doneProvenance("orchestrated session 2026-09-11", now))
        .toEqual({ text: "Done 2d ago via run", id: null });
    });

    it("preserves an impossible calendar date instead of rolling it over", () => {
      // 2026-02-30 does not exist; Date.parse would silently land in March.
      expect(doneProvenance("run 2026-02-30", now))
        .toEqual({ text: "Done via run: 2026-02-30", id: null });
      expect(doneProvenance("2026-02-30", now))
        .toEqual({ text: "Done: 2026-02-30", id: null });
    });

    it("renders a run id with a relative date", () => {
      const result = doneProvenance("run run_abc123 2026-09-12", now);
      expect(result.text).toBe("Done 1d ago via run");
      expect(result.id).toBe("run_abc123");
    });

    it("renders a bare run timestamp as via run with no id", () => {
      expect(doneProvenance("run 2026-09-12T10:30:00Z", now))
        .toEqual({ text: "Done 1d ago via run", id: null });
    });

    it("renders a bare run date as via run with no id", () => {
      expect(doneProvenance("run 2026-09-12", now))
        .toEqual({ text: "Done 1d ago via run", id: null });
    });

    it("renders a workflow id via run", () => {
      expect(doneProvenance("wfr_01j2k3m4 2026-09-12", now))
        .toEqual({ text: "Done 1d ago via run", id: "wfr_01j2k3m4" });
    });

    it("renders a thread id via thread", () => {
      expect(doneProvenance("thread thr_xyz789", now)).toEqual({ text: "Done via thread", id: "thr_xyz789" });
    });

    it("accepts letter-only run, thread, and workflow ids", () => {
      expect(doneProvenance("run run_abc 2026-09-12", now))
        .toEqual({ text: "Done 1d ago via run", id: "run_abc" });
      expect(doneProvenance("thread thr_abc", now))
        .toEqual({ text: "Done via thread", id: "thr_abc" });
      expect(doneProvenance("thread thr_live", now))
        .toEqual({ text: "Done via thread", id: "thr_live" });
      expect(doneProvenance("wfr_abc 2026-09-12", now))
        .toEqual({ text: "Done 1d ago via run", id: "wfr_abc" });
    });

    it("does not treat lookalike words like run_detail as an id or a via marker", () => {
      expect(doneProvenance("run_detail recorded", now))
        .toEqual({ text: "Done: run_detail recorded", id: null });
      expect(doneProvenance("fixed run_detail run_abc", now))
        .toEqual({ text: "Done via run: fixed run_detail", id: "run_abc" });
    });

    it("keeps an invalid date as free text instead of inventing a time", () => {
      expect(doneProvenance("run 2026-13-99", now))
        .toEqual({ text: "Done via run: 2026-13-99", id: null });
    });

    it("falls back to the raw detail when nothing is parseable", () => {
      expect(doneProvenance("hand merged", now)).toEqual({ text: "Done: hand merged", id: null });
    });
  });
});

describe("WorkView phone layout", () => {
  it("clamps the row title to two lines instead of truncating", () => {
    renderWork([makeEntry({ id: "LONG-1", eligible: true })]);
    const title = within(rowOf("LONG-1")).getByText("LONG-1 title");
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).not.toContain("truncate");
  });

  it("stacks the row CTA below the summary so it cannot clip at the row's right edge", () => {
    renderWork([makeEntry({ id: "NEEDS-APPROVAL", eligibilityReasons: ["missing-authorization"] })]);
    const approve = screen.getByRole("button", { name: "Approve" });
    const slot = approve.parentElement as HTMLElement;
    // Phone: the slot takes a full line under the summary; sm+ it rejoins the row.
    expect(slot.className).toContain("basis-full");
    expect(slot.className).toContain("sm:basis-auto");
    const row = slot.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("sm:flex-nowrap");
    // The CTA sits after the expandable summary, not nested inside it.
    const summary = within(rowOf("NEEDS-APPROVAL")).getAllByRole("button")[0]!;
    expect(summary.parentElement).toBe(row);
    expect(summary.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the approval composer textarea inside the card", () => {
    renderWork([makeEntry({ id: "NEEDS-APPROVAL", eligibilityReasons: ["missing-authorization"] })]);
    expandRow("NEEDS-APPROVAL");
    const textarea = within(rowOf("NEEDS-APPROVAL")).getByRole("textbox");
    expect(textarea.className).toContain("w-full");
    expect(textarea.className).toContain("box-border");
  });
});

describe("WorkView section disclosure", () => {
  it("opens only Needs you on phone widths and keeps every count badge visible", () => {
    stubPhoneViewport(true);
    renderWork([
      makeEntry({ id: "NEEDS-1", eligibilityReasons: ["missing-authorization"] }),
      makeEntry({ id: "READY-1", eligible: true }),
      makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" } }),
    ]);
    for (const title of ["Ready", "Done"]) {
      const section = sectionOf(title) as HTMLDetailsElement;
      expect(section.open).toBe(false);
      expect(within(section).getByText("1")).toBeTruthy();
    }
    expect((sectionOf("Needs you") as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById("work-READY-1")).toBeNull();
    expect(document.getElementById("work-NEEDS-1")).not.toBeNull();
  });

  it("restores a stored open choice and a stored closed choice beats the default", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:work:done", "1");
    window.sessionStorage.setItem("bb-factory:section:demo:work:ready", "0");
    renderWork([
      makeEntry({ id: "READY-1", eligible: true }),
      makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" } }),
    ]);
    expect((sectionOf("Done") as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById("work-DONE-1")).not.toBeNull();
    expect((sectionOf("Ready") as HTMLDetailsElement).open).toBe(false);
    expect(document.getElementById("work-READY-1")).toBeNull();
  });

  it("persists a toggle to session storage across remounts", () => {
    renderWork([makeEntry({ id: "READY-1", eligible: true })]);
    fireEvent.click(sectionOf("Ready").querySelector("summary")!);
    expect(window.sessionStorage.getItem("bb-factory:section:demo:work:ready")).toBe("0");
    cleanup();
    renderWork([makeEntry({ id: "READY-1", eligible: true })]);
    expect((sectionOf("Ready") as HTMLDetailsElement).open).toBe(false);
  });

  it("force-opens the focused entry's section without rewriting the stored choice", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:work:done", "0");
    renderWork(
      [makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" } })],
      makeCtx(),
      "DONE-1",
    );
    expect((sectionOf("Done") as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById("work-DONE-1")).not.toBeNull();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:work:done")).toBe("0");
  });

  it("reloads the stored choice when the repository key changes", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:work:done", "1");
    window.sessionStorage.setItem("bb-factory:section:repo-b:work:done", "0");
    const queue = [makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" } })];
    const view = renderWork(queue);
    expect((sectionOf("Done") as HTMLDetailsElement).open).toBe(true);

    view.rerender(h(WorkView, {
      snapshot: snapshotWith(queue),
      ctx: makeCtx({ repository: { ...repository, repositoryKey: "repo-b" } }),
    }));
    const done = sectionOf("Done") as HTMLDetailsElement;
    expect(done.open).toBe(false);
    expect(document.getElementById("work-DONE-1")).toBeNull();

    fireEvent.click(done.querySelector("summary")!);
    expect(window.sessionStorage.getItem("bb-factory:section:repo-b:work:done")).toBe("1");
    expect(window.sessionStorage.getItem("bb-factory:section:demo:work:done")).toBe("1");
  });
});

describe("WorkView deep-link reveal", () => {
  it("reopens the section for a new same-section focus target after the user closed it", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const queue = [
      makeEntry({ id: "DONE-1", status: { kind: "done", detail: "shipped" } }),
      makeEntry({ id: "DONE-2", status: { kind: "done", detail: "shipped" } }),
    ];
    const ctx = makeCtx();
    try {
      const view = renderWork(queue, ctx, "DONE-1");
      const done = sectionOf("Done") as HTMLDetailsElement;
      expect(done.open).toBe(true);
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(done.querySelector("summary")!);
      expect(done.open).toBe(false);
      expect(document.getElementById("work-DONE-1")).toBeNull();

      view.rerender(h(WorkView, { snapshot: snapshotWith(queue), ctx, focusItemId: "DONE-2" }));
      expect(done.open).toBe(true);
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
      expect(document.getElementById("work-DONE-2")).not.toBeNull();

      // The same target stays closable: an unchanged focus token does not
      // force the section back open.
      fireEvent.click(done.querySelector("summary")!);
      expect(done.open).toBe(false);
      view.rerender(h(WorkView, { snapshot: snapshotWith(queue), ctx: makeCtx(), focusItemId: "DONE-2" }));
      expect(done.open).toBe(false);
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("ignores an unrelated refresh, then reveals the focused row again when a queue change regroups it", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const queue = [makeEntry({ id: "READY-1", eligible: true })];
    try {
      const view = renderWork(queue, makeCtx(), "READY-1");
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      const unrelated: RepositoryRevision = {
        ...revision,
        protocolDigest: "f".repeat(64),
        fileDigests: { ...revision.fileDigests, "plans/factory/current.md": "e".repeat(64) },
      };
      view.rerender(h(WorkView, {
        snapshot: { ...snapshotWith(queue), revision: unrelated },
        ctx: makeCtx({ revision: unrelated }),
        focusItemId: "READY-1",
      }));
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      const regrouped: RepositoryRevision = {
        ...unrelated,
        fileDigests: { ...unrelated.fileDigests, "plans/factory/queue.md": "d".repeat(64) },
      };
      const doneQueue = [makeEntry({ id: "READY-1", status: { kind: "done", detail: "shipped" } })];
      view.rerender(h(WorkView, {
        snapshot: { ...snapshotWith(doneQueue), revision: regrouped },
        ctx: makeCtx({ revision: regrouped }),
        focusItemId: "READY-1",
      }));

      const done = sectionOf("Done") as HTMLDetailsElement;
      expect(done.open).toBe(true);
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
      expect(within(done).getByText("READY-1")).toBeTruthy();
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("stops observing the document after a bounded number of mutations for a missing anchor", async () => {
    const getSpy = vi.spyOn(document, "getElementById");
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    renderWork([makeEntry({ id: "READY-1", eligible: true })], makeCtx(), "GHOST-1");
    const ghostCalls = () =>
      getSpy.mock.calls.filter(([id]) => id === "work-GHOST-1").length;
    const baseline = ghostCalls();
    expect(baseline).toBeGreaterThanOrEqual(1);

    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // The observer is bounded: it retries the known follow-up commits, then
    // disconnects instead of running a document-wide lookup forever.
    expect(disconnectSpy).toHaveBeenCalled();
    expect(ghostCalls() - baseline).toBeLessThanOrEqual(8);
    const settled = ghostCalls();
    document.body.appendChild(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ghostCalls()).toBe(settled);
  });
});
