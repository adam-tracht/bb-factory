import type { PluginStorage, JsonValue } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ActionKind,
  BbInteractionActionRequest,
  BbInteractionResolution,
  CanonicalFileRecordLink,
  DispatchAttempt,
  FactoryActionResult,
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
  RepositoryActionRequest,
  RepositoryRevision,
  RunIntent,
  ScaffoldProtocolActionRequest,
} from "../contracts.js";
import {
  actionKindSchema,
  bbInteractionActionRequestSchema,
  bbInteractionResolutionSchema,
  canonicalFileRecordLinkSchema,
  dispatchAttemptSchema,
  factoryActionResultSchema,
  idempotencyKeySchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  operationalRunSummarySchema,
  ownershipLeaseSchema,
  repositoryActionRequestSchema,
  repositoryKeySchema,
  repositoryRevisionSchema,
  runIntentSchema,
  scaffoldProtocolActionRequestSchema,
} from "../contracts.js";
import type { OperationalStateReader } from "../ports.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";

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

const pendingActionRequestSchema = z.union([
  repositoryActionRequestSchema,
  bbInteractionActionRequestSchema,
  scaffoldProtocolActionRequestSchema,
]);
const isoTimestampSchema = z.string().datetime({ offset: true });
const pendingActionIntentStatusSchema = z.enum([
  "pending",
  "resolving",
  "completed",
  "reconciliation-required",
]);
const pendingActionIntentEntryPointSchema = z.enum(["action-executor", "native-ui-initial-ready"]);
const pendingActionObservedStatusSchema = z.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted",
  "written",
  "conflict",
  "verified",
]);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const relativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === ".."),
  "must be a normalized repository-relative path",
);
const pendingActionIntentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository") }).strict(),
  z.object({ kind: z.literal("repository-question"), questionId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("queue-item"), queueItemId: z.string().trim().min(1) }).strict(),
  z
    .object({
      kind: z.literal("bb-interaction"),
      interactionId: z.string().trim().min(1),
      threadId: z.string().trim().min(1),
      turnId: z.string().trim().min(1).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("attempt"), attemptId: z.string().trim().min(1) }).strict(),
]);
const pendingActionFileChangeSchema = z
  .object({
    relativePath: relativePathSchema,
    expectedSha256: sha256DigestSchema,
    intendedSha256: sha256DigestSchema,
    intendedContent: z.string(),
  })
  .strict()
  .superRefine((change, context) => {
    const actualSha256 = createSha256(change.intendedContent);
    if (actualSha256 !== change.intendedSha256) {
      context.addIssue({
        code: "custom",
        path: ["intendedSha256"],
        message: "intendedSha256 must match intendedContent",
      });
    }
  });

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
  `CREATE TABLE pending_action_intents (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'retry', 'stop')),
    request_fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    expected_revision_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    file_change_json TEXT,
    entry_point TEXT NOT NULL CHECK (entry_point IN ('action-executor', 'native-ui-initial-ready')),
    one_shot INTEGER NOT NULL CHECK (one_shot IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'resolving', 'completed', 'reconciliation-required')),
    submitted_at TEXT NOT NULL,
    expires_at TEXT,
    last_attempt_at TEXT,
    completed_at TEXT,
    result_json TEXT,
    observed_status TEXT CHECK (observed_status IS NULL OR observed_status IN ('pending', 'resolving', 'resolved', 'interrupted', 'written', 'conflict', 'verified')),
    observed_resolution_json TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE dispatcher_states (
    repository_key TEXT PRIMARY KEY,
    night_key TEXT NOT NULL,
    last_state TEXT NOT NULL,
    failed_count INTEGER NOT NULL,
    noop_count INTEGER NOT NULL,
    last_start_at INTEGER NOT NULL,
    last_start_provider TEXT NOT NULL,
    limits_json TEXT NOT NULL
  )`,
  // SQLite cannot alter a CHECK constraint, so widening action_kind for
  // recommend-question rebuilds the table. The unapplied tail runs in one
  // migration transaction.
  `CREATE TABLE pending_action_intents_v2 (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'recommend-question', 'retry', 'stop')),
    request_fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    expected_revision_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    file_change_json TEXT,
    entry_point TEXT NOT NULL CHECK (entry_point IN ('action-executor', 'native-ui-initial-ready')),
    one_shot INTEGER NOT NULL CHECK (one_shot IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'resolving', 'completed', 'reconciliation-required')),
    submitted_at TEXT NOT NULL,
    expires_at TEXT,
    last_attempt_at TEXT,
    completed_at TEXT,
    result_json TEXT,
    observed_status TEXT CHECK (observed_status IS NULL OR observed_status IN ('pending', 'resolving', 'resolved', 'interrupted', 'written', 'conflict', 'verified')),
    observed_resolution_json TEXT,
    last_error TEXT
  )`,
  `INSERT INTO pending_action_intents_v2 SELECT * FROM pending_action_intents`,
  `DROP TABLE pending_action_intents`,
  `ALTER TABLE pending_action_intents_v2 RENAME TO pending_action_intents`,
  // SQLite cannot alter a CHECK constraint, so letting a dispatched run carry
  // a null environment id (an unmanaged spawn that fails ambiguously never
  // yields one) rebuilds the table without the environment_id NOT NULL clause.
  `CREATE TABLE operational_runs_v2 (
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
    CHECK (status = 'pending' OR (provider_id IS NOT NULL AND worker_thread_id IS NOT NULL AND project_id IS NOT NULL))
  )`,
  `INSERT INTO operational_runs_v2 SELECT * FROM operational_runs`,
  `DROP TABLE operational_runs`,
  `ALTER TABLE operational_runs_v2 RENAME TO operational_runs`,
  // SQLite cannot alter a CHECK constraint, so widening action_kind for
  // scaffold-protocol rebuilds the table again.
  `CREATE TABLE pending_action_intents_v3 (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'recommend-question', 'retry', 'stop', 'scaffold-protocol')),
    request_fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    expected_revision_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    file_change_json TEXT,
    entry_point TEXT NOT NULL CHECK (entry_point IN ('action-executor', 'native-ui-initial-ready')),
    one_shot INTEGER NOT NULL CHECK (one_shot IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'resolving', 'completed', 'reconciliation-required')),
    submitted_at TEXT NOT NULL,
    expires_at TEXT,
    last_attempt_at TEXT,
    completed_at TEXT,
    result_json TEXT,
    observed_status TEXT CHECK (observed_status IS NULL OR observed_status IN ('pending', 'resolving', 'resolved', 'interrupted', 'written', 'conflict', 'verified')),
    observed_resolution_json TEXT,
    last_error TEXT
  )`,
  `INSERT INTO pending_action_intents_v3 SELECT * FROM pending_action_intents`,
  `DROP TABLE pending_action_intents`,
  `ALTER TABLE pending_action_intents_v3 RENAME TO pending_action_intents`,
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
  readonly environmentId: string | null;
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

