import type { PluginStorage, JsonValue } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { z } from "zod";
import type {
  CanonicalFileRecordLink,
  DispatchAttempt,
  IdempotencyKey,
  OperationalRunDetail,
  OperationalRunDetailInput,
  OperationalRunDetailProjection,
  OperationalRunListInput,
  OperationalRunListProjection,
  OperationalRunStatus,
  OperationalRunSummary,
  OwnershipLease,
  RepositoryKey,
  RepositoryRevision,
  RunIntent,
} from "../contracts.js";
import {
  canonicalFileRecordLinkSchema,
  dispatchAttemptSchema,
  idempotencyKeySchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  operationalRunSummarySchema,
  ownershipLeaseSchema,
  repositoryKeySchema,
  repositoryRevisionSchema,
  runIntentSchema,
} from "../contracts.js";
import type { OperationalStateReader } from "../ports.js";

type SqliteDatabase = Database.Database;

const canonicalRecordsSchema = z.array(canonicalFileRecordLinkSchema);
const dispatchedRunStatusSchema = z.enum([
  "started",
  "completed",
  "failed-safe",
  "blocked",
  "no-op",
  "cancel-requested",
  "reconciliation-required",
]);

/**
 * Each entry is one immutable migration slot. Append new SQL only at the end.
 * The SDK owns `_bb_migrations`, statement hashing, and migration transactions.
 */
export const OPERATIONAL_STORAGE_MIGRATIONS = [
  `CREATE TABLE operational_runs (
    run_id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'recovery')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    base_revision_json TEXT NOT NULL,
    queue_item_ids_json TEXT NOT NULL,
    authorization_provenance_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'completed', 'failed-safe', 'blocked', 'no-op', 'cancel-requested', 'reconciliation-required')),
    started_at TEXT,
    finished_at TEXT,
    provider_id TEXT,
    worker_thread_id TEXT,
    project_id TEXT,
    environment_id TEXT,
    repository_revision_json TEXT NOT NULL,
    canonical_records_json TEXT NOT NULL,
    CHECK (status = 'pending' OR (provider_id IS NOT NULL AND worker_thread_id IS NOT NULL AND project_id IS NOT NULL AND environment_id IS NOT NULL))
  )`,
  `CREATE TABLE dispatch_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES operational_runs(run_id),
    repository_key TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_level TEXT NOT NULL CHECK (reasoning_level IN ('none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode')),
    worker_thread_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'completed', 'failed-safe', 'blocked', 'no-op', 'cancel-requested', 'reconciliation-required')),
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (run_id, attempt_id)
  )`,
  `CREATE TABLE ownership_leases (
    lease_id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES operational_runs(run_id),
    queue_item_ids_json TEXT NOT NULL,
    worker_thread_id TEXT,
    authorization_provenance_json TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('held', 'release-requested', 'released', 'reconciliation-required'))
  )`,
  `CREATE TABLE question_answer_submissions (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('repository-question', 'bb-interaction')),
    target_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result_json TEXT,
    submitted_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE repository_write_actions (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('answer-question', 'approve-queue')),
    target_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result_json TEXT,
    submitted_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE UNIQUE INDEX ownership_one_active_per_repository
    ON ownership_leases(repository_key)
    WHERE status IN ('held', 'release-requested', 'reconciliation-required')`,
] as const;

export interface CreateRunIntentInput {
  readonly intent: RunIntent;
  readonly canonicalRecords?: readonly CanonicalFileRecordLink[];
}

export interface CreateRunIntentResult {
  readonly created: boolean;
  readonly runId: string;
}

export interface RunDispatchUpdate {
  readonly repositoryKey: RepositoryKey;
  readonly runId: string;
  readonly status: Exclude<OperationalRunStatus, "pending">;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly providerId: string;
  readonly workerThreadId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly repositoryRevision: RepositoryRevision;
  readonly canonicalRecords?: readonly CanonicalFileRecordLink[];
}

export type QuestionAnswerSource = "repository-question" | "bb-interaction";

