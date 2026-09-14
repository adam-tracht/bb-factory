// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type {
  PendingInteraction,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  ProviderStatus,
  Question,
  QueueEntry,
} from "../src/contracts.js";
import type { ViewContext } from "../src/ui/context.js";

const h = createElement;

let QuestionsView: (typeof import("../src/ui/views/questions.js"))["QuestionsView"];

beforeAll(async () => {
  installTestPluginRuntime();
  ({ QuestionsView } = await import("../src/ui/views/questions.js"));
});

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

const revision = {
  gitCommit: "abc1234",
  protocolDigest: "a".repeat(64),
  fileDigests: { "plans/factory/questions.md": "b".repeat(64) },
} as const;

const repository = {
  repositoryKey: "demo",
  repositoryRoot: "/work/demo",
  connectedHostId: "host-1",
  checkoutPath: "/work/demo",
  factoryBranch: "factory" as const,
  mainRef: "origin/main",
};

function makeQuestion(overrides: Partial<Question>): Question {
  return {
    id: "Q1",
    date: "2026-09-08",
    classification: "blocking",
    dashboardId: "T1",
    question: "Default question text",
    context: "Some context.",
    assumed: null,
    answer: null,
    ...overrides,
  };
}

function makeQueueEntry(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    id: "MON-0",
    title: "Queue item",
    status: { kind: "ready" },
    priority: 2,
    dependsOn: [],
    risk: "low",
    planPath: "plans/m0.md",
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

const questions: Question[] = [
  makeQuestion({
    id: "Q4",
    classification: "blocking",
    question: "Which rollout order is safe?",
    context: "See plans/rollout.md",
    answer: "## Secret heading\n\nShip MON-1 first.",
  }),
  makeQuestion({
    id: "Q3",
    classification: "assumption",
    question: "Is nightly compaction acceptable?",
    context: "Runs during the night window.",
    assumed: "Assume nightly compaction is fine.",
  }),
  makeQuestion({
    id: "Q1",
    classification: "blocking",
    question: "Which payment provider should the worker use?",
    context: "The plan needs a provider choice.",
  }),
  makeQuestion({
    id: "Q2",
    classification: "blocking",
    question: "Should the migration run online?",
    context: "The table is large.",
  }),
];

const queue: QueueEntry[] = [
  makeQueueEntry({ id: "MON-1", blockedBy: ["Q1"], blockingQuestionIds: ["Q1"] }),
  makeQueueEntry({ id: "MON-2", status: { kind: "blocked-by", questionId: "Q2" } }),
];

function makeSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    repository,
    revision,
    capturedAt: "2026-09-10T12:00:00Z",
    foremanTemplate: {
      authority: "repository-protocol",
      relativePath: "plans/factory/foreman.md",
      contentSha256: "c".repeat(64),
      repositoryRevision: revision,
    },
    queue,
    questions,
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
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<PendingInteraction>): PendingInteraction {
  return {
    source: "bb-interaction",
    interactionId: "int-1",
    threadId: "thr_1",
    turnId: "turn-1",
    status: "pending",
    title: "Interaction title",
    prompt: "Interaction prompt",
    createdAt: "2026-09-10T12:00:00Z",
    expiresAt: null,
    kind: "approval",
    metadata: { kind: "approval", availableDecisions: ["allow_once", "allow_for_session", "deny"] },
    ...overrides,
  } as PendingInteraction;
}

function makeInteractions(interactions: PendingInteraction[]): PendingInteractionsProjection {
  return { repositoryKey: "demo", interactions };
}

function makeCtx(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    repository,
    environmentId: "env-1",
    projectId: "proj-1",
    dispatchPaused: false,
    revision,
    feedback: null,
    pendingTarget: null,
    onOpenSection: vi.fn(),
    onOpenRepository: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenProject: vi.fn(),
    onAction: vi.fn(),
    updateSettings: vi.fn(),
    updateRepository: vi.fn(),
    addRepository: vi.fn(),
    loadRegistryOptions: vi.fn(),
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(),
    probeRepository: vi.fn(),
    resolveRepositoryProject: vi.fn(),
    ...overrides,
  };
}