export type PendingActionIntentRequest = RepositoryActionRequest | BbInteractionActionRequest | ScaffoldProtocolActionRequest;
export type PendingActionIntentStatus = z.infer<typeof pendingActionIntentStatusSchema>;
export type PendingActionIntentEntryPoint = z.infer<typeof pendingActionIntentEntryPointSchema>;
export type PendingActionObservedStatus = z.infer<typeof pendingActionObservedStatusSchema>;
export type PendingActionIntentTarget = z.infer<typeof pendingActionIntentTargetSchema>;

export interface PendingActionFileChange {
  /** Canonical text for the one authoritative repository file being reconciled. */
  readonly relativePath: string;
  readonly expectedSha256: string;
  readonly intendedSha256: string;
  readonly intendedContent: string;
}

export interface PendingActionIntentInput {
  readonly request: PendingActionIntentRequest;
  readonly target: PendingActionIntentTarget;
  /** Required for repository actions, absent for BB interaction actions. */
  readonly fileChange?: PendingActionFileChange | null;
  readonly submittedAt?: string;
  readonly expiresAt?: string | null;
}

export interface InitialReadyIntentInput {
  readonly request: RepositoryActionRequest;
  readonly queueItemId: string;
  readonly intendedChange: PendingActionFileChange;
  readonly submittedAt?: string;
  readonly expiresAt: string;
}

export type PendingActionIntentConsumeReason =
  | "already-submitted"
  | "already-confirmed"
  | "reconciliation-required";

export interface PendingActionIntentConsumption {
  /** Only true authorizes the caller to perform the external side effect. */
  readonly consumed: boolean;
  readonly record: PendingActionIntentRecord;
  readonly reason?: PendingActionIntentConsumeReason;
}

export interface OperationalStorageOptions {
  /** Injectable execution clock for expiry checks; production defaults to the system clock. */
  readonly now?: () => string;
}

export interface PendingActionIntentRecord {
  readonly repositoryKey: RepositoryKey;
  readonly actionKind: ActionKind;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestFingerprint: string;
  readonly request: PendingActionIntentRequest;
  readonly expectedRevision: RepositoryRevision;
  readonly target: PendingActionIntentTarget;
  readonly fileChange: PendingActionFileChange | null;
  readonly entryPoint: PendingActionIntentEntryPoint;
  readonly oneShot: boolean;
  readonly status: PendingActionIntentStatus;
  readonly submittedAt: string;
  readonly expiresAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly completedAt: string | null;
  readonly result: FactoryActionResult | null;
  readonly observedStatus: PendingActionObservedStatus | null;
  readonly observedResolution: BbInteractionResolution | null;
  readonly lastError: string | null;
}

