import { afterEach, describe, expect, it, vi } from "vitest";
import {
  repositoryActionRequestSchema,
  type BbInteractionActionRequest,
  type FactoryActionResult,
  type PendingInteraction,
  type RepositoryActionRequest,
} from "../src/contracts.js";
import { PROTOCOL_PATHS } from "../src/protocol/paths.js";
import { createRepositoryActionExecutor } from "../src/actions/repository.js";
import { createBbInteractionActionExecutor } from "../src/actions/interactions.js";
import type { DispatchEngine } from "../src/dispatch/index.js";
import type { PendingInteractionReader } from "../src/ports.js";
import {
  FakeFileSystem,
  cleanupStorages,
  makeConfiguration,
  makeProtocolReader,
  makeRegistryEntry,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

function makeExecutor(files = new FakeFileSystem()) {
  files.seedProtocol();
  const store = makeStore();
  const configuration = makeConfiguration();
  const executor = createRepositoryActionExecutor({
    files: files as never,
    store,
    protocolReader: makeProtocolReader(files),
    repositoryLookup: (key) => (key === "monorepo" ? configuration : null),
  });
  return { files, store, executor };
}

async function revisionOf(harness: { files: FakeFileSystem }) {
  const reader = makeProtocolReader(harness.files);
  return (await reader.loadSnapshot(makeConfiguration())).revision;
}

function answerRequest(revision: RepositoryActionRequest["expectedRevision"], answer = "Use codex."): RepositoryActionRequest {
  return repositoryActionRequestSchema.parse({
    repositoryKey: "monorepo",
    action: { kind: "answer-question", source: "repository-question", questionId: "Q6", answer },
    idempotencyKey: "bbf:v1:monorepo:answer-question:423e4567-e89b-12d3-a456-426614174000",
    expectedRevision: revision,
  });
}

function approveRequest(revision: RepositoryActionRequest["expectedRevision"], approvedText = "no gated actions"): RepositoryActionRequest {
  return repositoryActionRequestSchema.parse({
    repositoryKey: "monorepo",
    action: { kind: "approve-queue", queueItemId: "T1", approvedText },
    idempotencyKey: "bbf:v1:monorepo:approve-queue:523e4567-e89b-12d3-a456-426614174000",
    expectedRevision: revision,
  });
}

describe("repository action executor", () => {
  it("writes a question answer in place and preserves surrounding content", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    const result = await executor.execute(answerRequest(revision));
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "answer-question", questionId: "Q6" } });
    const content = files.content(PROTOCOL_PATHS.questions)!;
    expect(content).toContain("answer: Use codex.");
    expect(content).toContain("question: Which provider should run this?");
    expect(content).toContain("context: The plan needs a choice.");
    expect(files.writes).toHaveLength(1);
    expect(files.writes[0]!.expectedSha256).toBe(revision.fileDigests[PROTOCOL_PATHS.questions]);
  });

  it("rejects a stale expected revision before any write", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    files.seed(PROTOCOL_PATHS.questions, "# changed\n");
    const result = await executor.execute(answerRequest(revision));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("stale-revision");
    expect(files.writes).toHaveLength(0);
  });

  it("rejects an unknown question and a conflicting existing answer", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    const missing = await executor.execute(repositoryActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "answer-question", source: "repository-question", questionId: "Q99", answer: "x" },
      idempotencyKey: "bbf:v1:monorepo:answer-question:623e4567-e89b-12d3-a456-426614174000",
      expectedRevision: revision,
    }));
    expect(missing).toMatchObject({ ok: false, error: { category: "not-found" } });

    files.seed(PROTOCOL_PATHS.questions, [
      "# Questions",
      "",
      "## Q6 2026-09-10 blocking T1",
      "question: Which provider should run this?",
      "context: The plan needs a choice.",
      "answer: Use claude.",
      "",
    ].join("\n"));
    const answeredRevision = await revisionOf({ files });
    const conflict = await executor.execute(answerRequest(answeredRevision));
    expect(conflict).toMatchObject({ ok: false, error: { category: "conflict" } });
    const identical = await executor.execute(answerRequest(answeredRevision, "Use claude."));
    expect(identical).toMatchObject({ ok: true, result: { status: "already-applied" } });
  });

  it("rejects approval while a blocking question is still open", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    const result = await executor.execute(approveRequest(revision));
    expect(result).toMatchObject({ ok: false, error: { category: "blocked-by-question" } });
    expect(files.writes).toHaveLength(0);
    expect(files.content(PROTOCOL_PATHS.queue)).toContain("status: blocked-by: Q6");
  });

  it("approves a queue item to ready once its blocking question is answered", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    const answered = await executor.execute(answerRequest(revision));
    expect(answered.ok).toBe(true);

    const ready = await revisionOf({ files });
    const result = await executor.execute(approveRequest(ready));
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "approve-queue", queueItemId: "T1" } });
    const content = files.content(PROTOCOL_PATHS.queue)!;
    expect(content).toContain("status: ready");
    expect(content).toContain("approved: no gated actions");
    expect(content).not.toContain("blocked-by");
  });

  it("rejects approval for a done queue item", async () => {
    const files = new FakeFileSystem();
    const queue = [
      "# Queue",
      "",
      "## T1 Sample task",
      "status: done completed last run",
      "priority: 2",
      "depends_on: none",
      "risk: low",
      "plan: plans/factory/plan-t1.md",
      "approved: none",
      "acceptance:",
      "- the task is done",
      "validate:",
      "- pnpm test",
      "notes: none",
      "",
    ].join("\n");
    const { executor } = makeExecutor(files);
    files.seed(PROTOCOL_PATHS.queue, queue);
    const revision = await revisionOf({ files });
    const result = await executor.execute(approveRequest(revision));
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(files.writes).toHaveLength(0);
  });

  it("rejects mismatched authorization on an already-explicit entry", async () => {
    const files = new FakeFileSystem();
    const queue = [
      "# Queue",
      "",
      "## T1 Sample task",
      "status: blocked-by: Q6",
      "priority: 2",
      "depends_on: none",
      "risk: high",
      "plan: plans/factory/plan-t1.md",
      "approved: dependency add",
      "acceptance:",
      "- the task is done",
      "validate:",
      "- pnpm test",
      "notes: none",
      "",
    ].join("\n");
    const { executor } = makeExecutor(files);
    files.seed(PROTOCOL_PATHS.queue, queue);
    files.seed(PROTOCOL_PATHS.questions, [
      "# Questions",
      "",
      "## Q6 2026-09-10 blocking T1",
      "question: Which provider should run this?",
      "context: The plan needs a choice.",
      "answer: Use codex.",
      "",
    ].join("\n"));
    const revision = await revisionOf({ files });
    const mismatch = await executor.execute(approveRequest(revision, "different text"));
    expect(mismatch).toMatchObject({ ok: false, error: { category: "conflict" } });
    const matching = await executor.execute(approveRequest(revision, "dependency add"));
    expect(matching).toMatchObject({ ok: true, result: { status: "accepted" } });
  });

  it("attaches an approved line to an already-ready entry that lacks one", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor(files);
    files.seed(PROTOCOL_PATHS.questions, "# Questions\n");
    files.seed(PROTOCOL_PATHS.queue, [
      "# Queue",
      "",
      "## T1 Sample task",
      "status: ready",
      "priority: 2",
      "depends_on: none",
      "risk: low",
      "plan: plans/factory/plan-t1.md",
      "approved: none",
      "acceptance:",
      "- the task is done",
      "validate:",
      "- pnpm test",
      "notes: none",
      "",
    ].join("\n"));
    const revision = await revisionOf({ files });
    const result = await executor.execute(approveRequest(revision));
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "approve-queue", queueItemId: "T1" } });
    const content = files.content(PROTOCOL_PATHS.queue)!;
    expect(content).toContain("status: ready");
    expect(content).toContain("approved: no gated actions");
    expect(files.writes).toHaveLength(1);
  });

  it("still rejects approval on a ready entry while a gating question is open", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor(files);
    files.seed(PROTOCOL_PATHS.queue, [
      "# Queue",
      "",
      "## T1 Sample task",
      "status: ready",
      "priority: 2",
      "depends_on: none",
      "risk: low",
      "plan: plans/factory/plan-t1.md",
      "approved: none",
      "acceptance:",
      "- the task is done",
      "validate:",
      "- pnpm test",
      "notes: none",
      "",
    ].join("\n"));
    const revision = await revisionOf({ files });
    const result = await executor.execute(approveRequest(revision));
    expect(result).toMatchObject({ ok: false, error: { category: "blocked-by-question" } });
    expect(files.writes).toHaveLength(0);
    expect(files.content(PROTOCOL_PATHS.queue)).toContain("approved: none");
  });

  it("replays matching approval on a ready entry and conflicts on different authorization", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor(files);
    files.seed(PROTOCOL_PATHS.questions, "# Questions\n");
    files.seed(PROTOCOL_PATHS.queue, [
      "# Queue",
      "",
      "## T1 Sample task",
      "status: ready",
      "priority: 2",
      "depends_on: none",
      "risk: low",
      "plan: plans/factory/plan-t1.md",
      "approved: dependency add",
      "acceptance:",
      "- the task is done",
      "validate:",
      "- pnpm test",
      "notes: none",
      "",
    ].join("\n"));
    const revision = await revisionOf({ files });
    const same = await executor.execute(approveRequest(revision, "dependency add"));
    expect(same).toMatchObject({ ok: true, result: { status: "already-applied" } });
    const different = await executor.execute(repositoryActionRequestSchema.parse({
      repositoryKey: "monorepo",
      action: { kind: "approve-queue", queueItemId: "T1", approvedText: "other text" },
      idempotencyKey: "bbf:v1:monorepo:approve-queue:623e4567-e89b-12d3-a456-426614174000",
      expectedRevision: revision,
    }));
    expect(different).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!different.ok) expect(different.error.message).toContain("different authorization");
    expect(files.writes).toHaveLength(0);
  });

  it("replays the recorded result for an idempotent retry without a second write", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    const request = answerRequest(revision);
    const first = await executor.execute(request);
    const second = await executor.execute(request);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(files.writes).toHaveLength(1);
  });

  it("rejects a different request under the same idempotency key", async () => {
    const { files, executor } = makeExecutor();
    const revision = await revisionOf({ files });
    await executor.execute(answerRequest(revision));
    const different = { ...answerRequest(revision, "Different answer.") };
    const result = await executor.execute(different);
    expect(result).toMatchObject({ ok: false, error: { category: "idempotency-conflict" } });
  });

  it("marks an ambiguous write failure as reconciliation-required instead of retrying", async () => {
    const files = new FakeFileSystem();
    const { executor, store } = makeExecutor(files);
    const revision = await revisionOf({ files });
    files.writeHook = () => {
      files.seed(PROTOCOL_PATHS.questions, "# tampered\n");
      throw new Error("host connection dropped mid-write");
    };
    const result = await executor.execute(answerRequest(revision));
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!result.ok) expect(result.error.message).toContain("reconciliation");
    const record = store.getPendingActionIntent("bbf:v1:monorepo:answer-question:423e4567-e89b-12d3-a456-426614174000");
    expect(record?.status).toBe("reconciliation-required");
    const retry = await executor.execute(answerRequest(revision));
    expect(retry).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("returns a CAS conflict result when the target changes between read and write", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor(files);
    const revision = await revisionOf({ files });
    files.writeHook = (path) => {
      files.put(path, "# raced\n");
    };
    const result = await executor.execute(answerRequest(revision));
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
  });
});

