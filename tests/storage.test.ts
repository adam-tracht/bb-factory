import type { JsonValue, PluginStorage } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BbInteractionActionRequest,
  DispatchAttempt,
  OwnershipLease,
  RepositoryActionRequest,
  RepositoryRevision,
  RunIntent,
} from "../src/contracts.js";
import {
  IdempotencyConflictError,
  PendingActionIntentExpiredError,
  initializeOperationalStorage,
  type PendingActionFileChange,
  type OperationalStateStore,
} from "../src/storage/index.js";
import { PROTOCOL_PATHS } from "../src/protocol/paths.js";

interface TestStorage extends PluginStorage {
  readonly db: Database.Database;
  readonly directory: string;
  close(): void;
}

const storages: TestStorage[] = [];

afterEach(async () => {
  while (storages.length > 0) {
    const storage = storages.pop()!;
    storage.close();
    rmSync(storage.directory, { recursive: true, force: true });
  }
});

describe("operational SQLite storage", () => {
  it("initializes through SDK storage, preserves run links, and reloads durably", async () => {
    const storage = makeStorage();
    const store = initializeOperationalStorage(storage);
    const intent = makeIntent("run-1", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000");
    const canonicalRecords = [makeCanonicalRecord(intent.runId)];

    expect(store.createRunIntent({ intent, canonicalRecords })).toEqual({ created: true, runId: intent.runId });
    store.createDispatchAttempt(makeAttempt(intent, "attempt-1"));
    store.updateRunDispatch({
      repositoryKey: intent.repositoryKey,
      runId: intent.runId,
      status: "started",
      startedAt: "2026-09-10T00:01:00Z",
      finishedAt: null,
      providerId: "codex",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      repositoryRevision: intent.baseRevision,
    });
    const lease = makeLease(intent, "lease-1");
    store.createOwnershipLease(lease);

    const detail = await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId });
    expect(detail.run?.summary).toMatchObject({
      runId: intent.runId,
      status: "started",
      providerId: "codex",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      repositoryRevision: intent.baseRevision,
      canonicalRecords,
    });
    expect(detail.run?.intent).toEqual(intent);
    expect(detail.run?.attempts).toHaveLength(1);
    expect(detail.run?.lease).toEqual(lease);
    expect(store.getCurrentOwnership(intent.repositoryKey)).toEqual(lease);

    const directory = storage.directory;
    storage.close();
    const reloadedStorage = makeStorage(directory);
    const reloadedStore = initializeOperationalStorage(reloadedStorage);
    expect((await reloadedStore.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).run?.summary).toMatchObject({
      status: "started",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      canonicalRecords,
    });
    expect((await reloadedStore.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).run?.summary.canonicalRecords).toEqual(canonicalRecords);

    reloadedStore.updateRunDispatch({
      repositoryKey: intent.repositoryKey,
      runId: intent.runId,
      status: "completed",
      startedAt: "2026-09-10T00:01:00Z",
      finishedAt: "2026-09-10T00:02:00Z",
      providerId: "codex",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      repositoryRevision: intent.baseRevision,
      canonicalRecords: [],
    });
    expect((await reloadedStore.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).run?.summary.canonicalRecords).toEqual([]);
  });

  it("bounds run reads and returns a stable cursor without copying canonical data", async () => {
    const store = newStore();
    const first = makeIntent("run-a", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000", "2026-09-10T00:00:00Z");
    const second = makeIntent("run-b", "bbf:v1:monorepo:run-now:223e4567-e89b-12d3-a456-426614174000", "2026-09-09T00:00:00Z");
    store.createRunIntent({ intent: first, canonicalRecords: [makeCanonicalRecord(first.runId)] });
    store.createRunIntent({ intent: second, canonicalRecords: [makeCanonicalRecord(second.runId)] });

    const page = await store.listRuns({ repositoryKey: "monorepo", limit: 1 });
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect((await store.listRuns({ repositoryKey: "monorepo", limit: 1, cursor: page.nextCursor! })).runs).toEqual([
      expect.objectContaining({ runId: second.runId }),
    ]);
    expect((await store.listRuns({ repositoryKey: "monorepo", limit: 100 })).runs).toHaveLength(2);
    await expect(store.listRuns({ repositoryKey: "monorepo", limit: 101 })).rejects.toThrow();
    await expect(store.listRuns({ repositoryKey: "monorepo", limit: 50, cursor: "not-a-cursor" })).rejects.toThrow("invalid operational run cursor");
    expect(await store.getRun({ repositoryKey: "monorepo", runId: "missing" })).toEqual({ run: null });

    const rawTables = store.db.prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_bb_%' ORDER BY name`,
    ).all();
    expect(rawTables.map(({ name }) => name)).toEqual([
      "dispatch_attempts",
      "operational_runs",
      "ownership_leases",
      "pending_action_intents",
      "question_answer_submissions",
      "repository_write_actions",
    ]);
  });

  it("enforces run, attempt, and active ownership uniqueness", async () => {
    const store = newStore();
    const intent = makeIntent("run-unique", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000");
    expect(store.createRunIntent({ intent })).toEqual({ created: true, runId: intent.runId });
    expect(store.createRunIntent({ intent })).toEqual({ created: false, runId: intent.runId });
    expect(() => store.createRunIntent({ intent: { ...intent, runId: "run-different" } })).toThrow(IdempotencyConflictError);

    const attempt = makeAttempt(intent, "attempt-unique");
    store.createDispatchAttempt(attempt);
    expect(() => store.createDispatchAttempt(attempt)).toThrow(/UNIQUE/i);

    const lease = makeLease(intent, "lease-unique");
    store.createOwnershipLease(lease);
    const secondIntent = makeIntent("run-second", "bbf:v1:monorepo:run-now:323e4567-e89b-12d3-a456-426614174000");
    store.createRunIntent({ intent: secondIntent });
    expect(() => store.createOwnershipLease(makeLease(secondIntent, "lease-second"))).toThrow(/UNIQUE/i);

    store.updateOwnershipLease({ ...lease, status: "released" });
    const replacement = { ...makeLease(secondIntent, "lease-second"), acquiredAt: "2026-09-10T00:02:00Z" };
    store.createOwnershipLease(replacement);
    expect(store.getCurrentOwnership("monorepo")).toEqual(replacement);
  });

  it("makes answer and repository-write submissions idempotent without storing source copies", async () => {
    const store = newStore();
    const answerKey = "bbf:v1:monorepo:answer-question:123e4567-e89b-12d3-a456-426614174000" as const;
    const answer = {
      repositoryKey: "monorepo" as const,
      idempotencyKey: answerKey,
      source: "repository-question" as const,
      targetId: "Q6",
      requestFingerprint: "answer-digest-1",
      submittedAt: "2026-09-10T00:00:00Z",
    };
    expect(store.claimQuestionAnswer(answer).created).toBe(true);
    expect(store.claimQuestionAnswer(answer)).toMatchObject({ created: false, record: { result: null } });
    expect(() => store.claimQuestionAnswer({ ...answer, requestFingerprint: "answer-digest-2" })).toThrow(IdempotencyConflictError);
    store.completeQuestionAnswer(answerKey, { status: "accepted" }, "2026-09-10T00:01:00Z");
    expect(store.getQuestionAnswer(answerKey)).toMatchObject({ result: { status: "accepted" }, completedAt: "2026-09-10T00:01:00Z" });

    const writeKey = "bbf:v1:monorepo:approve-queue:223e4567-e89b-12d3-a456-426614174000" as const;
    const write = {
      repositoryKey: "monorepo" as const,
      idempotencyKey: writeKey,
      actionKind: "approve-queue" as const,
      targetId: "Q7",
      requestFingerprint: "write-digest-1",
    };
    expect(store.claimRepositoryWrite(write).created).toBe(true);
    expect(store.claimRepositoryWrite(write).created).toBe(false);
    expect(() => store.claimRepositoryWrite({ ...write, targetId: "Q8" })).toThrow(IdempotencyConflictError);
    store.completeRepositoryWrite(writeKey, { status: "already-applied" });
    expect(store.getRepositoryWrite(writeKey)?.result).toEqual({ status: "already-applied" });

    const columns = store.db.prepare<[], { name: string }>(`PRAGMA table_info(question_answer_submissions)`).all();
    expect(columns.map(({ name }) => name)).not.toContain("question");
    expect(columns.map(({ name }) => name)).not.toContain("answer");
  });

  it("rolls back every storage mutation in a failed transaction", async () => {
    const store = newStore();
    const intent = makeIntent("run-rollback", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000");
    expect(() => store.withTransaction((transaction) => {
      transaction.createRunIntent({ intent });
      transaction.createDispatchAttempt(makeAttempt(intent, "attempt-rollback"));
      transaction.createOwnershipLease(makeLease(intent, "lease-rollback"));
      throw new Error("force rollback");
    })).toThrow("force rollback");

    expect(await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).toEqual({ run: null });
    expect(store.getCurrentOwnership(intent.repositoryKey)).toBeNull();
    expect(store.db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM dispatch_attempts`).get()).toEqual({ count: 0 });
    expect(store.db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ownership_leases`).get()).toEqual({ count: 0 });
  });

  it("persists an exact repository action intent across reload and rejects same-key payload changes", async () => {
    const storage = makeStorage();
    const store = initializeOperationalStorage(storage);
    const request = makeRepositoryAnswerRequest();
    const target = { kind: "repository-question" as const, questionId: "Q6" };
    const fileChange = makeFileChange("answer: yes\n", PROTOCOL_PATHS.questions);
    const input = { request, target, fileChange, submittedAt: "2026-09-10T00:03:00Z" };

    expect(store.claimPendingActionIntent(input)).toMatchObject({
      created: true,
      record: {
        repositoryKey: "monorepo",
        actionKind: "answer-question",
        idempotencyKey: request.idempotencyKey,
        request,
        expectedRevision: request.expectedRevision,
        target,
        fileChange,
        entryPoint: "action-executor",
        oneShot: false,
        status: "pending",
        submittedAt: "2026-09-10T00:03:00Z",
        expiresAt: null,
      },
    });

    const directory = storage.directory;
    storage.close();
    const reloadedStorage = makeStorage(directory);
    const reloadedStore = initializeOperationalStorage(reloadedStorage);
    expect(reloadedStore.getPendingActionIntent(request.idempotencyKey)).toMatchObject({ request, target, fileChange });
    expect(reloadedStore.claimPendingActionIntent(input)).toMatchObject({ created: false, record: { status: "pending" } });
    expect(() => reloadedStore.claimPendingActionIntent({
      ...input,
      request: {
        ...request,
        action: { kind: "answer-question", source: "repository-question", questionId: "Q6", answer: "no" },
      },
    })).toThrow(IdempotencyConflictError);
    expect(() => reloadedStore.claimPendingActionIntent({
      ...input,
      fileChange: { ...fileChange, expectedSha256: "c".repeat(64) },
    })).toThrow("does not match the expected repository revision");
    expect(() => reloadedStore.claimPendingActionIntent({
      ...input,
      fileChange: makeFileChange("answer: yes\n"),
    })).toThrow(`repository action file must be ${PROTOCOL_PATHS.questions}`);

    const raw = reloadedStore.db
      .prepare<[string], { request_json: string; file_change_json: string | null }>(
        `SELECT request_json, file_change_json FROM pending_action_intents WHERE idempotency_key = ?`,
      )
      .get(request.idempotencyKey)!;
    expect(raw.request_json).not.toContain("prompt");
    expect(JSON.parse(raw.file_change_json!)).toEqual(fileChange);
  });

  it("atomically claims a native-UI initial-ready intent once", () => {
    const store = newStore("2026-09-10T00:04:30Z");
    const request = makeApproveQueueRequest();
    const input = {
      request,
      queueItemId: "Q1",
      intendedChange: makeFileChange("status: ready\napproved: yes\n"),
      submittedAt: "2026-09-10T00:04:00Z",
      expiresAt: "2026-09-10T00:05:00Z",
    };

    expect(store.claimInitialReadyIntent(input)).toMatchObject({
      created: true,
      record: {
        entryPoint: "native-ui-initial-ready",
        oneShot: true,
        target: { kind: "queue-item", queueItemId: "Q1" },
        status: "pending",
        expiresAt: input.expiresAt,
      },
    });
    expect(store.claimInitialReadyIntent(input)).toMatchObject({ created: false, record: { oneShot: true } });
    expect(() => store.updatePendingActionIntent({
      idempotencyKey: request.idempotencyKey,
      status: "resolving",
    })).toThrow("atomically consumed");
    expect(store.consumePendingActionIntent(request.idempotencyKey)).toMatchObject({
      consumed: true,
      record: { status: "resolving", oneShot: true, lastAttemptAt: "2026-09-10T00:04:30Z" },
    });
    expect(store.consumePendingActionIntent(request.idempotencyKey)).toMatchObject({
      consumed: false,
      reason: "already-submitted",
      record: { status: "resolving", oneShot: true },
    });
    expect(store.listPendingActionIntents({ repositoryKey: "monorepo" })).toHaveLength(1);
    expect(store.db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM pending_action_intents`).get()).toEqual({ count: 1 });
    expect(() => store.claimPendingActionIntent({
      request,
      target: { kind: "queue-item", queueItemId: "Q1" },
      fileChange: input.intendedChange,
    })).toThrow("native-ui initial-ready claim");
  });

  it("rejects expired one-shot consumption and completion, including concurrent reuse", () => {
    const clock = { value: "2026-09-10T00:04:30Z" };
    const storage = makeStorage();
    const firstStore = initializeOperationalStorage(storage, { now: () => clock.value });
    const secondStore = initializeOperationalStorage(makeStorage(storage.directory), { now: () => clock.value });
    const request = makeApproveQueueRequest();
    const input = {
      request,
      queueItemId: "Q1",
      intendedChange: makeFileChange("status: ready\napproved: yes\n"),
      submittedAt: "2026-09-10T00:04:00Z",
      expiresAt: "2026-09-10T00:05:00Z",
    };
    firstStore.claimInitialReadyIntent(input);

    clock.value = "2026-09-10T00:05:00Z";
    expect(() => firstStore.consumePendingActionIntent(request.idempotencyKey)).toThrow(PendingActionIntentExpiredError);
    expect(firstStore.getPendingActionIntent(request.idempotencyKey)).toMatchObject({ status: "pending", oneShot: true });

    clock.value = "2026-09-10T00:04:30Z";
    expect(firstStore.consumePendingActionIntent(request.idempotencyKey)).toMatchObject({ consumed: true, record: { status: "resolving" } });
    expect(secondStore.consumePendingActionIntent(request.idempotencyKey)).toMatchObject({
      consumed: false,
      reason: "already-submitted",
      record: { status: "resolving", oneShot: true },
    });

    clock.value = "2026-09-10T00:05:30Z";
    expect(() => firstStore.updatePendingActionIntent({
      idempotencyKey: request.idempotencyKey,
      status: "completed",
      completedAt: "2026-09-10T00:04:45Z",
      result: makeApproveQueueResult(),
    })).toThrow(PendingActionIntentExpiredError);
    expect(firstStore.getPendingActionIntent(request.idempotencyKey)).toMatchObject({ status: "resolving", oneShot: true });
  });

  it("records BB submission, confirmation, and ambiguous reconciliation metadata without duplicate claims", () => {
    const store = newStore();
    const request = makeBbInteractionRequest();
    const target = {
      kind: "bb-interaction" as const,
      interactionId: "interaction-1",
      threadId: "thread-1",
      turnId: "turn-1",
    };
    const input = { request, target, submittedAt: "2026-09-10T00:06:00Z" };
    expect(store.claimPendingActionIntent(input)).toMatchObject({ created: true, record: { status: "pending" } });
    expect(() => store.updatePendingActionIntent({ idempotencyKey: request.idempotencyKey, status: "resolving" })).toThrow("atomically consumed");
    expect(store.consumePendingActionIntent(request.idempotencyKey)).toMatchObject({ consumed: true, record: { status: "resolving" } });
    const resolution = request.action.kind === "answer-question" ? request.action.resolution : null;
    const persistedResolution = store.db
      .prepare<[string], { request_json: string }>(`SELECT request_json FROM pending_action_intents WHERE idempotency_key = ?`)
      .get(request.idempotencyKey)!;
    expect(JSON.parse(persistedResolution.request_json)).toEqual(resolution);

    expect(store.updatePendingActionIntent({
      idempotencyKey: request.idempotencyKey,
      status: "resolving",
      lastAttemptAt: "2026-09-10T00:06:30Z",
      observedStatus: "resolving",
    })).toMatchObject({
      status: "resolving",
      lastAttemptAt: "2026-09-10T00:06:30Z",
      observedStatus: "resolving",
    });

    expect(resolution).not.toBeNull();
    const result = {
      ok: true as const,
      result: {
        status: "accepted" as const,
        message: "BB interaction resolved",
        revision: null,
        runId: null,
        leaseId: null,
        queueItemId: null,
        action: "answer-question" as const,
        source: "bb-interaction" as const,
        interactionId: "interaction-1",
        questionId: null,
      },
      revision: null,
    };
    expect(store.updatePendingActionIntent({
      idempotencyKey: request.idempotencyKey,
      status: "completed",
      completedAt: "2026-09-10T00:07:00Z",
      observedStatus: "resolved",
      observedResolution: resolution!,
      result,
    })).toMatchObject({
      status: "completed",
      completedAt: "2026-09-10T00:07:00Z",
      observedStatus: "resolved",
      observedResolution: resolution,
      result,
    });
    expect(store.claimPendingActionIntent(input)).toMatchObject({ created: false, record: { status: "completed", result } });
    expect(() => store.updatePendingActionIntent({ idempotencyKey: request.idempotencyKey, status: "resolving" })).toThrow("terminal");

    const ambiguousRequest = makeBbInteractionRequest("223e4567-e89b-12d3-a456-426614174000");
    const ambiguousInput = {
      request: ambiguousRequest,
      target: { ...target, interactionId: "interaction-2" },
      submittedAt: "2026-09-10T00:08:00Z",
    };
    store.claimPendingActionIntent(ambiguousInput);
    expect(store.updatePendingActionIntent({
      idempotencyKey: ambiguousRequest.idempotencyKey,
      status: "reconciliation-required",
      lastAttemptAt: "2026-09-10T00:08:30Z",
      observedStatus: "interrupted",
      lastError: "BB interaction did not resolve",
    })).toMatchObject({
      status: "reconciliation-required",
      observedStatus: "interrupted",
      lastError: "BB interaction did not resolve",
    });
    expect(() => store.updatePendingActionIntent({ idempotencyKey: ambiguousRequest.idempotencyKey, status: "completed", result })).toThrow("terminal");
  });
});

function newStore(executionNow?: string | (() => string)): OperationalStateStore {
  const now = typeof executionNow === "function"
    ? executionNow
    : executionNow === undefined
      ? undefined
      : () => executionNow;
  return initializeOperationalStorage(makeStorage(), now === undefined ? {} : { now });
}

function makeStorage(directory = mkdtempSync(join(tmpdir(), "bb-factory-storage-"))): TestStorage {
  const db = new Database(join(directory, "data.db"));
  const values = new Map<string, JsonValue>();
  let closed = false;
  const storage: TestStorage = {
    db,
    directory,
    kv: {
      async get<T>(key: string): Promise<T | undefined> {
        return values.get(key) as T | undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        values.set(key, value as JsonValue);
      },
      async delete(key: string): Promise<void> {
        values.delete(key);
      },
      async list(prefix = ""): Promise<string[]> {
        return [...values.keys()].filter((key) => key.startsWith(prefix));
      },
    },
    database: () => db,
    migrate: (database, statements) => {
      database.exec(`CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)`);
      statements.forEach((statement, id) => {
        const hash = createHash("sha256").update(statement).digest("hex");
        const applied = database.prepare<unknown[], { hash: string }>(`SELECT hash FROM _bb_migrations WHERE id = ?`).get(id);
        if (applied !== undefined && applied.hash !== hash) {
          throw new Error(`migration ${id} changed after it was applied`);
        }
        if (applied === undefined) {
          const apply = database.transaction(() => {
            database.exec(statement);
            database.prepare(`INSERT INTO _bb_migrations (id, hash) VALUES (?, ?)`).run(id, hash);
          });
          apply();
        }
      });
    },
    close: () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  storages.push(storage);
  return storage;
}

function makeRevision(relativePath: string = PROTOCOL_PATHS.queue): RepositoryRevision {
  return {
    gitCommit: "abcdef1",
    protocolDigest: "a".repeat(64),
    fileDigests: { [relativePath]: "b".repeat(64) },
  };
}

function makeRepositoryAnswerRequest(answer = "yes"): RepositoryActionRequest {
  return {
    repositoryKey: "monorepo",
    action: { kind: "answer-question", source: "repository-question", questionId: "Q6", answer },
    idempotencyKey: "bbf:v1:monorepo:answer-question:423e4567-e89b-12d3-a456-426614174000",
    expectedRevision: makeRevision(PROTOCOL_PATHS.questions),
  };
}

function makeApproveQueueRequest(): RepositoryActionRequest {
  return {
    repositoryKey: "monorepo",
    action: { kind: "approve-queue", queueItemId: "Q1", approvedText: "approved by Adam" },
    idempotencyKey: "bbf:v1:monorepo:approve-queue:523e4567-e89b-12d3-a456-426614174000",
    expectedRevision: makeRevision(),
  };
}

function makeBbInteractionRequest(uuid = "623e4567-e89b-12d3-a456-426614174000"): BbInteractionActionRequest {
  return {
    repositoryKey: "monorepo",
    action: {
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: uuid === "623e4567-e89b-12d3-a456-426614174000" ? "interaction-1" : "interaction-2",
      resolution: { kind: "user_answer", answers: { confirm: { selected: ["yes"] } } },
    },
    idempotencyKey: `bbf:v1:monorepo:answer-question:${uuid}`,
    expectedRevision: makeRevision(),
  };
}

function makeFileChange(intendedContent: string, relativePath: string = PROTOCOL_PATHS.queue): PendingActionFileChange {
  return {
    relativePath,
    expectedSha256: "b".repeat(64),
    intendedSha256: createHash("sha256").update(intendedContent).digest("hex"),
    intendedContent,
  };
}

function makeApproveQueueResult() {
  return {
    ok: true as const,
    result: {
      status: "accepted" as const,
      message: "queue item approved",
      revision: null,
      runId: null,
      leaseId: null,
      queueItemId: "Q1",
      action: "approve-queue" as const,
    },
    revision: null,
  };
}

function makeIntent(runId: string, idempotencyKey: string, requestedAt = "2026-09-10T00:00:00Z"): RunIntent {
  return {
    runId,
    repositoryKey: "monorepo",
    trigger: "manual",
    idempotencyKey: idempotencyKey as RunIntent["idempotencyKey"],
    requestedAt,
    baseRevision: makeRevision(),
    queueItemIds: ["Q1"],
    authorizationProvenance: [{ queueItemId: "Q1", source: "queue.approved", approvedText: "approved by Adam" }],
  };
}

function makeCanonicalRecord(runId: string) {
  return {
    relativePath: "plans/factory/current.md",
    recordType: "current-run" as const,
    recordId: runId,
    repositoryRevision: makeRevision(),
  };
}

function makeAttempt(intent: RunIntent, attemptId: string): DispatchAttempt {
  return {
    attemptId,
    runId: intent.runId,
    repositoryKey: intent.repositoryKey,
    providerId: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "high",
    workerThreadId: null,
    status: "pending",
    startedAt: null,
    finishedAt: null,
  };
}

function makeLease(intent: RunIntent, leaseId: string): OwnershipLease {
  return {
    leaseId,
    repositoryKey: intent.repositoryKey,
    runId: intent.runId,
    queueItemIds: intent.queueItemIds,
    workerThreadId: null,
    authorizationProvenance: ["queue.approved"],
    acquiredAt: "2026-09-10T00:00:30Z",
    expiresAt: "2026-09-10T01:00:30Z",
    status: "held",
  };
}