export interface PendingActionIntentUpdate {
  readonly idempotencyKey: IdempotencyKey;
  readonly status: Exclude<PendingActionIntentStatus, "pending">;
  readonly lastAttemptAt?: string | null;
  readonly completedAt?: string | null;
  readonly result?: FactoryActionResult | null;
  readonly observedStatus?: PendingActionObservedStatus | null;
  readonly observedResolution?: BbInteractionResolution | null;
  /** Sanitized operational text only, never a copied request or provider payload. */
  readonly lastError?: string | null;
}

export interface PendingActionIntentListInput {
  readonly repositoryKey?: RepositoryKey;
  readonly status?: PendingActionIntentStatus;
}

/**
 * Durable per-repository dispatcher state, ported from the shell dispatcher's
 * state file. All times are epoch seconds. `lastState` is the most recent
 * finished foreman outcome, `dead-start` for a thread that produced no run
 * record, or "" before the night's first finish. Provider `limits` map a
 * provider id to the epoch second until which it is marked limited.
 */
export interface DispatcherState {
  readonly repositoryKey: RepositoryKey;
  readonly nightKey: string;
  readonly lastState: string;
  readonly failedCount: number;
  readonly noopCount: number;
  readonly lastStartAt: number;
  readonly lastStartProvider: string;
  readonly limits: Record<string, number>;
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
  claimPendingActionIntent(input: PendingActionIntentInput): IdempotencyClaim<PendingActionIntentRecord>;
  claimInitialReadyIntent(input: InitialReadyIntentInput): IdempotencyClaim<PendingActionIntentRecord>;
  consumePendingActionIntent(idempotencyKey: IdempotencyKey): PendingActionIntentConsumption;
  updatePendingActionIntent(input: PendingActionIntentUpdate): PendingActionIntentRecord;
  getDispatcherState(repositoryKey: RepositoryKey): DispatcherState;
  saveDispatcherState(state: DispatcherState): void;
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
  claimPendingActionIntent(input: PendingActionIntentInput): IdempotencyClaim<PendingActionIntentRecord>;
  claimInitialReadyIntent(input: InitialReadyIntentInput): IdempotencyClaim<PendingActionIntentRecord>;
  consumePendingActionIntent(idempotencyKey: IdempotencyKey): PendingActionIntentConsumption;
  getPendingActionIntent(idempotencyKey: IdempotencyKey): PendingActionIntentRecord | null;
  listPendingActionIntents(input?: PendingActionIntentListInput): PendingActionIntentRecord[];
  updatePendingActionIntent(input: PendingActionIntentUpdate): PendingActionIntentRecord;
  getDispatchAttempt(attemptId: string): DispatchAttempt | null;
  getLeaseForRun(runId: string): OwnershipLease | null;
  findRunIdByIdempotencyKey(idempotencyKey: IdempotencyKey): string | null;
  listActiveRuns(repositoryKey: RepositoryKey): OperationalRunSummary[];
  getDispatcherState(repositoryKey: RepositoryKey): DispatcherState;
  saveDispatcherState(state: DispatcherState): void;
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

interface DispatcherStateRow {
  readonly repository_key: string;
  readonly night_key: string;
  readonly last_state: string;
  readonly failed_count: number;
  readonly noop_count: number;
  readonly last_start_at: number;
  readonly last_start_provider: string;
  readonly limits_json: string;
}

interface PendingActionIntentRow {
  idempotency_key: string;
  repository_key: string;
  action_kind: string;
  request_fingerprint: string;
  request_json: string;
  expected_revision_json: string;
  target_json: string;
  file_change_json: string | null;
  entry_point: string;
  one_shot: number;
  status: string;
  submitted_at: string;
  expires_at: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  observed_status: string | null;
  observed_resolution_json: string | null;
  last_error: string | null;
}

class IdempotencyConflictError extends Error {
  readonly code = "idempotency-conflict";