export interface QuestionAnswerSubmission {
  readonly repositoryKey: RepositoryKey;
  readonly idempotencyKey: IdempotencyKey;
  readonly source: QuestionAnswerSource;
  readonly targetId: string;
  /** A caller-owned digest of the validated answer request, never canonical question text. */
  readonly requestFingerprint: string;
  readonly submittedAt?: string;
}

export interface QuestionAnswerSubmissionRecord extends QuestionAnswerSubmission {
  readonly result: JsonValue | null;
  readonly completedAt: string | null;
}

export interface RepositoryWriteAction {
  readonly repositoryKey: RepositoryKey;
  readonly idempotencyKey: IdempotencyKey;
  readonly actionKind: "answer-question" | "approve-queue";
  readonly targetId: string;
  /** A caller-owned digest of the validated write request, never a queue/question copy. */
  readonly requestFingerprint: string;
  readonly submittedAt?: string;
}

export interface RepositoryWriteActionRecord extends RepositoryWriteAction {
  readonly result: JsonValue | null;
  readonly completedAt: string | null;
}

export interface IdempotencyClaim<T> {
  readonly created: boolean;
  readonly record: T;
}

export interface OperationalTransaction {
  createRunIntent(input: CreateRunIntentInput): CreateRunIntentResult;
  updateRunDispatch(input: RunDispatchUpdate): void;
  createDispatchAttempt(attempt: DispatchAttempt): void;
  updateDispatchAttempt(attempt: DispatchAttempt): void;
  createOwnershipLease(lease: OwnershipLease): void;
  updateOwnershipLease(lease: OwnershipLease): void;
  claimQuestionAnswer(input: QuestionAnswerSubmission): IdempotencyClaim<QuestionAnswerSubmissionRecord>;
  completeQuestionAnswer(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void;
  claimRepositoryWrite(input: RepositoryWriteAction): IdempotencyClaim<RepositoryWriteActionRecord>;
  completeRepositoryWrite(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void;
}

export interface OperationalStateStore extends OperationalStateReader {
  readonly db: SqliteDatabase;
  withTransaction<T>(callback: (transaction: OperationalTransaction) => T): T;
  createRunIntent(input: CreateRunIntentInput): CreateRunIntentResult;
  updateRunDispatch(input: RunDispatchUpdate): void;
  createDispatchAttempt(attempt: DispatchAttempt): void;
  updateDispatchAttempt(attempt: DispatchAttempt): void;
  createOwnershipLease(lease: OwnershipLease): void;
  updateOwnershipLease(lease: OwnershipLease): void;
  getCurrentOwnership(repositoryKey: RepositoryKey): OwnershipLease | null;
  claimQuestionAnswer(input: QuestionAnswerSubmission): IdempotencyClaim<QuestionAnswerSubmissionRecord>;
  completeQuestionAnswer(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void;
  getQuestionAnswer(idempotencyKey: IdempotencyKey): QuestionAnswerSubmissionRecord | null;
  claimRepositoryWrite(input: RepositoryWriteAction): IdempotencyClaim<RepositoryWriteActionRecord>;
  completeRepositoryWrite(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void;
  getRepositoryWrite(idempotencyKey: IdempotencyKey): RepositoryWriteActionRecord | null;
}

interface RunRow {
  run_id: string;
  repository_key: string;
  requested_at: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  provider_id: string | null;
  worker_thread_id: string | null;
  project_id: string | null;
  environment_id: string | null;
  queue_item_ids_json: string;
  repository_revision_json: string;
  canonical_records_json: string;
}

interface RunIntentRow extends RunRow {
  trigger: string;
  idempotency_key: string;
  request_fingerprint: string;
  base_revision_json: string;
  authorization_provenance_json: string;
}

interface AttemptRow {
  attempt_id: string;
  run_id: string;
  repository_key: string;
  provider_id: string;
  model: string;
  reasoning_level: string;
  worker_thread_id: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
}

interface OwnershipRow {
  lease_id: string;
  repository_key: string;
  run_id: string;
  queue_item_ids_json: string;
  worker_thread_id: string | null;
  authorization_provenance_json: string;
  acquired_at: string;
  expires_at: string;
  status: string;
}

interface QuestionAnswerRow {
  idempotency_key: string;
  repository_key: string;
  source: string;
  target_id: string;
  request_fingerprint: string;
  result_json: string | null;
  submitted_at: string;
  completed_at: string | null;
}

interface RepositoryWriteRow {
  idempotency_key: string;
  repository_key: string;
  action_kind: string;
  target_id: string;
  request_fingerprint: string;
  result_json: string | null;
  submitted_at: string;
  completed_at: string | null;
}

class IdempotencyConflictError extends Error {
  readonly code = "idempotency-conflict";

  constructor(idempotencyKey: string) {
    super(`idempotency key was already used for a different request: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export { IdempotencyConflictError };

class OperationalSqliteStore implements OperationalStateStore {
  readonly transactionApi: OperationalTransaction;

  constructor(readonly db: SqliteDatabase) {
    db.pragma("foreign_keys = ON");
    this.transactionApi = this.createTransactionApi();
  }

  withTransaction<T>(callback: (transaction: OperationalTransaction) => T): T {
    const run = this.db.transaction(() => callback(this.transactionApi));
    return run();
  }

  createRunIntent(input: CreateRunIntentInput): CreateRunIntentResult {
    return this.withTransaction((transaction) => transaction.createRunIntent(input));
  }

  updateRunDispatch(input: RunDispatchUpdate): void {
    this.withTransaction((transaction) => transaction.updateRunDispatch(input));
  }

  createDispatchAttempt(attempt: DispatchAttempt): void {
    this.withTransaction((transaction) => transaction.createDispatchAttempt(attempt));
  }

  updateDispatchAttempt(attempt: DispatchAttempt): void {
    this.withTransaction((transaction) => transaction.updateDispatchAttempt(attempt));
  }

  createOwnershipLease(lease: OwnershipLease): void {
    this.withTransaction((transaction) => transaction.createOwnershipLease(lease));
  }

  updateOwnershipLease(lease: OwnershipLease): void {
    this.withTransaction((transaction) => transaction.updateOwnershipLease(lease));
  }

  claimQuestionAnswer(input: QuestionAnswerSubmission): IdempotencyClaim<QuestionAnswerSubmissionRecord> {
    return this.withTransaction((transaction) => transaction.claimQuestionAnswer(input));
  }

  completeQuestionAnswer(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void {
    this.withTransaction((transaction) => transaction.completeQuestionAnswer(idempotencyKey, result, completedAt));
  }

  getQuestionAnswer(idempotencyKey: IdempotencyKey): QuestionAnswerSubmissionRecord | null {
    return readQuestionAnswer(this.db, idempotencyKey);
  }

  claimRepositoryWrite(input: RepositoryWriteAction): IdempotencyClaim<RepositoryWriteActionRecord> {
    return this.withTransaction((transaction) => transaction.claimRepositoryWrite(input));
  }

  completeRepositoryWrite(idempotencyKey: IdempotencyKey, result: JsonValue, completedAt?: string): void {
    this.withTransaction((transaction) => transaction.completeRepositoryWrite(idempotencyKey, result, completedAt));
  }

  getRepositoryWrite(idempotencyKey: IdempotencyKey): RepositoryWriteActionRecord | null {
    return readRepositoryWrite(this.db, idempotencyKey);
  }

  getCurrentOwnership(repositoryKey: RepositoryKey): OwnershipLease | null {
    repositoryKeySchema.parse(repositoryKey);
    const row = this.db
      .prepare<unknown[], OwnershipRow>(
        `SELECT lease_id, repository_key, run_id, queue_item_ids_json, worker_thread_id,
                authorization_provenance_json, acquired_at, expires_at, status
           FROM ownership_leases
          WHERE repository_key = ? AND status <> 'released'
          ORDER BY acquired_at DESC
          LIMIT 1`,
      )
      .get(repositoryKey);
    return row === undefined ? null : ownershipFromRow(row);
  }

  async listRuns(input: OperationalRunListInput): Promise<OperationalRunListProjection> {
    const parsed = operationalRunListInputSchema.parse(input);
    const cursor = parsed.cursor === undefined ? null : decodeCursor(parsed.cursor);
    const rows = this.db
      .prepare<unknown[], RunRow>(
        `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
                provider_id, worker_thread_id, project_id, environment_id,
                queue_item_ids_json, repository_revision_json, canonical_records_json
           FROM operational_runs
          WHERE repository_key = ?
            AND (? IS NULL OR requested_at < ? OR (requested_at = ? AND run_id < ?))
          ORDER BY requested_at DESC, run_id DESC
          LIMIT ?`,
      )
      .all(parsed.repositoryKey, cursor?.requestedAt ?? null, cursor?.requestedAt ?? null, cursor?.requestedAt ?? null, cursor?.runId ?? null, parsed.limit + 1);
    const page = rows.slice(0, parsed.limit).map(runSummaryFromRow);
    const hasNext = rows.length > parsed.limit;
    const nextCursor = hasNext && page.length > 0
      ? encodeCursor({ requestedAt: page[page.length - 1]!.requestedAt, runId: page[page.length - 1]!.runId })
      : null;
    return operationalRunListProjectionSchema.parse({ runs: page, nextCursor });
  }

  async getRun(input: OperationalRunDetailInput): Promise<OperationalRunDetailProjection> {
    const parsed = operationalRunDetailInputSchema.parse(input);
    const row = this.db
      .prepare<unknown[], RunIntentRow>(
        `SELECT run_id, repository_key, trigger, idempotency_key, request_fingerprint,
                requested_at, base_revision_json, queue_item_ids_json,
                authorization_provenance_json, status, started_at, finished_at,
                provider_id, worker_thread_id, project_id, environment_id,
                repository_revision_json, canonical_records_json
           FROM operational_runs
          WHERE repository_key = ? AND run_id = ?`,
      )
      .get(parsed.repositoryKey, parsed.runId);
    if (row === undefined) {
      return { run: null };
    }

    const attempts = this.db
      .prepare<unknown[], AttemptRow>(
        `SELECT attempt_id, run_id, repository_key, provider_id, model,
                reasoning_level, worker_thread_id, status, started_at, finished_at
           FROM dispatch_attempts
          WHERE run_id = ?
          ORDER BY rowid ASC`,
      )
      .all(row.run_id)
      .map(attemptFromRow);
    const leaseRow = this.db
      .prepare<unknown[], OwnershipRow>(
        `SELECT lease_id, repository_key, run_id, queue_item_ids_json, worker_thread_id,
                authorization_provenance_json, acquired_at, expires_at, status
           FROM ownership_leases
          WHERE run_id = ? AND status <> 'released'
          ORDER BY acquired_at DESC
          LIMIT 1`,
      )
      .get(row.run_id);
    const detail: OperationalRunDetail = {
      summary: runSummaryFromRow(row),
      intent: runIntentFromRow(row),
      attempts,
      lease: leaseRow === undefined ? null : ownershipFromRow(leaseRow),
    };
    return operationalRunDetailProjectionSchema.parse({ run: detail });
  }

  private createTransactionApi(): OperationalTransaction {
    return {
      createRunIntent: (input) => insertRunIntent(this.db, input),
      updateRunDispatch: (input) => updateRunDispatch(this.db, input),
      createDispatchAttempt: (attempt) => insertDispatchAttempt(this.db, attempt),
      updateDispatchAttempt: (attempt) => updateDispatchAttempt(this.db, attempt),
      createOwnershipLease: (lease) => insertOwnershipLease(this.db, lease),
      updateOwnershipLease: (lease) => updateOwnershipLease(this.db, lease),
      claimQuestionAnswer: (input) => claimQuestionAnswer(this.db, input),
      completeQuestionAnswer: (idempotencyKey, result, completedAt) => completeQuestionAnswer(this.db, idempotencyKey, result, completedAt),
      claimRepositoryWrite: (input) => claimRepositoryWrite(this.db, input),
      completeRepositoryWrite: (idempotencyKey, result, completedAt) => completeRepositoryWrite(this.db, idempotencyKey, result, completedAt),
    };
  }
}

export function initializeOperationalStorage(storage: PluginStorage): OperationalStateStore {
  const db = storage.database();
  storage.migrate(db, [...OPERATIONAL_STORAGE_MIGRATIONS]);
  return new OperationalSqliteStore(db);
}

export const createOperationalStateStore = initializeOperationalStorage;

function insertRunIntent(db: SqliteDatabase, input: CreateRunIntentInput): CreateRunIntentResult {
  const intent = runIntentSchema.parse(input.intent);
  const canonicalRecords = canonicalRecordsSchema.parse(input.canonicalRecords ?? []);
  const requestFingerprint = stableJson({ intent, canonicalRecords });
  const existing = db
    .prepare<unknown[], { run_id: string; request_fingerprint: string }>(
      `SELECT run_id, request_fingerprint FROM operational_runs WHERE idempotency_key = ?`,
    )
    .get(intent.idempotencyKey);
  if (existing !== undefined) {
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError(intent.idempotencyKey);
    }
    return { created: false, runId: existing.run_id };
  }

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
    requestFingerprint,
    intent.requestedAt,
    stableJson(intent.baseRevision),
    stableJson(intent.queueItemIds),
    stableJson(intent.authorizationProvenance),
    stableJson(intent.baseRevision),
    stableJson(canonicalRecords),
  );
  return { created: true, runId: intent.runId };
}

function updateRunDispatch(db: SqliteDatabase, input: RunDispatchUpdate): void {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const status = dispatchedRunStatusSchema.parse(input.status);
  const repositoryRevision = repositoryRevisionSchema.parse(input.repositoryRevision);
  const row = db
    .prepare<unknown[], RunRow>(
      `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
              provider_id, worker_thread_id, project_id, environment_id,
              queue_item_ids_json, repository_revision_json, canonical_records_json
         FROM operational_runs
        WHERE repository_key = ? AND run_id = ?`,
    )
    .get(repositoryKey, input.runId);
  if (row === undefined) {
    throw new Error(`cannot update missing operational run: ${repositoryKey}/${input.runId}`);
  }
  const currentSummary = runSummaryFromRow(row);
  const canonicalRecords = input.canonicalRecords === undefined
    ? currentSummary.canonicalRecords
    : canonicalRecordsSchema.parse(input.canonicalRecords);

  const summary = operationalRunSummarySchema.parse({
    ...currentSummary,
    status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    providerId: input.providerId,
    workerThreadId: input.workerThreadId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    repositoryRevision,
    canonicalRecords,
  });
  db.prepare(
    `UPDATE operational_runs
        SET status = ?, started_at = ?, finished_at = ?, provider_id = ?,
            worker_thread_id = ?, project_id = ?, environment_id = ?,
            repository_revision_json = ?, canonical_records_json = ?
      WHERE repository_key = ? AND run_id = ?`,
  ).run(
    summary.status,
    summary.startedAt,
    summary.finishedAt,
    summary.providerId,
    summary.workerThreadId,
    summary.projectId,
    summary.environmentId,
    stableJson(summary.repositoryRevision),
    stableJson(summary.canonicalRecords),
    repositoryKey,
    input.runId,
  );
}

function insertDispatchAttempt(db: SqliteDatabase, attempt: DispatchAttempt): void {
  const parsed = dispatchAttemptSchema.parse(attempt);
  assertRunRepository(db, parsed.runId, parsed.repositoryKey);
  db.prepare(
    `INSERT INTO dispatch_attempts (
       attempt_id, run_id, repository_key, provider_id, model, reasoning_level,
       worker_thread_id, status, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.attemptId,
    parsed.runId,
    parsed.repositoryKey,
    parsed.providerId,
    parsed.model,
    parsed.reasoningLevel,
    parsed.workerThreadId,
    parsed.status,
    parsed.startedAt,
    parsed.finishedAt,
  );
}

function updateDispatchAttempt(db: SqliteDatabase, attempt: DispatchAttempt): void {
  const parsed = dispatchAttemptSchema.parse(attempt);
  assertRunRepository(db, parsed.runId, parsed.repositoryKey);
  const result = db.prepare(
    `UPDATE dispatch_attempts
        SET run_id = ?, repository_key = ?, provider_id = ?, model = ?,
            reasoning_level = ?, worker_thread_id = ?, status = ?,
            started_at = ?, finished_at = ?
      WHERE attempt_id = ? AND run_id = ?`,
  ).run(
    parsed.runId,
    parsed.repositoryKey,
    parsed.providerId,
    parsed.model,
    parsed.reasoningLevel,
    parsed.workerThreadId,
    parsed.status,
    parsed.startedAt,
    parsed.finishedAt,
    parsed.attemptId,
    parsed.runId,
  );
  if (result.changes !== 1) {
    throw new Error(`cannot update missing dispatch attempt: ${parsed.attemptId}`);
  }
}

function insertOwnershipLease(db: SqliteDatabase, lease: OwnershipLease): void {
  const parsed = ownershipLeaseSchema.parse(lease);
  assertRunRepository(db, parsed.runId, parsed.repositoryKey);
  db.prepare(
    `INSERT INTO ownership_leases (
       lease_id, repository_key, run_id, queue_item_ids_json, worker_thread_id,
       authorization_provenance_json, acquired_at, expires_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.leaseId,
    parsed.repositoryKey,
    parsed.runId,
    stableJson(parsed.queueItemIds),
    parsed.workerThreadId,
    stableJson(parsed.authorizationProvenance),
    parsed.acquiredAt,
    parsed.expiresAt,
    parsed.status,
  );
}

function updateOwnershipLease(db: SqliteDatabase, lease: OwnershipLease): void {
  const parsed = ownershipLeaseSchema.parse(lease);
  assertRunRepository(db, parsed.runId, parsed.repositoryKey);
  const result = db.prepare(
    `UPDATE ownership_leases
        SET repository_key = ?, run_id = ?, queue_item_ids_json = ?,
            worker_thread_id = ?, authorization_provenance_json = ?,
            acquired_at = ?, expires_at = ?, status = ?
      WHERE lease_id = ? AND run_id = ?`,
  ).run(
    parsed.repositoryKey,
    parsed.runId,
    stableJson(parsed.queueItemIds),
    parsed.workerThreadId,
    stableJson(parsed.authorizationProvenance),
    parsed.acquiredAt,
    parsed.expiresAt,
    parsed.status,
    parsed.leaseId,
    parsed.runId,
  );
  if (result.changes !== 1) {
    throw new Error(`cannot update missing ownership lease: ${parsed.leaseId}`);
  }
}

function claimQuestionAnswer(db: SqliteDatabase, input: QuestionAnswerSubmission): IdempotencyClaim<QuestionAnswerSubmissionRecord> {
  const parsed = validateQuestionAnswerInput(input);
  const existing = readQuestionAnswer(db, parsed.idempotencyKey);
  if (existing !== null) {
    if (!sameQuestionAnswerRequest(existing, parsed)) {
      throw new IdempotencyConflictError(parsed.idempotencyKey);
    }
    return { created: false, record: existing };
  }
  db.prepare(
    `INSERT INTO question_answer_submissions (
       idempotency_key, repository_key, source, target_id,
       request_fingerprint, submitted_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.idempotencyKey,
    parsed.repositoryKey,
    parsed.source,
    parsed.targetId,
    parsed.requestFingerprint,
    parsed.submittedAt,
  );
  return { created: true, record: readQuestionAnswer(db, parsed.idempotencyKey)! };
}

function completeQuestionAnswer(db: SqliteDatabase, idempotencyKey: IdempotencyKey, result: JsonValue, completedAt = now()): void {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const update = db.prepare(
    `UPDATE question_answer_submissions
        SET result_json = ?, completed_at = ?
      WHERE idempotency_key = ? AND completed_at IS NULL`,
  ).run(stableJson(result), completedAt, key);
  if (update.changes !== 1) {
    throw new Error(`cannot complete missing question answer submission: ${key}`);
  }
}

function claimRepositoryWrite(db: SqliteDatabase, input: RepositoryWriteAction): IdempotencyClaim<RepositoryWriteActionRecord> {
  const parsed = validateRepositoryWriteInput(input);
  const existing = readRepositoryWrite(db, parsed.idempotencyKey);
  if (existing !== null) {
    if (!sameRepositoryWriteRequest(existing, parsed)) {
      throw new IdempotencyConflictError(parsed.idempotencyKey);
    }
    return { created: false, record: existing };
  }
  db.prepare(
    `INSERT INTO repository_write_actions (
       idempotency_key, repository_key, action_kind, target_id,
       request_fingerprint, submitted_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.idempotencyKey,
    parsed.repositoryKey,
    parsed.actionKind,
    parsed.targetId,
    parsed.requestFingerprint,
    parsed.submittedAt,
  );
  return { created: true, record: readRepositoryWrite(db, parsed.idempotencyKey)! };
}

function completeRepositoryWrite(db: SqliteDatabase, idempotencyKey: IdempotencyKey, result: JsonValue, completedAt = now()): void {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const update = db.prepare(
    `UPDATE repository_write_actions
        SET result_json = ?, completed_at = ?
      WHERE idempotency_key = ? AND completed_at IS NULL`,
  ).run(stableJson(result), completedAt, key);
  if (update.changes !== 1) {
    throw new Error(`cannot complete missing repository write action: ${key}`);
  }
}

function readQuestionAnswer(db: SqliteDatabase, idempotencyKey: IdempotencyKey): QuestionAnswerSubmissionRecord | null {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const row = db
    .prepare<unknown[], QuestionAnswerRow>(
      `SELECT idempotency_key, repository_key, source, target_id,
              request_fingerprint, result_json, submitted_at, completed_at
         FROM question_answer_submissions
        WHERE idempotency_key = ?`,
    )
    .get(key);
  if (row === undefined) {
    return null;
  }
  return questionAnswerFromRow(row);
}

function readRepositoryWrite(db: SqliteDatabase, idempotencyKey: IdempotencyKey): RepositoryWriteActionRecord | null {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const row = db
    .prepare<unknown[], RepositoryWriteRow>(
      `SELECT idempotency_key, repository_key, action_kind, target_id,
              request_fingerprint, result_json, submitted_at, completed_at
         FROM repository_write_actions
        WHERE idempotency_key = ?`,
    )
    .get(key);
  if (row === undefined) {
    return null;
  }
  return repositoryWriteFromRow(row);
}

function validateQuestionAnswerInput(input: QuestionAnswerSubmission): QuestionAnswerSubmission {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  assertIdempotencyBinding(repositoryKey, idempotencyKey, "answer-question");
  return {
    repositoryKey,
    idempotencyKey,
    source: z.enum(["repository-question", "bb-interaction"]).parse(input.source),
    targetId: z.string().trim().min(1).parse(input.targetId),
    requestFingerprint: z.string().trim().min(1).parse(input.requestFingerprint),
    submittedAt: input.submittedAt ?? now(),
  };
}

function validateRepositoryWriteInput(input: RepositoryWriteAction): RepositoryWriteAction {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const actionKind = z.enum(["answer-question", "approve-queue"]).parse(input.actionKind);
  assertIdempotencyBinding(repositoryKey, idempotencyKey, actionKind);
  return {
    repositoryKey,
    idempotencyKey,
    actionKind,
    targetId: z.string().trim().min(1).parse(input.targetId),
    requestFingerprint: z.string().trim().min(1).parse(input.requestFingerprint),
    submittedAt: input.submittedAt ?? now(),
  };
}

function assertIdempotencyBinding(repositoryKey: string, idempotencyKey: string, operation: string): void {
  const [, , keyRepository, keyOperation] = idempotencyKey.split(":");
  if (keyRepository !== repositoryKey || keyOperation !== operation) {
    throw new Error(`idempotency key does not match repository operation: ${idempotencyKey}`);
  }
}

function assertRunRepository(db: SqliteDatabase, runId: string, repositoryKey: string): void {
  const row = db
    .prepare<unknown[], { repository_key: string }>(`SELECT repository_key FROM operational_runs WHERE run_id = ?`)
    .get(runId);
  if (row === undefined) {
    throw new Error(`cannot reference missing operational run: ${runId}`);
  }
  if (row.repository_key !== repositoryKey) {
    throw new Error(`operational run belongs to a different repository: ${runId}`);
  }
}

function runSummaryFromRow(row: RunRow): OperationalRunSummary {
  return operationalRunSummarySchema.parse({
    runId: row.run_id,
    repositoryKey: row.repository_key,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    providerId: row.provider_id,
    workerThreadId: row.worker_thread_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    queueItemIds: parseJson(row.queue_item_ids_json),
    repositoryRevision: parseJson(row.repository_revision_json),
    canonicalRecords: parseJson(row.canonical_records_json),
  });
}

function runIntentFromRow(row: RunIntentRow): RunIntent {
  return runIntentSchema.parse({
    runId: row.run_id,
    repositoryKey: row.repository_key,
    trigger: row.trigger,
    idempotencyKey: row.idempotency_key,
    requestedAt: row.requested_at,
    baseRevision: parseJson(row.base_revision_json),
    queueItemIds: parseJson(row.queue_item_ids_json),
    authorizationProvenance: parseJson(row.authorization_provenance_json),
  });
}

function attemptFromRow(row: AttemptRow): DispatchAttempt {
  return dispatchAttemptSchema.parse({
    attemptId: row.attempt_id,
    runId: row.run_id,
    repositoryKey: row.repository_key,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    workerThreadId: row.worker_thread_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function ownershipFromRow(row: OwnershipRow): OwnershipLease {
  return ownershipLeaseSchema.parse({
    leaseId: row.lease_id,
    repositoryKey: row.repository_key,
    runId: row.run_id,
    queueItemIds: parseJson(row.queue_item_ids_json),
    workerThreadId: row.worker_thread_id,
    authorizationProvenance: parseJson(row.authorization_provenance_json),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    status: row.status,
  });
}

function questionAnswerFromRow(row: QuestionAnswerRow): QuestionAnswerSubmissionRecord {
  return {
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    idempotencyKey: idempotencyKeySchema.parse(row.idempotency_key),
    source: z.enum(["repository-question", "bb-interaction"]).parse(row.source),
    targetId: row.target_id,
    requestFingerprint: row.request_fingerprint,
    submittedAt: row.submitted_at,
    result: row.result_json === null ? null : parseJson(row.result_json),
    completedAt: row.completed_at,
  };
}

function repositoryWriteFromRow(row: RepositoryWriteRow): RepositoryWriteActionRecord {
  return {
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    idempotencyKey: idempotencyKeySchema.parse(row.idempotency_key),
    actionKind: z.enum(["answer-question", "approve-queue"]).parse(row.action_kind),
    targetId: row.target_id,
    requestFingerprint: row.request_fingerprint,
    submittedAt: row.submitted_at,
    result: row.result_json === null ? null : parseJson(row.result_json),
    completedAt: row.completed_at,
  };
}

function sameQuestionAnswerRequest(existing: QuestionAnswerSubmissionRecord, input: QuestionAnswerSubmission): boolean {
  return existing.repositoryKey === input.repositoryKey
    && existing.source === input.source
    && existing.targetId === input.targetId
    && existing.requestFingerprint === input.requestFingerprint;
}

function sameRepositoryWriteRequest(existing: RepositoryWriteActionRecord, input: RepositoryWriteAction): boolean {
  return existing.repositoryKey === input.repositoryKey
    && existing.actionKind === input.actionKind
    && existing.targetId === input.targetId
    && existing.requestFingerprint === input.requestFingerprint;
}

interface Cursor {
  readonly requestedAt: string;
  readonly runId: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(stableJson(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object"
      || parsed === null
      || typeof (parsed as { requestedAt?: unknown }).requestedAt !== "string"
      || typeof (parsed as { runId?: unknown }).runId !== "string"
      || (parsed as { requestedAt: string }).requestedAt.length === 0
      || (parsed as { runId: string }).runId.length === 0
    ) {
      throw new Error("cursor fields are invalid");
    }
    return parsed as Cursor;
  } catch {
    throw new Error("invalid operational run cursor");
  }
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("operational storage contains invalid JSON");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("operational storage cannot encode undefined JSON");
  }
  return encoded;
}

function now(): string {
  return new Date().toISOString();
}