interface FakePendingInteraction {
  id: string;
  threadId: string;
  turnId: string | null;
  status: "pending" | "resolving" | "resolved" | "interrupted";
  statusReason: string | null;
  resolution: unknown;
  metadata: Record<string, unknown>;
  title: string;
  prompt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

function approvalInteraction(overrides: Partial<FakePendingInteraction> = {}): FakePendingInteraction {
  return {
    id: "interaction-1",
    threadId: "thread-1",
    turnId: null,
    status: "pending",
    statusReason: null,
    resolution: null,
    metadata: {
      kind: "approval",
      title: "Run command?",
      description: null,
      prompt: "pnpm test",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
      blocking: true,
    },
    title: "Run command?",
    prompt: "pnpm test",
    createdAt: "2026-09-10T00:00:00Z",
    expiresAt: null,
    ...overrides,
  };
}

function questionInteraction(overrides: Partial<FakePendingInteraction> = {}): FakePendingInteraction {
  return {
    ...approvalInteraction({
      metadata: {
        kind: "user_question",
        title: "Pick a path",
        description: null,
        questions: [{
          id: "path",
          prompt: "Which path?",
          multiSelect: false,
          allowFreeText: false,
          options: [
            { value: "a", label: "Path A" },
            { value: "b", label: "Path B" },
          ],
        }],
      },
    }),
    ...overrides,
  };
}

function pendingContract(interaction: FakePendingInteraction): PendingInteraction {
  const base = {
    source: "bb-interaction" as const,
    interactionId: interaction.id,
    threadId: interaction.threadId,
    turnId: interaction.turnId,
    status: "pending" as const,
    title: interaction.title,
    prompt: interaction.prompt,
    createdAt: interaction.createdAt,
    expiresAt: interaction.expiresAt,
  };
  if (interaction.metadata.kind === "approval") {
    return {
      ...base,
      kind: "approval",
      metadata: { kind: "approval", availableDecisions: ["allow_once", "allow_for_session", "deny"] },
    };
  }
  return {
    ...base,
    kind: "user-question",
    metadata: {
      kind: "user_question",
      questions: [{
        id: "path",
        prompt: "Which path?",
        multiSelect: false,
        allowFreeText: false,
        options: [
          { value: "a", label: "Path A" },
          { value: "b", label: "Path B" },
        ],
      }],
    },
  };
}

function makeInteractionHarness(interactions: FakePendingInteraction[] = []) {
  const store = makeStore();
  const files = new FakeFileSystem();
  files.seedProtocol();
  const resolve = vi.fn(async ({ interactionId, resolution }: { threadId: string; interactionId: string; resolution: unknown }) => {
    const target = interactions.find((item) => item.id === interactionId);
    if (!target) throw new Error("not found");
    target.status = "resolved";
    target.resolution = resolution;
    return target;
  });
  const spawn = vi.fn<(args: Record<string, unknown>) => Promise<{ id: string }>>(async () => ({ id: "thr_recommend" }));
  const threads = {
    list: vi.fn(async () => [{ id: "thread-1", environmentId: "environment-1" }]),
    spawn,
    interactions: {
      list: vi.fn(async () => interactions),
      get: vi.fn(async ({ interactionId }: { threadId: string; interactionId: string }) => {
        const found = interactions.find((item) => item.id === interactionId);
        if (!found) throw new Error("not found");
        return found;
      }),
      resolve,
    },
  };
  const interactionReader: PendingInteractionReader = {
    async listPendingInteractions() {
      return {
        repositoryKey: "monorepo",
        interactions: interactions
          .filter((item) => item.status === "pending")
          .map(pendingContract),
      };
    },
  };
  const accepted = (message: string, action: "run-now" | "retry" | "stop", leaseId: string | null): FactoryActionResult => ({
    ok: true,
    revision: null,
    result: { status: "accepted", message, revision: null, runId: "run-1", leaseId, queueItemId: null, action, questionId: null, interactionId: null },
  } as FactoryActionResult);
  const dispatch: DispatchEngine = {
    requestRun: vi.fn(async () => accepted("run started", "run-now", "lease-1")),
    requestRetry: vi.fn(async () => accepted("retry started", "retry", "lease-1")),
    requestStop: vi.fn(async () => accepted("stop requested", "stop", null)),
    reconcile: vi.fn(async () => undefined),
  };
  const setDispatchMode = vi.fn(async () => undefined);
  const entry = makeRegistryEntry();
  const executor = createBbInteractionActionExecutor({
    threads: threads as never,
    store,
    interactionReader,
    protocolReader: makeProtocolReader(files),
    repositoryLookup: (key) => (key === "monorepo" ? entry : null),
    dispatch,
    setDispatchMode,
  });
  return { store, files, spawn, threads, resolve, dispatch, setDispatchMode, executor, entry };
}

let interactionUuid = 0;
function bbRequest(action: BbInteractionActionRequest["action"]): BbInteractionActionRequest {
  interactionUuid += 1;
  return {
    repositoryKey: "monorepo",
    action,
    idempotencyKey: `bbf:v1:monorepo:${action.kind}:${String(interactionUuid).padStart(8, "0")}-0000-4000-8000-000000000000`,
    expectedRevision: { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} },
  };
}