  constructor(idempotencyKey: string) {
    super(`idempotency key was already used for a different request: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export { IdempotencyConflictError };

class PendingActionIntentExpiredError extends Error {
  readonly code = "pending-action-expired";

  constructor(idempotencyKey: string) {
    super(`pending action intent is expired and cannot be consumed: ${idempotencyKey}`);
    this.name = "PendingActionIntentExpiredError";
  }
}

export { PendingActionIntentExpiredError };

class OperationalSqliteStore implements OperationalStateStore {
  readonly transactionApi: OperationalTransaction;
  private configuredHandle: SqliteDatabase | null = null;

  constructor(
    private readonly resolveDatabase: () => SqliteDatabase,
    private readonly executionNow: () => string = now,
  ) {
    this.transactionApi = this.createTransactionApi();
  }

  /**
   * Resolved on every use. The host closes the plugin's handle on
   * dispose/reload and `PluginStorage.database()` reopens it on demand, so a
   * handle cached at load would leave every store operation failing with
   * "database connection is not open" until the next restart.
   */
  get db(): SqliteDatabase {
    const handle = this.resolveDatabase();
    if (handle !== this.configuredHandle) {
      // Per-connection pragma: a reopened handle starts with FK checks off.
      handle.pragma("foreign_keys = ON");
      this.configuredHandle = handle;
    }
    return handle;
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

  claimPendingActionIntent(input: PendingActionIntentInput): IdempotencyClaim<PendingActionIntentRecord> {
    return this.withTransaction((transaction) => transaction.claimPendingActionIntent(input));
  }

  claimInitialReadyIntent(input: InitialReadyIntentInput): IdempotencyClaim<PendingActionIntentRecord> {
    return this.withTransaction((transaction) => transaction.claimInitialReadyIntent(input));
  }

  consumePendingActionIntent(idempotencyKey: IdempotencyKey): PendingActionIntentConsumption {
    return this.withTransaction((transaction) => transaction.consumePendingActionIntent(idempotencyKey));
  }

  getPendingActionIntent(idempotencyKey: IdempotencyKey): PendingActionIntentRecord | null {
    return readPendingActionIntent(this.db, idempotencyKey);
  }

  listPendingActionIntents(input: PendingActionIntentListInput = {}): PendingActionIntentRecord[] {
    const repositoryKey = input.repositoryKey === undefined ? undefined : repositoryKeySchema.parse(input.repositoryKey);
    const status = input.status === undefined ? undefined : pendingActionIntentStatusSchema.parse(input.status);
    const rows = this.db
      .prepare<unknown[], PendingActionIntentRow>(
        `SELECT idempotency_key, repository_key, action_kind, request_fingerprint,
                request_json, expected_revision_json, target_json, file_change_json,
                entry_point, one_shot, status, submitted_at, expires_at,
                last_attempt_at, completed_at, result_json, observed_status,
                observed_resolution_json, last_error
           FROM pending_action_intents
          WHERE (? IS NULL OR repository_key = ?)
            AND (? IS NULL OR status = ?)
          ORDER BY submitted_at ASC, idempotency_key ASC`,
      )
      .all(repositoryKey ?? null, repositoryKey ?? null, status ?? null, status ?? null);
    return rows.map(pendingActionIntentFromRow);
  }

  updatePendingActionIntent(input: PendingActionIntentUpdate): PendingActionIntentRecord {
    return this.withTransaction((transaction) => transaction.updatePendingActionIntent(input));
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
      claimPendingActionIntent: (input) => claimPendingActionIntent(this.db, input, this.executionNow),
      claimInitialReadyIntent: (input) => claimInitialReadyIntent(this.db, input, this.executionNow),
      consumePendingActionIntent: (idempotencyKey) => consumePendingActionIntent(this.db, idempotencyKey, this.executionNow),
      updatePendingActionIntent: (input) => updatePendingActionIntent(this.db, input, this.executionNow),
      getDispatcherState: (repositoryKey) => readDispatcherState(this.db, repositoryKey),
      saveDispatcherState: (state) => saveDispatcherState(this.db, state),
    };
  }

  getDispatchAttempt(attemptId: string): DispatchAttempt | null {
    const row = this.db
      .prepare<unknown[], AttemptRow>(
        `SELECT attempt_id, run_id, repository_key, provider_id, model,
                reasoning_level, worker_thread_id, status, started_at, finished_at
           FROM dispatch_attempts
          WHERE attempt_id = ?`,
      )
      .get(z.string().trim().min(1).parse(attemptId));
    return row === undefined ? null : attemptFromRow(row);
  }

  getLeaseForRun(runId: string): OwnershipLease | null {
    const row = this.db
      .prepare<unknown[], OwnershipRow>(
        `SELECT lease_id, repository_key, run_id, queue_item_ids_json, worker_thread_id,
                authorization_provenance_json, acquired_at, expires_at, status
           FROM ownership_leases
          WHERE run_id = ?
          ORDER BY acquired_at DESC
          LIMIT 1`,
      )
      .get(z.string().trim().min(1).parse(runId));
    return row === undefined ? null : ownershipFromRow(row);
  }

  findRunIdByIdempotencyKey(idempotencyKey: IdempotencyKey): string | null {
    const row = this.db
      .prepare<unknown[], { run_id: string }>(
        `SELECT run_id FROM operational_runs WHERE idempotency_key = ?`,
      )
      .get(idempotencyKeySchema.parse(idempotencyKey));
    return row === undefined ? null : row.run_id;
  }

  listActiveRuns(repositoryKey: RepositoryKey): OperationalRunSummary[] {
    const key = repositoryKeySchema.parse(repositoryKey);
    const rows = this.db
      .prepare<unknown[], RunRow>(
        `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
                provider_id, worker_thread_id, project_id, environment_id,
                queue_item_ids_json, repository_revision_json, canonical_records_json
           FROM operational_runs
          WHERE repository_key = ? AND status IN ('pending', 'started', 'cancel-requested', 'reconciliation-required')
          ORDER BY requested_at ASC, run_id ASC`,
      )
      .all(key);
    return rows.map(runSummaryFromRow);
  }

  getDispatcherState(repositoryKey: RepositoryKey): DispatcherState {
    return readDispatcherState(this.db, repositoryKey);
  }

  saveDispatcherState(state: DispatcherState): void {
    this.withTransaction((transaction) => transaction.saveDispatcherState(state));
  }
}

export function initializeOperationalStorage(
  storage: PluginStorage,
  options: OperationalStorageOptions = {},
): OperationalStateStore {
  const db = storage.database();
  storage.migrate(db, [...OPERATIONAL_STORAGE_MIGRATIONS]);
  return new OperationalSqliteStore(() => storage.database(), options.now ?? now);
}

export const createOperationalStateStore = initializeOperationalStorage;

interface NormalizedPendingActionIntent {
  readonly request: PendingActionIntentRequest;
  readonly expectedRevision: RepositoryRevision;
  readonly target: PendingActionIntentTarget;
  readonly fileChange: PendingActionFileChange | null;
  readonly submittedAt: string;
  readonly expiresAt: string | null;
}

function claimPendingActionIntent(
  db: SqliteDatabase,
  input: PendingActionIntentInput,
  executionNow: () => string,
): IdempotencyClaim<PendingActionIntentRecord> {
  const normalized = normalizePendingActionIntentInput(input, false, executionNow);
  return insertPendingActionIntent(db, normalized, "action-executor", false, executionNow);
}

function claimInitialReadyIntent(
  db: SqliteDatabase,
  input: InitialReadyIntentInput,
  executionNow: () => string,
): IdempotencyClaim<PendingActionIntentRecord> {
  const request = repositoryActionRequestSchema.parse(input.request);
  if (request.action.kind !== "approve-queue") {
    throw new Error("initial-ready intent requires an approve-queue request");
  }
  const queueItemId = z.string().trim().min(1).parse(input.queueItemId);
  if (request.action.queueItemId !== queueItemId) {
    throw new Error("initial-ready queue item does not match the action request");
  }
  const normalized = normalizePendingActionIntentInput({
    request,
    target: { kind: "queue-item", queueItemId },
    fileChange: input.intendedChange,
    submittedAt: input.submittedAt,
    expiresAt: input.expiresAt,
  }, true, executionNow);
  return insertPendingActionIntent(db, normalized, "native-ui-initial-ready", true, executionNow);
}

function normalizePendingActionIntentInput(
  input: PendingActionIntentInput,
  allowInitialReady: boolean,
  executionNow: () => string,
): NormalizedPendingActionIntent {
  const request = pendingActionRequestSchema.parse(input.request);
  const expectedRevision = repositoryRevisionSchema.parse(request.expectedRevision);
  const target = pendingActionIntentTargetSchema.parse(input.target);
  const submittedAt = isoTimestampSchema.parse(input.submittedAt ?? executionTimestamp(executionNow));
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? null
    : isoTimestampSchema.parse(input.expiresAt);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(submittedAt)) {
    throw new Error("pending action intent expiresAt must be after submittedAt");
  }

  const repositoryRequest = repositoryActionRequestSchema.safeParse(request);
  const fileChange = input.fileChange === undefined || input.fileChange === null
    ? null
    : pendingActionFileChangeSchema.parse(input.fileChange);
  if (repositoryRequest.success) {
    if (repositoryRequest.data.action.kind === "approve-queue" && !allowInitialReady) {
      throw new Error("approve-queue requires the native-ui initial-ready claim");
    }
    if (fileChange === null) {
      throw new Error("repository action intent requires an exact single-file change");
    }
    const expectedPath = repositoryActionFilePath(repositoryRequest.data.action);
    if (fileChange.relativePath !== expectedPath) {
      throw new Error(`repository action file must be ${expectedPath}`);
    }
    const expectedTargetSha256 = expectedRevision.fileDigests[expectedPath];
    if (expectedTargetSha256 !== fileChange.expectedSha256) {
      throw new Error("single-file change hash does not match the expected repository revision");
    }
  } else if (fileChange !== null) {
    throw new Error("BB interaction action intent cannot contain a repository file change");
  }

  assertPendingActionTarget(request, target);
  return { request, expectedRevision, target, fileChange, submittedAt, expiresAt };
}

function repositoryActionFilePath(action: RepositoryActionRequest["action"]): string {
  return action.kind === "answer-question" ? PROTOCOL_PATHS.questions : PROTOCOL_PATHS.queue;
}

function assertPendingActionTarget(
  request: PendingActionIntentRequest,
  target: PendingActionIntentTarget,
): void {
  const repositoryRequest = repositoryActionRequestSchema.safeParse(request);
  if (repositoryRequest.success) {
    const action = repositoryRequest.data.action;
    if (action.kind === "answer-question") {
      if (target.kind !== "repository-question" || target.questionId !== action.questionId) {
        throw new Error("repository-question target does not match the action request");
      }
      return;
    }
    if (target.kind !== "queue-item" || target.queueItemId !== action.queueItemId) {
      throw new Error("queue-item target does not match the action request");
    }
    return;
  }

  const action = (request as BbInteractionActionRequest).action;
  if (action.kind === "answer-question") {
    if (target.kind !== "bb-interaction" || target.interactionId !== action.interactionId) {
      throw new Error("BB interaction target does not match the action request");
    }
    return;
  }
  if (action.kind === "recommend-question") {
    if (target.kind !== "repository-question" || target.questionId !== action.questionId) {
      throw new Error("repository-question target does not match the action request");
    }
    return;
  }
  if (action.kind === "retry") {
    if (target.kind !== "attempt" || target.attemptId !== action.attemptId) {
      throw new Error("attempt target does not match the action request");
    }
    return;
  }
  if (target.kind !== "repository") {
    throw new Error("repository target does not match the action request");
  }
}

function insertPendingActionIntent(
  db: SqliteDatabase,
  normalized: NormalizedPendingActionIntent,
  entryPoint: PendingActionIntentEntryPoint,
  oneShot: boolean,
  executionNow: () => string,
): IdempotencyClaim<PendingActionIntentRecord> {
  const actionKind = actionKindSchema.parse(normalized.request.action.kind);
  const requestFingerprint = createSha256(stableJson({
    request: normalized.request,
    expectedRevision: normalized.expectedRevision,
    target: normalized.target,
    fileChange: normalized.fileChange,
    entryPoint,
    oneShot,
  }));
  const existingBeforeInsert = readPendingActionIntent(db, normalized.request.idempotencyKey);
  if (existingBeforeInsert !== null) {
    if (existingBeforeInsert.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError(normalized.request.idempotencyKey);
    }
    return { created: false, record: existingBeforeInsert };
  }
  if (oneShot && normalized.expiresAt === null) {
    throw new Error(`one-shot pending action intent requires an expiry: ${normalized.request.idempotencyKey}`);
  }
  if (normalized.expiresAt !== null && !isAfter(normalized.expiresAt, executionTimestamp(executionNow))) {
    throw new PendingActionIntentExpiredError(normalized.request.idempotencyKey);
  }
  const inserted = db.prepare(
    `INSERT INTO pending_action_intents (
       idempotency_key, repository_key, action_kind, request_fingerprint,
       request_json, expected_revision_json, target_json, file_change_json,
       entry_point, one_shot, status, submitted_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
  ).run(
    normalized.request.idempotencyKey,
    normalized.request.repositoryKey,
    actionKind,
    requestFingerprint,
    stableJson(persistedRequestPayload(normalized.request)),
    stableJson(normalized.expectedRevision),
    stableJson(normalized.target),
    normalized.fileChange === null ? null : stableJson(normalized.fileChange),
    entryPoint,
    oneShot ? 1 : 0,
    normalized.submittedAt,
    normalized.expiresAt,
  );
  const record = readPendingActionIntent(db, normalized.request.idempotencyKey);
  if (record === null) {
    throw new Error(`pending action intent was not persisted: ${normalized.request.idempotencyKey}`);
  }
  if (inserted.changes === 0) {
    if (record.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError(normalized.request.idempotencyKey);
    }
    return { created: false, record };
  }
  return { created: true, record };
}

function consumePendingActionIntent(
  db: SqliteDatabase,
  idempotencyKey: IdempotencyKey,
  executionNow: () => string,
): PendingActionIntentConsumption {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const consumedAt = executionTimestamp(executionNow);
  const update = db.prepare(
    `UPDATE pending_action_intents
        SET status = 'resolving', last_attempt_at = ?
      WHERE idempotency_key = ?
        AND status = 'pending'
        AND (one_shot = 0 OR expires_at IS NOT NULL)
        AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(consumedAt, key, consumedAt);
  if (update.changes === 1) {
    const record = readPendingActionIntent(db, key);
    if (record === null) {
      throw new Error(`consumed pending action intent disappeared: ${key}`);
    }
    return { consumed: true, record };
  }

  const existing = readPendingActionIntent(db, key);
  if (existing === null) {
    throw new Error(`cannot consume missing pending action intent: ${key}`);
  }
  if (existing.status === "pending") {
    if (existing.expiresAt !== null && !isAfter(existing.expiresAt, consumedAt)) {
      throw new PendingActionIntentExpiredError(key);
    }
    throw new Error(`pending action intent cannot be consumed: ${key}`);
  }
  if (existing.status === "resolving") {
    return { consumed: false, record: existing, reason: "already-submitted" };
  }
  if (existing.status === "completed") {
    return { consumed: false, record: existing, reason: "already-confirmed" };
  }
  return { consumed: false, record: existing, reason: "reconciliation-required" };
}

function updatePendingActionIntent(
  db: SqliteDatabase,
  input: PendingActionIntentUpdate,
  executionNow: () => string,
): PendingActionIntentRecord {
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const existing = readPendingActionIntent(db, idempotencyKey);
  if (existing === null) {
    throw new Error(`cannot update missing pending action intent: ${idempotencyKey}`);
  }
  const status = pendingActionIntentStatusSchema.parse(input.status);
  if (existing.status === "completed" || existing.status === "reconciliation-required") {
    throw new Error(`cannot transition terminal pending action intent: ${idempotencyKey}`);
  }
  if (status === "pending") {
    throw new Error(`pending action intent cannot transition back to pending: ${idempotencyKey}`);
  }
  if (status === "resolving" && existing.status !== "resolving") {
    throw new Error(`pending action intent must be atomically consumed before resolving: ${idempotencyKey}`);
  }
  if (existing.oneShot && existing.status === "pending" && status === "completed") {
    throw new Error(`one-shot pending action intent must be consumed before completion: ${idempotencyKey}`);
  }

  const currentTime = executionTimestamp(executionNow);
  const lastAttemptAt = input.lastAttemptAt === undefined
    ? existing.lastAttemptAt ?? currentTime
    : nullableIsoTimestamp(input.lastAttemptAt, "lastAttemptAt");
  const observedStatus = input.observedStatus === undefined
    ? existing.observedStatus
    : input.observedStatus === null
      ? null
      : pendingActionObservedStatusSchema.parse(input.observedStatus);
  const observedResolution = input.observedResolution === undefined
    ? existing.observedResolution
    : input.observedResolution === null
      ? null
      : bbInteractionResolutionSchema.parse(input.observedResolution);
  if (observedResolution !== null && existing.target.kind !== "bb-interaction") {
    throw new Error("observed BB resolution requires a BB interaction target");
  }
  const lastError = input.lastError === undefined
    ? existing.lastError
    : input.lastError === null
      ? null
      : z.string().trim().min(1).max(4096).parse(input.lastError);
  if (status === "reconciliation-required" && observedStatus === null && observedResolution === null && lastError === null) {
    throw new Error("reconciliation-required intent needs reconciliation metadata");
  }

  const result = input.result === undefined
    ? existing.result
    : input.result === null
      ? null
      : factoryActionResultSchema.parse(input.result);
  const completedAt = status === "completed"
    ? input.completedAt === undefined
      ? existing.completedAt ?? currentTime
      : isoTimestampSchema.parse(input.completedAt)
    : input.completedAt === undefined
      ? existing.completedAt
      : nullableIsoTimestamp(input.completedAt, "completedAt");
  if (status === "completed" && result === null) {
    throw new Error("completed pending action intent requires an action result");
  }
  if (status === "completed" && existing.expiresAt !== null && !isAfter(existing.expiresAt, currentTime)) {
    throw new PendingActionIntentExpiredError(idempotencyKey);
  }
  if (status === "reconciliation-required" && result !== null) {
    throw new Error("reconciliation-required intent cannot have a confirmed result");
  }

  db.prepare(
    `UPDATE pending_action_intents
        SET status = ?, last_attempt_at = ?, completed_at = ?, result_json = ?,
            observed_status = ?, observed_resolution_json = ?, last_error = ?
      WHERE idempotency_key = ?`,
  ).run(
    status,
    lastAttemptAt,
    completedAt,
    result === null ? null : stableJson(result),
    observedStatus,
    observedResolution === null ? null : stableJson(observedResolution),
    lastError,
    idempotencyKey,
  );
  return readPendingActionIntent(db, idempotencyKey)!;
}

function readPendingActionIntent(
  db: SqliteDatabase,
  idempotencyKey: IdempotencyKey,
): PendingActionIntentRecord | null {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const row = db
    .prepare<unknown[], PendingActionIntentRow>(
      `SELECT idempotency_key, repository_key, action_kind, request_fingerprint,
              request_json, expected_revision_json, target_json, file_change_json,
              entry_point, one_shot, status, submitted_at, expires_at,
              last_attempt_at, completed_at, result_json, observed_status,
              observed_resolution_json, last_error
         FROM pending_action_intents
        WHERE idempotency_key = ?`,
    )
    .get(key);
  return row === undefined ? null : pendingActionIntentFromRow(row);
}

function pendingActionIntentFromRow(row: PendingActionIntentRow): PendingActionIntentRecord {
  const expectedRevision = repositoryRevisionSchema.parse(parseJson(row.expected_revision_json));
  const target = pendingActionIntentTargetSchema.parse(parseJson(row.target_json));
  const request = target.kind === "bb-interaction" && row.action_kind === "answer-question"
    ? bbInteractionActionRequestSchema.parse({
      repositoryKey: row.repository_key,
      action: {
        kind: "answer-question",
        source: "bb-interaction",
        interactionId: target.interactionId,
        resolution: bbInteractionResolutionSchema.parse(parseJson(row.request_json)),
      },
      idempotencyKey: row.idempotency_key,
      expectedRevision,
    })
    : pendingActionRequestSchema.parse(parseJson(row.request_json));
  if (request.repositoryKey !== row.repository_key || request.idempotencyKey !== row.idempotency_key) {
    throw new Error("pending action intent request binding is invalid");
  }
  if (stableJson(request.expectedRevision) !== stableJson(expectedRevision)) {
    throw new Error("pending action intent revision binding is invalid");
  }
  const fileChange = row.file_change_json === null
    ? null
    : pendingActionFileChangeSchema.parse(parseJson(row.file_change_json));
  const result = row.result_json === null ? null : factoryActionResultSchema.parse(parseJson(row.result_json));
  const observedResolution = row.observed_resolution_json === null
    ? null
    : bbInteractionResolutionSchema.parse(parseJson(row.observed_resolution_json));
  return {
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    actionKind: actionKindSchema.parse(row.action_kind),
    idempotencyKey: idempotencyKeySchema.parse(row.idempotency_key),
    requestFingerprint: z.string().trim().min(1).parse(row.request_fingerprint),
    request,
    expectedRevision,
    target,
    fileChange,
    entryPoint: pendingActionIntentEntryPointSchema.parse(row.entry_point),
    oneShot: row.one_shot === 1,
    status: pendingActionIntentStatusSchema.parse(row.status),
    submittedAt: isoTimestampSchema.parse(row.submitted_at),
    expiresAt: row.expires_at === null ? null : isoTimestampSchema.parse(row.expires_at),
    lastAttemptAt: row.last_attempt_at === null ? null : isoTimestampSchema.parse(row.last_attempt_at),
    completedAt: row.completed_at === null ? null : isoTimestampSchema.parse(row.completed_at),
    result,
    observedStatus: row.observed_status === null ? null : pendingActionObservedStatusSchema.parse(row.observed_status),
    observedResolution,
    lastError: row.last_error,
  };
}

const dispatcherStateLimitsSchema = z.record(z.string(), z.number().int().nonnegative());

export function emptyDispatcherState(repositoryKey: RepositoryKey): DispatcherState {
  return {
    repositoryKey,
    nightKey: "",
    lastState: "",
    failedCount: 0,
    noopCount: 0,
    lastStartAt: 0,
    lastStartProvider: "",
    limits: {},
  };
}

function readDispatcherState(db: SqliteDatabase, repositoryKey: RepositoryKey): DispatcherState {
  const key = repositoryKeySchema.parse(repositoryKey);
  const row = db
    .prepare<unknown[], DispatcherStateRow>(
      `SELECT repository_key, night_key, last_state, failed_count, noop_count,
              last_start_at, last_start_provider, limits_json
         FROM dispatcher_states
        WHERE repository_key = ?`,
    )
    .get(key);
  if (row === undefined) return emptyDispatcherState(key);
  return {
    repositoryKey: key,
    nightKey: row.night_key,
    lastState: row.last_state,
    failedCount: row.failed_count,
    noopCount: row.noop_count,
    lastStartAt: row.last_start_at,
    lastStartProvider: row.last_start_provider,
    limits: dispatcherStateLimitsSchema.parse(parseJson(row.limits_json)),
  };
}

function saveDispatcherState(db: SqliteDatabase, state: DispatcherState): void {
  const repositoryKey = repositoryKeySchema.parse(state.repositoryKey);
  const limits = dispatcherStateLimitsSchema.parse(state.limits);
  db.prepare(
    `INSERT INTO dispatcher_states (
       repository_key, night_key, last_state, failed_count, noop_count,
       last_start_at, last_start_provider, limits_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repository_key) DO UPDATE SET
       night_key = excluded.night_key,
       last_state = excluded.last_state,
       failed_count = excluded.failed_count,
       noop_count = excluded.noop_count,
       last_start_at = excluded.last_start_at,
       last_start_provider = excluded.last_start_provider,
       limits_json = excluded.limits_json`,
  ).run(
    repositoryKey,
    z.string().parse(state.nightKey),
    z.string().parse(state.lastState),
    z.number().int().nonnegative().parse(state.failedCount),
    z.number().int().nonnegative().parse(state.noopCount),
    z.number().int().nonnegative().parse(state.lastStartAt),
    z.string().parse(state.lastStartProvider),
    stableJson(limits),
  );
}

function persistedRequestPayload(request: PendingActionIntentRequest): unknown {
  const bbRequest = bbInteractionActionRequestSchema.safeParse(request);
  if (bbRequest.success && bbRequest.data.action.kind === "answer-question") {
    return bbRequest.data.action.resolution;
  }
  return request;
}

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

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function executionTimestamp(clock: () => string): string {
  try {
    return isoTimestampSchema.parse(clock());
  } catch {
    throw new Error("operational storage clock must return an ISO timestamp");
  }
}

function isAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function nullableIsoTimestamp(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }
  try {
    return isoTimestampSchema.parse(value);
  } catch {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}

function now(): string {
  return new Date().toISOString();
}