function renderView(overrides: {
  snapshot?: ProtocolSnapshot;
  interactions?: PendingInteractionsProjection | null;
  ctx?: ViewContext;
  focusQuestionId?: string | null;
  providers?: readonly ProviderStatus[];
  preferredProviderId?: string | null;
} = {}) {
  const ctx = overrides.ctx ?? makeCtx();
  const view = render(
    h(QuestionsView, {
      snapshot: overrides.snapshot ?? makeSnapshot(),
      interactions: overrides.interactions ?? null,
      ctx,
      focusQuestionId: overrides.focusQuestionId ?? null,
      providers: overrides.providers,
      preferredProviderId: overrides.preferredProviderId,
    }),
  );
  return { ...view, ctx };
}

describe("QuestionsView repository questions", () => {
  it("sorts open blocking before assumption before the answered group", () => {
    const { container } = renderView();
    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const ids = Array.from(container.querySelectorAll("[id^='question-']")).map((el) => el.id);
    expect(ids).toEqual(["question-Q1", "question-Q2", "question-Q3", "question-Q4"]);
  });

  it("resolves Blocks: via blockedBy and via blocked-by status", () => {
    const { container, ctx } = renderView();
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);
    const q2 = within(container.querySelector("#question-Q2") as HTMLElement);
    const q3 = within(container.querySelector("#question-Q3") as HTMLElement);

    fireEvent.click(q1.getByRole("button", { name: "MON-1" }));
    expect(ctx.onOpenSection).toHaveBeenCalledWith("work", "work-MON-1");
    expect(q2.getByRole("button", { name: "MON-2" })).toBeDefined();
    expect(q3.queryByText(/Blocks:/)).toBeNull();
  });

  it("Accept assumption submits the assumed text through the same confirm", () => {
    const { container, ctx } = renderView();
    const q3 = within(container.querySelector("#question-Q3") as HTMLElement);
    fireEvent.click(q3.getByRole("button", { name: "Accept assumption" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Appends to plans/factory/questions.md on branch factory.");
    expect(dialog.textContent).toContain("Q3 gates: no items.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record answer" }));

    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "answer-question",
      source: "repository-question",
      questionId: "Q3",
      answer: "Assume nightly compaction is fine.",
    });
  });

  it("composer confirm fires onAction with the exact repository-question payload", () => {
    const { container, ctx } = renderView();
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);

    fireEvent.change(q1.getByLabelText("Answer Q1"), { target: { value: "Use the mock provider." } });
    fireEvent.click(q1.getByRole("button", { name: "Record answer" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Q1 gates: MON-1.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record answer" }));

    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "answer-question",
      source: "repository-question",
      questionId: "Q1",
      answer: "Use the mock provider.",
    });

    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const answeredQ1 = container.querySelector("#question-Q1") as HTMLElement;
    expect(within(answeredQ1).queryByLabelText("Answer Q1")).toBeNull();
    expect(within(answeredQ1).getByText("Recorded")).toBeDefined();
  });

  it("keeps the answered group collapsed by default", () => {
    const { container } = renderView();
    const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(within(group).getByRole("heading", { name: "Answered" })).toBeDefined();
    expect(container.querySelector("#question-Q4")).toBeNull();
    fireEvent.click(group.querySelector("summary")!);
    expect(container.querySelector("#question-Q4")).not.toBeNull();
  });

  it("demotes markdown headings in recorded answers so no h2 is rendered", () => {
    const { container } = renderView();
    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const q4 = container.querySelector("#question-Q4") as HTMLElement;
    fireEvent.click(q4.querySelector("details summary")!);
    const blocks = Array.from(container.querySelectorAll("[data-testid='bb-markdown']"));
    const answerBlock = blocks.find((el) => el.textContent?.includes("Secret heading"));
    expect(answerBlock?.textContent).toContain("**Secret heading**");
    const headings = Array.from(container.querySelectorAll("h1, h2, h3"));
    expect(headings.some((el) => el.textContent?.includes("Secret heading"))).toBe(false);
  });

  it("narrows the list with the text, kind, and state filters", () => {
    const { container } = renderView();
    const questionIds = () =>
      Array.from(container.querySelectorAll("[id^='question-']")).map((el) => el.id);

    fireEvent.change(screen.getByLabelText("Filter questions"), { target: { value: "payment" } });
    expect(questionIds()).toEqual(["question-Q1"]);

    fireEvent.change(screen.getByLabelText("Filter questions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Question kind"), { target: { value: "assumption" } });
    expect(questionIds()).toEqual(["question-Q3"]);

    fireEvent.change(screen.getByLabelText("Question kind"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Question state"), { target: { value: "answered" } });
    expect(questionIds()).toEqual(["question-Q4"]);

    fireEvent.change(screen.getByLabelText("Question state"), { target: { value: "open" } });
    expect(questionIds()).toEqual(["question-Q1", "question-Q2", "question-Q3"]);
  });

  it("expands and reveals an answered question when focused", () => {
    const { container } = renderView({ focusQuestionId: "Q4" });
    const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    const row = container.querySelector("#question-Q4") as HTMLElement;
    const rowDetails = row.querySelector("details") as HTMLDetailsElement | null;
    expect(rowDetails?.open).toBe(true);
  });

  it("reveals an answered question focused after the view is already mounted", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const ctx = makeCtx();
    try {
      const view = renderView({ ctx });
      const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
      expect(group.open).toBe(false);
      expect(view.container.querySelector("#question-Q4")).toBeNull();

      view.rerender(h(QuestionsView, {
        snapshot: makeSnapshot(),
        interactions: null,
        ctx,
        focusQuestionId: "Q4",
      }));

      expect(group.open).toBe(true);
      const row = view.container.querySelector("#question-Q4") as HTMLElement;
      expect(row).not.toBeNull();
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalled());
      const rowDetails = row.querySelector("details") as HTMLDetailsElement | null;
      expect(rowDetails?.open).toBe(true);
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("reveals an open question focused after the view mounted while its group was stored closed", async () => {
    window.sessionStorage.setItem("bb-factory:section:demo:questions:open", "0");
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const ctx = makeCtx();
    try {
      const view = renderView({ ctx });
      const group = screen.getByRole("heading", { name: "Open" }).closest("details") as HTMLDetailsElement;
      expect(group.open).toBe(false);
      expect(view.container.querySelector("#question-Q1")).toBeNull();

      view.rerender(h(QuestionsView, {
        snapshot: makeSnapshot(),
        interactions: null,
        ctx,
        focusQuestionId: "Q1",
      }));

      expect(group.open).toBe(true);
      expect(view.container.querySelector("#question-Q1")).not.toBeNull();
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("re-arms a focused question when the repository changes", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const otherRepository = { ...repository, repositoryKey: "other" };
    try {
      const view = renderView({ focusQuestionId: "Q1" });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      view.rerender(h(QuestionsView, {
        snapshot: makeSnapshot({ repository: otherRepository }),
        interactions: null,
        ctx: makeCtx({ repository: otherRepository }),
        focusQuestionId: "Q1",
      }));

      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });
});

describe("QuestionsView agent recommendation", () => {
  const providers: ProviderStatus[] = [
    { providerId: "codex", model: "gpt-5", reasoningLevel: "medium", availability: "available", limitedUntil: null, activeThreadCount: 0, lastError: null },
    { providerId: "claude-code", model: "claude-sonnet-4", reasoningLevel: "high", availability: "limited", limitedUntil: "2026-09-11T00:00:00Z", activeThreadCount: 0, lastError: null },
  ];

  it("opens the provider picker and dispatches the recommend-question action", () => {
    const { container, ctx } = renderView({ providers });
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);

    fireEvent.click(q1.getByRole("button", { name: "Ask an agent" }));
    const dialog = screen.getByRole("alertdialog");
    const picker = within(dialog).getByTestId("bb-provider-model-picker");
    expect(picker.getAttribute("data-routing-kind")).toBe("environment");
    expect(picker.getAttribute("data-routing-id")).toBe("env-1");

    fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "claude-sonnet-4" } });
    fireEvent.change(within(picker).getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));

    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "recommend-question",
      questionId: "Q1",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
    });
  });

  it("seeds the picker with the preferred provider", () => {
    const { container } = renderView({ providers, preferredProviderId: "claude-code" });
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);
    fireEvent.click(q1.getByRole("button", { name: "Ask an agent" }));
    const picker = screen.getByTestId("bb-provider-model-picker");
    expect(within(picker).getByLabelText("Provider ID")).toHaveProperty("value", "claude-code");
    expect(within(picker).getByLabelText("Model")).toHaveProperty("value", "claude-sonnet-4");
  });

  it("keeps the ask action disabled without a provider catalog", () => {
    const { container } = renderView({ providers: [] });
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);
    const button = q1.getByRole("button", { name: "Ask an agent" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("QuestionsView BB interactions", () => {
  const approval = makeInteraction({
    interactionId: "int-1",
    threadId: "thr_1",
    kind: "approval",
    title: "Allow the run to install deps?",
    prompt: "The worker wants network access.",
  });
  const userQuestion = makeInteraction({
    interactionId: "int-2",
    threadId: "thr_2",
    kind: "user-question",
    title: "The worker needs direction",
    prompt: "Answer to unblock the run.",
    metadata: {
      kind: "user_question",
      questions: [
        {
          id: "q1",
          prompt: "Pick an option",
          multiSelect: false,
          allowFreeText: false,
          options: [
            { label: "Alpha", value: "a" },
            { label: "Beta", value: "b" },
          ],
        },
        {
          id: "q2",
          prompt: "Any notes",
          multiSelect: false,
          allowFreeText: true,
        },
        {
          id: "q3",
          prompt: "Choose tools",
          multiSelect: true,
          allowFreeText: false,
          options: [
            { label: "X tool", value: "x" },
            { label: "Y tool", value: "y" },
          ],
        },
      ],
    },
  });
  const plugin = makeInteraction({
    interactionId: "int-3",
    threadId: "thr_3",
    kind: "plugin",
    title: "Plugin handoff",
    prompt: "Continue in the thread.",
    metadata: { kind: "plugin" },
  });

  it("renders an approval interaction and submits each decision", () => {
    const { container, ctx } = renderView({
      interactions: makeInteractions([approval]),
      snapshot: makeSnapshot({ questions: [] }),
    });
    const row = within(container.querySelector("#interaction-int-1") as HTMLElement);
    expect(row.getByText("Allow the run to install deps?")).toBeDefined();
    expect(row.getByText("The worker wants network access.")).toBeDefined();

    fireEvent.click(row.getByRole("button", { name: "Allow once" }));
    expect(ctx.onAction).toHaveBeenLastCalledWith({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "int-1",
      resolution: { kind: "approval", decision: "allow_once" },
    });

    fireEvent.click(row.getByRole("button", { name: "Allow for session" }));
    expect(ctx.onAction).toHaveBeenLastCalledWith({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "int-1",
      resolution: { kind: "approval", decision: "allow_for_session" },
    });

    fireEvent.click(row.getByRole("button", { name: "Deny" }));
    expect(ctx.onAction).toHaveBeenLastCalledWith({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "int-1",
      resolution: { kind: "approval", decision: "deny" },
    });
  });

  it("renders a user-question interaction and submits a user_answer resolution", () => {
    const { container, ctx } = renderView({
      interactions: makeInteractions([userQuestion]),
      snapshot: makeSnapshot({ questions: [] }),
    });
    const row = within(container.querySelector("#interaction-int-2") as HTMLElement);

    const answerButton = row.getByRole("button", { name: "Answer" });
    expect(answerButton.hasAttribute("disabled") || answerButton.getAttribute("disabled") !== null).toBe(true);

    fireEvent.change(row.getByLabelText("Pick an option"), { target: { value: "a" } });
    fireEvent.change(row.getByLabelText("Any notes (free text)"), { target: { value: "note here" } });
    fireEvent.click(row.getByLabelText(/X tool/));
    fireEvent.click(row.getByLabelText(/Y tool/));

    fireEvent.click(row.getByRole("button", { name: "Answer" }));
    expect(ctx.onAction).toHaveBeenCalledWith({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "int-2",
      resolution: {
        kind: "user_answer",
        answers: {
          q1: { selected: ["a"] },
          q2: { selected: [], freeText: "note here" },
          q3: { selected: ["x", "y"] },
        },
      },
    });
  });

  it("renders a plugin interaction with a thread link only", () => {
    const { container, ctx } = renderView({
      interactions: makeInteractions([plugin]),
      snapshot: makeSnapshot({ questions: [] }),
    });
    const row = within(container.querySelector("#interaction-int-3") as HTMLElement);
    fireEvent.click(row.getByRole("button", { name: "Respond in the thread" }));
    expect(ctx.onOpenThread).toHaveBeenCalledWith("thr_3");
  });
});

describe("QuestionsView phone layout", () => {
  it("clamps an answered question summary to two lines with the full question text", () => {
    const longQuestion =
      "Should the rollout proceed in a single step across every repository, or should it be staged gradually so each repository can be verified independently first?";
    renderView({
      snapshot: makeSnapshot({
        questions: [makeQuestion({ id: "Q9", question: longQuestion, answer: "Staged." })],
      }),
    });
    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const summary = within(answeredGroup).getByText(longQuestion);
    expect(summary.className).toContain("line-clamp-2");
  });

  it("keeps the Answered and Recorded chips unsquashed next to a long question title", () => {
    const longQuestion =
      "Should the rollout proceed in a single step across every repository, or should it be staged gradually so each repository can be verified independently first?";
    const { container } = renderView({
      snapshot: makeSnapshot({
        questions: [
          makeQuestion({ id: "Q8", question: longQuestion, answer: "Staged." }),
          makeQuestion({ id: "Q9", question: `${longQuestion} And in what order?` }),
        ],
      }),
    });
    const q9 = within(container.querySelector("#question-Q9") as HTMLElement);
    fireEvent.change(q9.getByLabelText("Answer Q9"), { target: { value: "Noted." } });
    fireEvent.click(q9.getByRole("button", { name: "Record answer" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Record answer" }),
    );

    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const q8Row = container.querySelector("#question-Q8") as HTMLElement;
    const q9Row = container.querySelector("#question-Q9") as HTMLElement;
    expect(within(q8Row).getByText("Answered").className).toContain("shrink-0");
    expect(within(q9Row).getByText("Recorded").className).toContain("shrink-0");
  });

  it("reveals the full question text when an answered row is expanded", () => {
    const longQuestion =
      "Should the rollout proceed in a single step across every repository, or should it be staged gradually so each repository can be verified independently first?";
    const { container } = renderView({
      snapshot: makeSnapshot({
        questions: [makeQuestion({ id: "Q9", question: longQuestion, answer: "Staged." })],
      }),
    });
    const answeredGroup = screen.getByTestId("answered-questions");
    fireEvent.click(answeredGroup.querySelector("summary")!);
    const row = container.querySelector("#question-Q9") as HTMLElement;
    fireEvent.click(row.querySelector("details summary")!);
    expect(within(row).getAllByText(longQuestion)).toHaveLength(2);
  });

  it("wraps long gated task ids and keeps the open-gated handler", () => {
    const longId = "MON-LONG-0123456789-ABCDEFGHIJ-KLMNOPQRSTUVWXYZ";
    const { container, ctx } = renderView({
      snapshot: makeSnapshot({
        queue: [makeQueueEntry({ id: longId, blockedBy: ["Q1"], blockingQuestionIds: ["Q1"] })],
      }),
    });
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);
    const chip = q1.getByRole("button", { name: longId });
    expect(chip.className).toContain("break-all");
    expect(chip.className).toContain("max-w-full");
    fireEvent.click(chip);
    expect(ctx.onOpenSection).toHaveBeenCalledWith("work", `work-${longId}`);
  });

  it("gives the filter input its own phone line with the selects as wrapping siblings", () => {
    renderView();
    const input = screen.getByLabelText("Filter questions");
    const row = input.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    // The input fills the row on phones; flex grow takes over at sm+.
    expect(input.className).toContain("w-full");
    expect(input.className).toContain("sm:flex-1");
    // A padded w-full control needs border-box to stay inside the row.
    expect(input.className).toContain("box-border");
    expect(within(row).getByLabelText("Question kind")).toBeTruthy();
    expect(within(row).getByLabelText("Question state")).toBeTruthy();
  });

  it("keeps the answer composer and its actions inside the card on phones", () => {
    const { container } = renderView();
    const q1 = within(container.querySelector("#question-Q1") as HTMLElement);
    const textarea = q1.getByLabelText("Answer Q1");
    expect(textarea.className).toContain("w-full");
    expect(textarea.className).toContain("box-border");

    const record = q1.getByRole("button", { name: "Record answer" });
    const group = record.parentElement as HTMLElement;
    expect(group.className).toContain("ml-auto");
    expect(group.className).toContain("flex-wrap");
    const actionRow = group.parentElement as HTMLElement;
    expect(actionRow.className).toContain("flex-wrap");
    expect(within(actionRow).getByRole("button", { name: "Ask an agent" })).toBeTruthy();
  });
});

describe("QuestionsView section disclosure", () => {
  it("restores a stored open choice for the Answered group", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:questions:answered", "1");
    const { container } = renderView();
    const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(container.querySelector("#question-Q4")).not.toBeNull();
  });

  it("force-opens the Answered group for a focused question without rewriting storage", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:questions:answered", "0");
    renderView({ focusQuestionId: "Q4" });
    const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(window.sessionStorage.getItem("bb-factory:section:demo:questions:answered")).toBe("0");
  });

  it("force-opens a stored-closed Open group for a focused open question and stays closable", () => {
    window.sessionStorage.setItem("bb-factory:section:demo:questions:open", "0");
    const { container } = renderView({ focusQuestionId: "Q1" });
    const group = screen.getByRole("heading", { name: "Open" }).closest("details") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(container.querySelector("#question-Q1")).not.toBeNull();
    expect(window.sessionStorage.getItem("bb-factory:section:demo:questions:open")).toBe("0");

    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(false);
    expect(container.querySelector("#question-Q1")).toBeNull();
  });

  it("reopens the Answered section for a new focused question after the user closed it", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    const twoAnswered = makeSnapshot({
      questions: [
        makeQuestion({ id: "Q4", question: "First answered", answer: "Ship first." }),
        makeQuestion({ id: "Q5", question: "Second answered", answer: "Ship second." }),
        makeQuestion({ id: "Q1" }),
      ],
    });
    const ctx = makeCtx();
    try {
      const view = renderView({ snapshot: twoAnswered, ctx, focusQuestionId: "Q4" });
      const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
      expect(group.open).toBe(true);
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));

      fireEvent.click(group.querySelector("summary")!);
      expect(group.open).toBe(false);
      expect(view.container.querySelector("#question-Q4")).toBeNull();

      view.rerender(h(QuestionsView, {
        snapshot: twoAnswered,
        interactions: null,
        ctx,
        focusQuestionId: "Q5",
      }));
      expect(group.open).toBe(true);
      expect(view.container.querySelector("#question-Q5")).not.toBeNull();
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));

      // The same target stays closable: re-rendering an unchanged focus does
      // not force the section back open.
      fireEvent.click(group.querySelector("summary")!);
      expect(group.open).toBe(false);
      view.rerender(h(QuestionsView, {
        snapshot: twoAnswered,
        interactions: null,
        ctx: makeCtx(),
        focusQuestionId: "Q5",
      }));
      expect(group.open).toBe(false);
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("collapses BB questions on phone widths while Open stays open with its count", () => {
    stubPhoneViewport(true);
    const { container } = renderView({
      interactions: makeInteractions([makeInteraction({ interactionId: "int-1" })]),
    });
    const bb = screen.getByRole("heading", { name: "BB questions" }).closest("details") as HTMLDetailsElement;
    expect(bb.open).toBe(false);
    expect(within(bb).getByText("1")).toBeTruthy();
    const open = screen.getByRole("heading", { name: "Open" }).closest("details") as HTMLDetailsElement;
    expect(open.open).toBe(true);
    expect(container.querySelector("#question-Q1")).not.toBeNull();
  });
});

