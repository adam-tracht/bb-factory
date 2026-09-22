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
import { EMPTY_REPOSITORY_REVISION } from "../src/contracts.js";
import {
  IdempotencyConflictError,
  OPERATIONAL_STORAGE_MIGRATIONS,
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
  it("reopens the plugin database when the host closes the handle", async () => {
    const storage = makeStorage();
    const store = initializeOperationalStorage(storage);
    const intent = makeIntent("run-1", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000");
    store.createRunIntent({ intent, canonicalRecords: [makeCanonicalRecord(intent.runId)] });

    // The host closes the plugin's handle on dispose/reload; the next store
    // operation must resolve a fresh handle rather than failing on the stale one.
    storage.db.close();
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
    const detail = await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId });
    expect(detail.run?.summary).toMatchObject({ runId: intent.runId, status: "started" });
  });

  it("rebuilds operational_runs while foreign-key child rows reference it", async () => {
    const storage = makeStorage();
    const db = storage.db;
    // A live handle carries FK enforcement from the store getter at line ~708;
    // the fake never configures the pragma itself, so simulate that state.
    db.pragma("foreign_keys = ON");
    // Apply the migrations a pre-rebuild install already ran, leaving the
    // operational_runs rebuild tail unapplied for initialize to pick up.
    const rebuildStart = OPERATIONAL_STORAGE_MIGRATIONS.findIndex((statement) =>
      statement.startsWith("CREATE TABLE operational_runs_v2"),
    );
    storage.migrate(db, OPERATIONAL_STORAGE_MIGRATIONS.slice(0, rebuildStart));

    const intent = makeIntent("run-legacy", "bbf:v1:monorepo:run-now:723e4567-e89b-12d3-a456-426614174000");
    const attempt = makeAttempt(intent, "attempt-legacy");
    const lease = makeLease(intent, "lease-legacy");
    db.prepare(
      `INSERT INTO operational_runs (
         run_id, repository_key, trigger, idempotency_key, request_fingerprint,
         requested_at, base_revision_json, queue_item_ids_json,
         authorization_provenance_json, status, repository_revision_json,
         canonical_records_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      intent.runId,
      intent.repositoryKey,
      intent.trigger,
      intent.idempotencyKey,
      "run-legacy-fingerprint",
      intent.requestedAt,
      JSON.stringify(intent.baseRevision),
      JSON.stringify(intent.queueItemIds),
      JSON.stringify(intent.authorizationProvenance),
      JSON.stringify(intent.baseRevision),
      "[]",
    );
    db.prepare(
      `INSERT INTO dispatch_attempts (
         attempt_id, run_id, repository_key, provider_id, model, reasoning_level, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      attempt.attemptId,
      attempt.runId,
      attempt.repositoryKey,
      attempt.providerId,
      attempt.model,
      attempt.reasoningLevel,
    );
    db.prepare(
      `INSERT INTO ownership_leases (
         lease_id, repository_key, run_id, queue_item_ids_json,
         authorization_provenance_json, acquired_at, expires_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`,
    ).run(
      lease.leaseId,
      lease.repositoryKey,
      lease.runId,
      JSON.stringify(lease.queueItemIds),
      JSON.stringify(lease.authorizationProvenance),
      lease.acquiredAt,
      lease.expiresAt,
    );

    // The rebuild drops and renames operational_runs; without an FK pause the
    // drop fails on these referencing rows. Pragma is connection-level, so the
    // toggle holds across the fake's per-statement migration transactions.
    const store = initializeOperationalStorage(storage);

    const detail = await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId });
    expect(detail.run?.intent).toEqual(intent);
    expect(detail.run?.attempts).toEqual([attempt]);
    expect(detail.run?.lease).toEqual(lease);
    expect(db.prepare<[], { foreign_keys: number }>(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
  });

  it("carries populated v5 pending intents through the draft-tasks rebuild", async () => {
    const storage = makeStorage();
    const db = storage.db;
    // Apply the migrations a pre-draft-tasks install already ran, leaving the
    // v6 rebuild tail for initialize to pick up.
    const rebuildStart = OPERATIONAL_STORAGE_MIGRATIONS.findIndex((statement) =>
      statement.startsWith("CREATE TABLE pending_action_intents_v6"),
    );
    storage.migrate(db, OPERATIONAL_STORAGE_MIGRATIONS.slice(0, rebuildStart));

    const key = "bbf:v1:monorepo:recommend-approval:823e4567-e89b-12d3-a456-426614174000";
    const request = {
      repositoryKey: "monorepo",
      action: {
        kind: "recommend-approval",
        queueItemId: "T1",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
      },
      idempotencyKey: key,
      expectedRevision: EMPTY_REPOSITORY_REVISION,
    };
    db.prepare(
      `INSERT INTO pending_action_intents (
         idempotency_key, repository_key, action_kind, request_fingerprint,
         request_json, expected_revision_json, target_json, file_change_json,
         entry_point, one_shot, status, submitted_at
       ) VALUES (?, ?, 'recommend-approval', 'legacy-fingerprint', ?, ?, ?, NULL, 'action-executor', 0, 'pending', ?)`,
    ).run(
      key,
      "monorepo",
      JSON.stringify(request),
      JSON.stringify(EMPTY_REPOSITORY_REVISION),
      JSON.stringify({ kind: "queue-item", queueItemId: "T1" }),
      "2026-09-10T00:00:00Z",
    );

    const store = initializeOperationalStorage(storage);
    const record = store.getPendingActionIntent(key);
    expect(record).toMatchObject({
      repositoryKey: "monorepo",
      actionKind: "recommend-approval",
      status: "pending",
      request: {
        action: {
          kind: "recommend-approval",
          queueItemId: "T1",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
        },
      },
      target: { kind: "queue-item", queueItemId: "T1" },
    });

    // The widened CHECK accepts draft-tasks claims on the rebuilt table.
    const draftRequest: BbInteractionActionRequest = {
      repositoryKey: "monorepo",
      action: { kind: "draft-tasks", goal: "Sketch the rollout" },
      idempotencyKey: "bbf:v1:monorepo:draft-tasks:923e4567-e89b-12d3-a456-426614174000",
    };
    expect(store.claimPendingActionIntent({
      request: draftRequest,
      target: { kind: "repository" },
    })).toMatchObject({ created: true, record: { actionKind: "draft-tasks" } });
  });

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

  it("keeps the newest worker observation when an older write lands second", async () => {
    const store = newStore();
    const intent = makeIntent("run-observation-order", "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174010");
    store.createRunIntent({ intent });
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

    store.withTransaction((transaction) => {
      expect(transaction.updateRunWorkerObservation({
        repositoryKey: intent.repositoryKey,
        runId: intent.runId,
        workerObservedAt: "2026-09-10T00:02:00Z",
        workerTerminalObservedAt: "2026-09-10T00:02:00Z",
      })).toBe(true);
      expect(transaction.updateRunWorkerObservation({
        repositoryKey: intent.repositoryKey,
        runId: intent.runId,
        workerObservedAt: "2026-09-10T00:01:00Z",
        workerTerminalObservedAt: null,
      })).toBe(false);
      expect(transaction.updateRunWorkerObservation({
        repositoryKey: intent.repositoryKey,
        runId: intent.runId,
        workerObservedAt: "2026-09-10T00:02:00Z",
        workerTerminalObservedAt: null,
      })).toBe(true);
      expect(transaction.updateRunWorkerObservation({
        repositoryKey: intent.repositoryKey,
        runId: intent.runId,
        workerObservedAt: "2026-09-10T00:02:00Z",
        workerTerminalObservedAt: "2026-09-10T00:02:00Z",
      })).toBe(false);
    });

    expect((await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).run?.summary).toMatchObject({
      workerObservedAt: "2026-09-10T00:02:00Z",
      workerTerminalObservedAt: null,
    });
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
      "dispatcher_states",
      "operational_runs",
      "ownership_leases",
      "pending_action_intents",
      "question_answer_submissions",
      "repository_write_actions",
      "run_reconciliation_metadata",
      "settlement_mutation_intents",
      "stop_intents",
      "tasks_approval_records",
      "tasks_blocker_records",
      "tasks_dependency_edges",
    ]);
  });

  it("keeps reconciliation deadlines immutable and resolves them once", () => {
    const store = newStore();
    const intent = makeIntent("run-reconcile", "bbf:v1:monorepo:run-now:423e4567-e89b-12d3-a456-426614174000");
    store.createRunIntent({ intent });
    const first = store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:01:00Z",
      deadlineAt: "2026-09-10T00:11:00Z",
      reasonCode: "malformed-current-state",
      rawObservation: "state: partial",
    });
    expect(first).toMatchObject({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:01:00Z",
      deadlineAt: "2026-09-10T00:11:00Z",
      detectionCount: 1,
      resolvedAt: null,
      resolution: null,
    });
    const second = store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:03:00Z",
      deadlineAt: "2026-09-10T00:13:00Z",
      reasonCode: "malformed-current-state",
      rawObservation: "state: partial continued",
    });
    expect(second).toMatchObject({
      firstDetectedAt: first.firstDetectedAt,
      deadlineAt: first.deadlineAt,
      reasonCode: "malformed-current-state",
      rawObservation: "state: partial continued",
      detectionCount: 2,
    });
    expect(store.getReconciliation(intent.runId)).toEqual(second);

    const promoted = store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:04:00Z",
      deadlineAt: "2026-09-10T00:14:00Z",
      reasonCode: "dead-start: worker exited before evidence was readable",
      rawObservation: "worker status: error",
    });
    expect(promoted.reasonCode).toMatch(/^dead-start:/u);
    expect(promoted.deadlineAt).toBe(first.deadlineAt);

    const resolved = store.resolveReconciliation({
      runId: intent.runId,
      resolvedAt: "2026-09-10T00:11:01Z",
      resolution: "failed-safe",
      reasonCode: "reconciliation-deadline-expired",
    });
    expect(resolved).toMatchObject({
      resolvedAt: "2026-09-10T00:11:01Z",
      resolution: "failed-safe",
      reasonCode: "dead-start: worker exited before evidence was readable",
      resolutionReason: "reconciliation-deadline-expired",
    });
    expect(store.resolveReconciliation({
      runId: intent.runId,
      resolvedAt: "2026-09-10T00:12:00Z",
      resolution: "failed-safe",
      reasonCode: "repeat-finalization",
    })).toEqual(resolved);
    expect(() => store.resolveReconciliation({
      runId: intent.runId,
      resolvedAt: "2026-09-10T00:12:00Z",
      resolution: "completed",
      reasonCode: "conflicting-finalization",
    })).toThrow(/already resolved as failed-safe/);
    store.resetReconciliation(intent.runId);
    expect(store.getReconciliation(intent.runId)).toBeNull();
  });

  it("preserves reconciliation metadata across storage reopen", () => {
    const storage = makeStorage();
    const store = initializeOperationalStorage(storage);
    const intent = makeIntent("run-reconciliation-reopen", "bbf:v1:monorepo:run-now:423e4567-e89b-12d3-a456-426614174001");
    store.createRunIntent({ intent });
    store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:01:00Z",
      deadlineAt: "2026-09-10T00:11:00Z",
      reasonCode: "malformed-current-state",
      rawObservation: "state: partial",
    });
    store.resolveReconciliation({
      runId: intent.runId,
      resolvedAt: "2026-09-10T00:11:01Z",
      resolution: "failed-safe",
      reasonCode: "worker-read-timeout",
    });
    const before = store.getReconciliation(intent.runId);
    storage.close();
    const reopened = initializeOperationalStorage(storage);
    expect(reopened.getReconciliation(intent.runId)).toEqual(before);
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

  it("normalizes an absent BB interaction revision and replays it under the same key", () => {
    const store = newStore();
    const request: BbInteractionActionRequest = {
      repositoryKey: "monorepo",
      action: {
        kind: "recommend-approval",
        queueItemId: "T1",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
      },
      idempotencyKey: "bbf:v1:monorepo:recommend-approval:623e4567-e89b-12d3-a456-426614174000",
    };
    const input = { request, target: { kind: "queue-item" as const, queueItemId: "T1" } };

    expect(store.claimPendingActionIntent(input)).toMatchObject({
      created: true,
      record: { request: { expectedRevision: EMPTY_REPOSITORY_REVISION }, expectedRevision: EMPTY_REPOSITORY_REVISION },
    });
    expect(store.claimPendingActionIntent(input)).toMatchObject({ created: false, record: { status: "pending" } });
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

  it("preserves existing operational runs when reconciliation metadata is appended", async () => {
    const storage = makeStorage();
    const db = storage.db;
    // Start from a populated schema before reconciliation metadata existed.
    // initializeOperationalStorage must append both metadata migrations without
    // losing the pre-existing operational run.
    storage.migrate(db, OPERATIONAL_STORAGE_MIGRATIONS.slice(0, -2));
    const intent = makeIntent("run-before-reconciliation-migration", "bbf:v1:monorepo:run-now:923e4567-e89b-42d3-a456-426614174012");
    db.prepare(
      `INSERT INTO operational_runs (
         run_id, repository_key, trigger, idempotency_key, request_fingerprint,
         requested_at, base_revision_json, queue_item_ids_json,
         authorization_provenance_json, status, repository_revision_json,
         canonical_records_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      intent.runId,
      intent.repositoryKey,
      intent.trigger,
      intent.idempotencyKey,
      "legacy-run-fingerprint",
      intent.requestedAt,
      JSON.stringify(intent.baseRevision),
      JSON.stringify(intent.queueItemIds),
      JSON.stringify(intent.authorizationProvenance),
      JSON.stringify(intent.baseRevision),
      "[]",
    );

    const store = initializeOperationalStorage(storage);
    expect((await store.getRun({ repositoryKey: intent.repositoryKey, runId: intent.runId })).run?.intent).toEqual(intent);
    store.recordReconciliation({
      runId: intent.runId,
      firstDetectedAt: "2026-09-10T00:01:00Z",
      deadlineAt: "2026-09-10T00:11:00Z",
      reasonCode: "legacy-migration-check",
      rawObservation: null,
    });
    expect(store.getReconciliation(intent.runId)?.reasonCode).toBe("legacy-migration-check");
  });

  it("binds task approvals to content revisions and rejects dependency cycles", () => {
    const store = newStore("2026-09-21T12:00:00Z");
    const first = store.createTasksApproval({
      approvalId: "approval-1",
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "dispatch",
      contentRevision: "rev-1",
      provenance: { source: "human-ui", actor: null },
    });
    expect(store.getTasksApproval({
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "dispatch",
      contentRevision: "rev-1",
    })).toEqual(first);
    expect(store.getTasksApproval({
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "dispatch",
      contentRevision: "rev-2",
    })).toBeNull();
    expect(store.createTasksApproval({
      approvalId: "approval-2",
      repositoryKey: "monorepo",
      taskId: "task-1",
      operationClass: "dispatch",
      contentRevision: "rev-1",
      provenance: { source: "different-writer" },
    })).toEqual(first);
    expect(store.db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM tasks_approval_records",
    ).get()?.count).toBe(1);
    expect(store.db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_approval_lookup'",
    ).get()).toBeUndefined();
    expect(() => store.db.prepare(
      "UPDATE tasks_approval_records SET content_revision = ? WHERE approval_id = ?",
    ).run("rev-2", "approval-1")).toThrow("tasks approval records are append-only");
    expect(() => store.db.prepare(
      "DELETE FROM tasks_approval_records WHERE approval_id = ?",
    ).run("approval-1")).toThrow("tasks approval records are append-only");

    store.createTasksDependencyEdge({
      repositoryKey: "monorepo",
      taskId: "task-a",
      dependsOnTaskId: "task-b",
      provenance: { source: "human-ui" },
    });
    store.createTasksDependencyEdge({
      repositoryKey: "monorepo",
      taskId: "task-b",
      dependsOnTaskId: "task-c",
      provenance: { source: "human-ui" },
    });
    expect(() => store.createTasksDependencyEdge({
      repositoryKey: "monorepo",
      taskId: "task-c",
      dependsOnTaskId: "task-a",
      provenance: { source: "human-ui" },
    })).toThrow("dependency cycle rejected");

    const blocker = store.createTasksBlocker({
      blockerId: "blocker-1",
      repositoryKey: "monorepo",
      taskId: "task-a",
      kind: "blocking-question",
      questionText: "Which provider should run this?",
      provenance: { source: "human-ui" },
    });
    expect(store.updateTasksBlocker({
      blockerId: blocker.blockerId,
      state: "answered",
      answerText: "codex",
    })).toMatchObject({ state: "answered", answerText: "codex" });
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
  let handle = new Database(join(directory, "data.db"));
  const values = new Map<string, JsonValue>();
  let closed = false;
  // Match the host contract: database() reopens after the handle is closed.
  const open = (): Database.Database => {
    if (!handle.open) handle = new Database(join(directory, "data.db"));
    return handle;
  };
  const storage: TestStorage = {
    get db() {
      return open();
    },
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
    database: open,
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
        if (handle.open) handle.close();
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
