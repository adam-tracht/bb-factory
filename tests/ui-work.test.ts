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

beforeAll(async () => {
  installTestPluginRuntime();
  ({ WorkView } = await import("../src/ui/views/work.js"));
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

afterEach(() => cleanup());

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
    expect(within(rowOf("BLOCKED-1")).getByText("Waiting on dependencies")).toBeTruthy();
  });
});

describe("WorkView rows", () => {
  it("renders a quiet Draft badge in the Drafts group with no CTAs", () => {
    renderWork([makeEntry({ id: "DRAFT-1", status: { kind: "draft" }, eligibilityReasons: ["not-ready"] })]);
    const drafts = sectionOf("Drafts");
    fireEvent.click(drafts.querySelector("summary")!);
    const row = rowOf("DRAFT-1");
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).queryByText("Unrecognized status")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
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
    expect(within(row).getByText("Blocked by Q6: (pipe outstanding)")).toBeTruthy();
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

  it("keeps the Ready badge and Approve CTA when the gating questions are answered", () => {
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
    expect(within(unapproved).getByText("Ready")).toBeTruthy();
    expect(within(unapproved).getByRole("button", { name: "Approve" })).toBeTruthy();
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

  it("renders the empty notice with a queue.md link when the queue is empty", () => {
    renderWork([]);
    expect(screen.getByText("The queue is empty")).toBeTruthy();
    expect(screen.getByText("Items appear here when plans/factory/queue.md defines them.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "plans/factory/queue.md" })).toBeTruthy();
  });
});
