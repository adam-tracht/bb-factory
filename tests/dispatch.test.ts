import { afterEach, describe, expect, it } from "vitest";
import type { HostPreflight, ProviderStatus } from "../src/contracts.js";
import { PROTOCOL_PATHS } from "../src/protocol/paths.js";
import { createDispatchEngine } from "../src/dispatch/index.js";
import { schedulerTick, cronMatches } from "../src/schedule/index.js";
import type { DispatchContext } from "../src/dispatch/types.js";
import {
  CHECKOUT,
  FakeFileSystem,
  cleanupStorages,
  makeProtocolReader,
  makeRegistryEntry,
  makeSettings,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

class FakeThreads {
  public threads = new Map<string, { id: string; status: string; prompt?: string; providerId?: string }>();
  public stopped: string[] = [];
  public retried: string[] = [];
  public spawnError: Error | null = null;
  private counter = 0;

  async spawn(input: { prompt: string; providerId?: string }) {
    if (this.spawnError) throw this.spawnError;
    this.counter += 1;
    const id = `thread-${this.counter}`;
    this.threads.set(id, { id, status: "active", prompt: input.prompt, providerId: input.providerId });
    return { id };
  }

  async get({ threadId }: { threadId: string }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no such thread: ${threadId}`);
    return thread;
  }

  async stop({ threadId }: { threadId: string }) {
    this.stopped.push(threadId);
    const thread = this.threads.get(threadId);
    if (thread) thread.status = "idle";
  }

  async retry({ threadId }: { threadId: string }) {
    this.retried.push(threadId);
    const thread = this.threads.get(threadId);
    if (thread) thread.status = "active";
  }
}

function provider(id: string, availability: ProviderStatus["availability"] = "available"): ProviderStatus {
  return {
    providerId: id,
    model: `${id}-model`,
    reasoningLevel: "high",
    availability,
    limitedUntil: null,
    activeThreadCount: 0,
    lastError: null,
  };
}

const OK_PREFLIGHT: HostPreflight = {
  hostId: "host-1",
  status: "online",
  checkoutExists: true,
  branch: "factory",
  requiredTools: { git: true },
  browserAvailable: null,
  dbtStudioAvailable: null,
  ok: true,
  reasons: [],
};

interface HarnessOptions {
  now?: Date;
  settings?: Parameters<typeof makeSettings>[0];
  providers?: ProviderStatus[];
  preflight?: HostPreflight;
}

function makeHarness(options: HarnessOptions = {}) {
  const files = new FakeFileSystem();
  files.seedProtocol();
  const store = makeStore();
  const threads = new FakeThreads();
  const clock = { value: options.now ?? new Date("2026-09-10T02:00:00") };
  const providers = options.providers ?? [provider("codex"), provider("claude-code")];
  const entry = makeRegistryEntry();
  const ctx: DispatchContext = {
    sdk: { threads: threads as never, files: files as never },
    store,
    protocolReader: makeProtocolReader(files),
    healthReader: {
      listProviderStatus: async () => providers,
      getHostPreflight: async () => options.preflight ?? OK_PREFLIGHT,
    },
    repositoryLookup: (key) => (key === "monorepo" ? entry : null),
    settings: makeSettings(options.settings),
    now: () => clock.value,
  };
  const engine = createDispatchEngine(ctx, () => ["monorepo"]);
  return { files, store, threads, clock, ctx, engine, providers };
}

const MANUAL_REQUEST = {
  repositoryKey: "monorepo" as const,
  trigger: "manual" as const,
  idempotencyKey: "bbf:v1:monorepo:run-now:823e4567-e89b-42d3-a456-426614174000" as never,
};

describe("dispatch engine", () => {
  it("refuses to dispatch while paused", async () => {
    const { engine, threads, store } = makeHarness({ settings: { dispatchMode: "paused" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "paused" } });
    expect(threads.threads.size).toBe(0);
    expect(store.listActiveRuns("monorepo")).toHaveLength(0);
  });

  it("starts a run: durable intent, lease, attempt, and spawned worker", async () => {
    const { engine, threads, store } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: true, result: { status: "accepted", action: "run-now" } });
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("started");
    expect(detail.run?.summary.providerId).toBe("codex");
    expect(detail.run?.summary.workerThreadId).toBe("thread-1");
    expect(detail.run?.lease?.status).toBe("held");
    expect(detail.run?.attempts).toHaveLength(1);
    expect(threads.threads.get("thread-1")?.prompt).toContain("foreman.md");
    expect(store.getDispatcherState("monorepo").lastStartProvider).toBe("codex");
  });

  it("rejects a second run while one holds ownership", async () => {
    const { engine } = makeHarness();
    const first = await engine.requestRun(MANUAL_REQUEST);
    expect(first.ok).toBe(true);
    const second = await engine.requestRun({
      ...MANUAL_REQUEST,
      idempotencyKey: "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174000",
    });
    expect(second).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("replays the recorded run for the same idempotency key", async () => {
    const { engine, threads } = makeHarness();
    await engine.requestRun(MANUAL_REQUEST);
    const second = await engine.requestRun(MANUAL_REQUEST);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.status).toBe("already-applied");
    expect(threads.threads.size).toBe(1);
  });

  it("falls back to the other provider when the lead is limited", async () => {
    const { engine, store } = makeHarness({ settings: { providerPreference: "codex" } });
    const state = store.getDispatcherState("monorepo");
    store.saveDispatcherState({
      ...state,
      limits: { codex: Math.floor(Date.parse("2026-09-10T08:00:00Z") / 1000) },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const detail = await makeHarnessResult(result.result.runId!, store);
      expect(detail.run?.summary.providerId).toBe("claude-code");
    }
  });

  it("refuses dispatch when no provider is usable", async () => {
    const { engine } = makeHarness({
      providers: [provider("codex", "unavailable"), provider("claude-code", "unavailable")],
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "provider-unavailable" } });
  });

  it("fails the preflight when the host is offline", async () => {
    const { engine } = makeHarness({
      preflight: { ...OK_PREFLIGHT, ok: false, status: "offline", reasons: ["host offline"] },
    });
    const result = await engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "host-unavailable" } });
  });

  it("completes a run when the worker wrote a fresh terminal state", async () => {
    const { engine, threads, store, files, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    const startedAt = clock.value.getTime();
    threads.threads.get("thread-1")!.status = "idle";
    files.put(
      `${CHECKOUT}/${PROTOCOL_PATHS.current}`,
      "# Latest run\n\nstate: success\n",
      startedAt + 60_000,
    );
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("completed");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    expect(store.getDispatcherState("monorepo").lastState).toBe("success");
  });

  it("marks a dead start failed-safe and limits the provider", async () => {
    const { engine, threads, store } = makeHarness({ settings: { providerPreference: "codex" } });
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    const state = store.getDispatcherState("monorepo");
    expect(state.lastState).toBe("dead-start");
    expect(state.limits["codex"] ?? 0).toBeGreaterThan(0);
  });

  it("stops an expired run via the runtime cap without limiting the provider", async () => {
    const { engine, threads, store, clock } = makeHarness();
    const result = await engine.requestRun(MANUAL_REQUEST);
    if (!result.ok) throw new Error("expected success");
    const runId = result.result.runId!;
    clock.value = new Date(2026, 8, 10, 6, 0);
    threads.threads.get("thread-1")!.status = "active";
    await engine.reconcile("monorepo");
    expect(threads.stopped).toEqual(["thread-1"]);
    let detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("cancel-requested");
    await engine.reconcile("monorepo");
    detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
    expect(store.getDispatcherState("monorepo").limits["codex"] ?? 0).toBe(0);
  });

  it("marks an ambiguous spawn for reconciliation", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    const result = await harness.engine.requestRun(MANUAL_REQUEST);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    const runs = harness.store.listActiveRuns("monorepo");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("reconciliation-required");
    await harness.engine.reconcile("monorepo");
    const detail = await harness.store.getRun({ repositoryKey: "monorepo", runId: runs[0]!.runId });
    expect(detail.run?.summary.status).toBe("reconciliation-required");
  });

  it("refuses to release ownership on a stop request for a reconciliation-required run", async () => {
    const harness = makeHarness();
    harness.threads.spawnError = new Error("connection reset during spawn");
    await harness.engine.requestRun(MANUAL_REQUEST);
    const runs = harness.store.listActiveRuns("monorepo");
    const runId = runs[0]!.runId;

    const stopped = await harness.engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: false, error: { category: "conflict" } });
    expect(harness.store.getLeaseForRun(runId)?.status).toBe("reconciliation-required");
  });

  it("requests stop on the active run and releases the lease after the worker idles", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    const stopped = await engine.requestStop("monorepo");
    expect(stopped).toMatchObject({ ok: true, result: { status: "accepted", action: "stop" } });
    expect(threads.stopped).toEqual(["thread-1"]);
    let detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("cancel-requested");
    const second = await engine.requestStop("monorepo");
    expect(second.ok && second.result.status).toBe("already-applied");
    await engine.reconcile("monorepo");
    detail = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(detail.run?.summary.status).toBe("failed-safe");
    expect(store.getLeaseForRun(runId)?.status).toBe("released");
  });

  it("retries a failed-safe run only while its thread is in error", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    const attemptId = detail.run!.attempts[0]!.attemptId;

    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: true, result: { status: "accepted", action: "retry" } });
    expect(threads.retried).toEqual(["thread-1"]);
    const after = await store.getRun({ repositoryKey: "monorepo", runId });
    expect(after.run?.summary.status).toBe("started");
    expect(after.run?.attempts).toHaveLength(2);
    expect(after.run?.lease?.status).toBe("held");
  });

  it("rejects retry when the worker is not in an error state", async () => {
    const { engine, threads, store } = makeHarness();
    const started = await engine.requestRun(MANUAL_REQUEST);
    if (!started.ok) throw new Error("expected success");
    const runId = started.result.runId!;
    threads.threads.get("thread-1")!.status = "error";
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId });
    const attemptId = detail.run!.attempts[0]!.attemptId;
    threads.threads.get("thread-1")!.status = "idle";
    const retried = await engine.requestRetry({ repositoryKey: "monorepo", attemptId });
    expect(retried).toMatchObject({ ok: false, error: { category: "conflict" } });
  });

  it("marks a run that was never dispatched as reconciliation-required after the grace period", async () => {
    const { store, engine, clock } = makeHarness();
    store.createRunIntent({
      intent: {
        runId: "run-orphan",
        repositoryKey: "monorepo",
        trigger: "schedule",
        idempotencyKey: "bbf:v1:monorepo:run-now:333e4567-e89b-42d3-a456-426614174000",
        requestedAt: clock.value.toISOString(),
        baseRevision: { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} },
        queueItemIds: [],
        authorizationProvenance: [],
      },
      canonicalRecords: [],
    });
    clock.value = new Date(clock.value.getTime() + 11 * 60 * 1000);
    await engine.reconcile("monorepo");
    const detail = await store.getRun({ repositoryKey: "monorepo", runId: "run-orphan" });
    expect(detail.run?.summary.status).toBe("reconciliation-required");
  });
});

async function makeHarnessResult(runId: string, store: ReturnType<typeof makeStore>) {
  return store.getRun({ repositoryKey: "monorepo", runId });
}

describe("scheduler", () => {
  it("matches cron fields with POSIX dom/dow semantics", () => {
    const tuesday = new Date("2026-09-08T03:30:00");
    expect(cronMatches("30 3 * * *", tuesday, "server-local")).toBe(true);
    expect(cronMatches("31 3 * * *", tuesday, "server-local")).toBe(false);
    expect(cronMatches("30 3 * * 2", tuesday, "server-local")).toBe(true);
    expect(cronMatches("30 3 * * 4", tuesday, "server-local")).toBe(false);
    expect(cronMatches("30 3 8 * 4", tuesday, "server-local")).toBe(true);
    expect(cronMatches("30 3 9 * 4", tuesday, "server-local")).toBe(false);
    expect(cronMatches("*/15 3 * * *", tuesday, "server-local")).toBe(true);
    expect(cronMatches("0-20 3 * * *", tuesday, "server-local")).toBe(false);
    expect(cronMatches("not a cron", tuesday, "server-local")).toBe(false);
  });

  it("skips when paused, unscheduled, or outside the night window", async () => {
    const paused = makeHarness({ settings: { dispatchMode: "paused", scheduleCron: "* * * * *" } });
    expect((await schedulerTick(paused.ctx, "monorepo", ["monorepo"])).reason).toBe("dispatch is paused");

    const noCron = makeHarness({ settings: { scheduleCron: undefined } });
    expect((await schedulerTick(noCron.ctx, "monorepo", ["monorepo"])).reason).toBe("no schedule configured");

    const daytime = makeHarness({
      now: new Date("2026-09-10T12:00:00"),
      settings: { scheduleCron: "* * * * *", nightWindowEndHour: 6 },
    });
    const dayResult = await schedulerTick(daytime.ctx, "monorepo", ["monorepo"]);
    expect(dayResult.action).toBe("skipped");
    expect(dayResult.reason).toContain("night window");
  });

  it("starts a scheduled run inside the night window", async () => {
    const { ctx, threads, store, clock } = makeHarness({
      now: new Date(2026, 8, 10, 2, 0),
      settings: { scheduleCron: "* * * * *", nightWindowEndHour: 6 },
    });
    const result = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(result.action).toBe("started");
    expect(threads.threads.size).toBe(1);
    expect(store.listActiveRuns("monorepo")).toHaveLength(1);

    const again = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(again.action).toBe("skipped");
    expect(again.reason).toBe("inside the minimum start gap");

    clock.value = new Date(2026, 8, 10, 4, 0);
    const held = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(held.action).toBe("skipped");
    expect(held.reason).toContain("ownership");
  });

  it("night-stops after a blocked run and honors the minimum start gap", async () => {
    const now = new Date(2026, 8, 10, 2, 0);
    const { ctx, store } = makeHarness({
      now,
      settings: { scheduleCron: "* * * * *" },
    });
    store.saveDispatcherState({
      ...store.getDispatcherState("monorepo"),
      nightKey: "2026-09-09",
      lastState: "blocked",
    });
    const blocked = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(blocked.reason).toBe("night stopped after a blocked run");

    store.saveDispatcherState({
      ...store.getDispatcherState("monorepo"),
      lastState: "",
      lastStartAt: Math.floor((now.getTime() - 30 * 60 * 1000) / 1000),
    });
    const spaced = await schedulerTick(ctx, "monorepo", ["monorepo"]);
    expect(spaced.reason).toBe("inside the minimum start gap");
  });
});