describe("BB interaction action executor", () => {
  it("marks the intent for reconciliation when dispatch throws after the claim", async () => {
    const harness = makeInteractionHarness([]);
    vi.mocked(harness.dispatch.requestRun).mockRejectedValue(new Error("store write lost"));
    const request = bbRequest({ kind: "run-now" });
    const result = await harness.executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    const record = harness.store.getPendingActionIntent(request.idempotencyKey);
    expect(record?.status).toBe("reconciliation-required");
    const replay = await harness.executor.execute(request);
    expect(replay).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("fails closed when the pending-interaction read fails before resolve", async () => {
    const harness = makeInteractionHarness([approvalInteraction()]);
    const failingReader: PendingInteractionReader = {
      listPendingInteractions: async () => {
        throw new Error("projection unavailable");
      },
    };
    const executor = createBbInteractionActionExecutor({
      threads: harness.threads as never,
      store: harness.store,
      interactionReader: failingReader,
      protocolReader: makeProtocolReader(harness.files),
      repositoryLookup: (key) => (key === "monorepo" ? harness.entry : null),
      dispatch: harness.dispatch,
      setDispatchMode: harness.setDispatchMode,
    });
    const result = await executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "allow_once" },
    }));
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    expect(harness.resolve).not.toHaveBeenCalled();
  });

  it("resolves an approval interaction and records the observed resolution", async () => {
    const harness = makeInteractionHarness([approvalInteraction()]);
    const result = await harness.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "allow_once" },
    }));
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "answer-question", source: "bb-interaction", interactionId: "interaction-1" } });
    expect(harness.resolve).toHaveBeenCalledWith({
      threadId: "thread-1",
      interactionId: "interaction-1",
      resolution: { decision: "allow_once", grantedPermissions: null },
    });
  });

  it("validates user answers against the offered options before resolving", async () => {
    const harness = makeInteractionHarness([questionInteraction()]);
    const bad = await harness.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "user_answer", answers: { path: { selected: ["not-offered"] } } },
    }));
    expect(bad).toMatchObject({ ok: false, error: { category: "invalid-input" } });
    expect(harness.resolve).not.toHaveBeenCalled();

    const good = await harness.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "user_answer", answers: { path: { selected: ["a"] } } },
    }));
    expect(good.ok).toBe(true);
    expect(harness.resolve).toHaveBeenCalledWith({
      threadId: "thread-1",
      interactionId: "interaction-1",
      resolution: { kind: "user_answer", answers: { path: { selected: ["a"] } } },
    });
  });

  it("rejects answers for unknown questions in the interaction metadata", async () => {
    const harness = makeInteractionHarness([questionInteraction()]);
    const result = await harness.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "user_answer", answers: { missing: { selected: ["a"] } } },
    }));
    expect(result).toMatchObject({ ok: false, error: { category: "invalid-input" } });
  });

  it("replays a matching already-resolved interaction and marks mismatches for reconciliation", async () => {
    const resolved = approvalInteraction({ status: "resolved", resolution: { decision: "allow_once" } });
    const harness = makeInteractionHarness([resolved]);
    const replay = await harness.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "allow_once" },
    }));
    expect(replay.ok).toBe(true);
    expect(harness.resolve).not.toHaveBeenCalled();

    const mismatched = approvalInteraction({ status: "resolved", resolution: { decision: "deny" } });
    const harness2 = makeInteractionHarness([mismatched]);
    const conflict = await harness2.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "allow_once" },
    }));
    expect(conflict).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("marks interrupted and still-resolving interactions for reconciliation", async () => {
    const interrupted = makeInteractionHarness([approvalInteraction({ status: "interrupted", statusReason: "thread failed" })]);
    const interruptedResult = await interrupted.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "deny" },
    }));
    expect(interruptedResult).toMatchObject({ ok: false, error: { category: "conflict" } });

    const resolving = makeInteractionHarness([approvalInteraction({ status: "resolving" })]);
    const resolvingResult = await resolving.executor.execute(bbRequest({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: "interaction-1",
      resolution: { kind: "approval", decision: "deny" },
    }));
    expect(resolvingResult).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("routes run-now, pause, resume, retry, and stop through dispatch", async () => {
    const harness = makeInteractionHarness([]);
    const runNow = await harness.executor.execute(bbRequest({ kind: "run-now" }));
    expect(runNow).toMatchObject({ ok: true, result: { runId: "run-1" } });
    expect(harness.dispatch.requestRun).toHaveBeenCalledWith(expect.objectContaining({ repositoryKey: "monorepo", trigger: "manual" }));

    await harness.executor.execute(bbRequest({ kind: "pause" }));
    expect(harness.setDispatchMode).toHaveBeenCalledWith("paused");
    await harness.executor.execute(bbRequest({ kind: "resume" }));
    expect(harness.setDispatchMode).toHaveBeenCalledWith("enabled");

    await harness.executor.execute(bbRequest({ kind: "retry", attemptId: "attempt-1" }));
    expect(harness.dispatch.requestRetry).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "attempt-1" }));

    await harness.executor.execute(bbRequest({ kind: "stop" }));
    expect(harness.dispatch.requestStop).toHaveBeenCalledWith("monorepo");
  });

  it("passes an explicit run-now execution triple and service tier to dispatch", async () => {
    const harness = makeInteractionHarness([]);
    const result = await harness.executor.execute(bbRequest({
      kind: "run-now",
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: "high",
      serviceTier: "fast",
    }));
    expect(result.ok).toBe(true);
    expect(harness.dispatch.requestRun).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "monorepo",
      trigger: "manual",
      providerOverride: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" },
      serviceTier: "fast",
    }));
  });

  it("omits the override keys when run-now carries none", async () => {
    const harness = makeInteractionHarness([]);
    await harness.executor.execute(bbRequest({ kind: "run-now" }));
    const input = vi.mocked(harness.dispatch.requestRun).mock.calls[0]![0];
    expect("providerOverride" in input).toBe(false);
    expect("serviceTier" in input).toBe(false);
  });

  it("rejects a partial run-now provider override at the schema boundary", async () => {
    const harness = makeInteractionHarness([]);
    const result = await harness.executor.execute(bbRequest({ kind: "run-now", providerId: "codex" }));
    expect(result).toMatchObject({ ok: false, error: { category: "invalid-input" } });
    expect(harness.dispatch.requestRun).not.toHaveBeenCalled();
  });

  it("deduplicates an identical action under the same idempotency key", async () => {
    const harness = makeInteractionHarness([]);
    const request = bbRequest({ kind: "run-now" });
    const first = await harness.executor.execute(request);
    const second = await harness.executor.execute(request);
    expect(second).toEqual(first);
    expect(harness.dispatch.requestRun).toHaveBeenCalledTimes(1);
  });

  it("spawns an advisory recommendation thread scoped to the repository", async () => {
    const harness = makeInteractionHarness([]);
    const request = bbRequest({
      kind: "recommend-question",
      questionId: "Q6",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
    const result = await harness.executor.execute(request);
    expect(result).toMatchObject({
      ok: true,
      result: { status: "accepted", action: "recommend-question", questionId: "Q6", threadId: "thr_recommend" },
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const spawned = vi.mocked(harness.spawn).mock.calls[0]![0];
    expect(spawned).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "environment-1" },
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "auto",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    const prompt = spawned.prompt as string;
    expect(prompt).toContain("Which provider should run this?");
    expect(prompt).toContain("Q6");
    expect(prompt).toContain("T1");
    expect(prompt).toContain("Advisory only");

    const replay = await harness.executor.execute(request);
    expect(replay).toMatchObject({ ok: true, result: { threadId: "thr_recommend" } });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("uses the display name only for a recommendation thread title", async () => {
    const harness = makeInteractionHarness([]);
    harness.entry.displayName = "Core repo";
    const request = bbRequest({
      kind: "recommend-question",
      questionId: "Q6",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    });

    const result = await harness.executor.execute(request);
    expect(result.ok).toBe(true);
    const spawned = vi.mocked(harness.spawn).mock.calls[0]![0];
    expect(spawned.title).toBe("factory recommend: Core repo Q6");
    expect(spawned.prompt).toContain('repository "monorepo"');
    expect(spawned.prompt).not.toContain('repository "Core repo"');
  });

  it("spawns an advisory approval-drafting thread scoped to a queue item", async () => {
    const harness = makeInteractionHarness([]);
    const action = {
      kind: "recommend-approval",
      queueItemId: "T1",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
      serviceTier: "fast",
    } as const;
    const request = bbRequest(action);
    const result = await harness.executor.execute(request);
    expect(result).toMatchObject({
      ok: true,
      result: { status: "accepted", action: "recommend-approval", queueItemId: "T1", threadId: "thr_recommend" },
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const spawned = vi.mocked(harness.spawn).mock.calls[0]![0];
    expect(spawned).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "environment-1" },
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "auto",
      title: "factory recommend: monorepo T1",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    const prompt = spawned.prompt as string;
    expect(prompt).toContain("T1");
    expect(prompt).toContain("Sample task");
    expect(prompt).toContain("Status: blocked by Q6");
    expect(prompt).toContain("Risk: low");
    expect(prompt).toContain("Plan: plans/factory/plan-t1.md");
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain("- the task is done");
    expect(prompt).toContain("Validate commands:");
    expect(prompt).toContain("- pnpm test");
    expect(prompt).toContain("The approved: line can permit these gated actions only: merges, deploys, migrations, adding or upgrading dependencies, touching secrets, deleting data, customer-facing changes.");
    expect(prompt).toContain("approved:");
    expect(prompt).toContain("what stays excluded");
    expect(prompt).toContain("Advisory only");

    const replay = await harness.executor.execute(request);
    expect(replay).toMatchObject({ ok: true, result: { threadId: "thr_recommend", queueItemId: "T1" } });
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    const conflict = await harness.executor.execute({
      ...request,
      action: { ...action, queueItemId: "T2" },
    });
    expect(conflict).toMatchObject({ ok: false, error: { category: "idempotency-conflict" } });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects an approval recommendation for a queue item missing from the protocol", async () => {
    const harness = makeInteractionHarness([]);
    const result = await harness.executor.execute(bbRequest({
      kind: "recommend-approval",
      queueItemId: "T99",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { category: "not-found", message: "Queue item 'T99' is not in plans/factory/queue.md." },
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("marks an ambiguous approval recommendation spawn for reconciliation without respawning", async () => {
    const harness = makeInteractionHarness([]);
    vi.mocked(harness.spawn).mockRejectedValue(new Error("spawn lost"));
    const request = bbRequest({
      kind: "recommend-approval",
      queueItemId: "T1",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    });
    const result = await harness.executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.store.getPendingActionIntent(request.idempotencyKey)?.status).toBe("reconciliation-required");
    const replay = await harness.executor.execute(request);
    expect(replay).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects a recommendation for a question missing from the protocol", async () => {
    const harness = makeInteractionHarness([]);
    const result = await harness.executor.execute(bbRequest({
      kind: "recommend-question",
      questionId: "Q99",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    }));
    expect(result).toMatchObject({ ok: false, error: { category: "not-found" } });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("marks an ambiguous recommendation spawn for reconciliation without respawning", async () => {
    const harness = makeInteractionHarness([]);
    vi.mocked(harness.spawn).mockRejectedValue(new Error("spawn lost"));
    const request = bbRequest({
      kind: "recommend-question",
      questionId: "Q6",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    });
    const result = await harness.executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.store.getPendingActionIntent(request.idempotencyKey)?.status).toBe("reconciliation-required");
    const replay = await harness.executor.execute(request);
    expect(replay).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });
});