describe("QuestionsView refresh re-arm", () => {
  it("does not re-scroll a focused question when an unrelated protocol file changes", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const view = renderView({ focusQuestionId: "Q1" });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      const refreshed = {
        ...revision,
        protocolDigest: "f".repeat(64),
        fileDigests: { ...revision.fileDigests, "plans/factory/current.md": "e".repeat(64) },
      };
      view.rerender(h(QuestionsView, {
        snapshot: makeSnapshot({ revision: refreshed }),
        interactions: null,
        ctx: makeCtx({ revision: refreshed }),
        focusQuestionId: "Q1",
      }));

      expect(scrollSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("reveals the focused question again when a questions.md change moves it to Answered", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const view = renderView({ focusQuestionId: "Q1" });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      const refreshed = {
        ...revision,
        fileDigests: { ...revision.fileDigests, "plans/factory/questions.md": "f".repeat(64) },
      };
      const answered = makeSnapshot({
        revision: refreshed,
        questions: questions.map((question) =>
          question.id === "Q1" ? { ...question, answer: "Use the mock provider." } : question),
      });
      view.rerender(h(QuestionsView, {
        snapshot: answered,
        interactions: null,
        ctx: makeCtx({ revision: refreshed }),
        focusQuestionId: "Q1",
      }));

      const group = screen.getByTestId("answered-questions") as HTMLDetailsElement;
      expect(group.open).toBe(true);
      const row = view.container.querySelector("#question-Q1") as HTMLElement;
      expect(row).not.toBeNull();
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
      const rowDetails = row.querySelector("details") as HTMLDetailsElement | null;
      expect(rowDetails?.open).toBe(true);
    } finally {
      if (original) {
        Element.prototype.scrollIntoView = original;
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });
});
