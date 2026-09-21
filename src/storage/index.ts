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
  ProvisionCheckoutActionRequest,
  RepositoryKey,
  RepositoryActionRequest,
  RepositoryRevision,
  RunIntent,
  ScaffoldProtocolActionRequest,
} from "../contracts.js";
import {
  EMPTY_REPOSITORY_REVISION,
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
  operationalRunStatusSchema,
  operationalRunSummarySchema,
  ownershipLeaseSchema,
  provisionCheckoutActionRequestSchema,
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
  provisionCheckoutActionRequestSchema,
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
  // SQLite cannot alter a CHECK constraint, so widening action_kind for
  // provision-checkout rebuilds the table again.
  `CREATE TABLE pending_action_intents_v4 (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'recommend-question', 'retry', 'stop', 'scaffold-protocol', 'provision-checkout')),
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
  `INSERT INTO pending_action_intents_v4 SELECT * FROM pending_action_intents`,
  `DROP TABLE pending_action_intents`,
  `ALTER TABLE pending_action_intents_v4 RENAME TO pending_action_intents`,
  // SQLite cannot alter a CHECK constraint, so widening action_kind for
  // recommend-approval rebuilds the table again.
  `CREATE TABLE pending_action_intents_v5 (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'recommend-question', 'recommend-approval', 'retry', 'stop', 'scaffold-protocol', 'provision-checkout')),
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
  `INSERT INTO pending_action_intents_v5 SELECT * FROM pending_action_intents`,
  `DROP TABLE pending_action_intents`,
  `ALTER TABLE pending_action_intents_v5 RENAME TO pending_action_intents`,
  // SQLite cannot alter a CHECK constraint, so widening action_kind for
  // draft-tasks rebuilds the table again.
  `CREATE TABLE pending_action_intents_v6 (
    idempotency_key TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('run-now', 'pause', 'resume', 'answer-question', 'approve-queue', 'recommend-question', 'recommend-approval', 'draft-tasks', 'retry', 'stop', 'scaffold-protocol', 'provision-checkout')),
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
  `INSERT INTO pending_action_intents_v6 SELECT * FROM pending_action_intents`,
  `DROP TABLE pending_action_intents`,
  `ALTER TABLE pending_action_intents_v6 RENAME TO pending_action_intents`,
  `CREATE TABLE run_reconciliation_metadata (
    run_id TEXT PRIMARY KEY REFERENCES operational_runs(run_id),
    first_detected_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    raw_observation TEXT,
    detection_count INTEGER NOT NULL CHECK (detection_count > 0),
    resolved_at TEXT,
    resolution TEXT CHECK (resolution IS NULL OR resolution IN ('completed', 'blocked', 'failed-safe', 'no-op'))
  )`,
  `ALTER TABLE run_reconciliation_metadata ADD COLUMN resolution_reason TEXT`,
  `CREATE TABLE stop_intents (
    token TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES operational_runs(run_id),
    attempt_id TEXT NOT NULL REFERENCES dispatch_attempts(attempt_id),
    lease_id TEXT NOT NULL REFERENCES ownership_leases(lease_id),
    repository_key TEXT NOT NULL,
    worker_thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX stop_intent_one_per_run ON stop_intents(run_id)`,
  `CREATE TABLE tasks_approval_records (
    approval_id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    operation_class TEXT NOT NULL,
    content_revision TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (repository_key, task_id, operation_class, content_revision)
  )`,
  `CREATE INDEX tasks_approval_lookup
    ON tasks_approval_records(repository_key, task_id, operation_class, content_revision)`,
  `CREATE TABLE tasks_dependency_edges (
    repository_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repository_key, task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
  )`,
  `CREATE INDEX tasks_dependency_reverse_lookup
    ON tasks_dependency_edges(repository_key, depends_on_task_id)`,
  `CREATE TABLE tasks_blocker_records (
    blocker_id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('blocking-question', 'dependency-blocker')),
    state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'resolved')),
    question_text TEXT NOT NULL,
    answer_text TEXT,
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    answered_at TEXT,
    resolved_at TEXT
  )`,
  `CREATE INDEX tasks_blocker_lookup
    ON tasks_blocker_records(repository_key, task_id, state)`,
  // The approval table's UNIQUE constraint already supplies this lookup.
  `DROP INDEX IF EXISTS tasks_approval_lookup`,
  `CREATE TRIGGER tasks_approval_records_no_update
    BEFORE UPDATE ON tasks_approval_records
    BEGIN
      SELECT RAISE(ABORT, 'tasks approval records are append-only');
    END`,
  `CREATE TRIGGER tasks_approval_records_no_delete
    BEFORE DELETE ON tasks_approval_records
    BEGIN
      SELECT RAISE(ABORT, 'tasks approval records are append-only');
    END`,
  `ALTER TABLE operational_runs ADD COLUMN task_id TEXT`,
  `ALTER TABLE dispatch_attempts ADD COLUMN task_id TEXT`,
  `ALTER TABLE dispatch_attempts ADD COLUMN tasks_live_status TEXT CHECK (tasks_live_status IS NULL OR tasks_live_status IN ('starting', 'working', 'idle', 'completed', 'failed'))`,
] as const;

const tasksOperationClassSchema = z.string().trim().min(1).max(128);
const tasksTaskIdSchema = z.string().trim().min(1).max(256);
const tasksContentRevisionSchema = z.string().trim().min(1).max(256);
const tasksBlockerKindSchema = z.enum(["blocking-question", "dependency-blocker"]);
const tasksBlockerStateSchema = z.enum(["open", "answered", "resolved"]);

export type TasksOperationClass = z.infer<typeof tasksOperationClassSchema>;
export type TasksBlockerKind = z.infer<typeof tasksBlockerKindSchema>;
export type TasksBlockerState = z.infer<typeof tasksBlockerStateSchema>;

export interface TasksApprovalRecord {
  readonly approvalId: string;
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly operationClass: TasksOperationClass;
  /** The grant is valid only for this exact task content revision. */
  readonly contentRevision: string;
  readonly provenance: JsonValue;
  readonly createdAt: string;
}

export interface CreateTasksApprovalInput {
  readonly approvalId: string;
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly operationClass: TasksOperationClass;
  readonly contentRevision: string;
  readonly provenance: JsonValue;
  readonly createdAt?: string;
}

export interface TasksDependencyEdge {
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly provenance: JsonValue;
  readonly createdAt: string;
}

export interface CreateTasksDependencyEdgeInput {
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly provenance: JsonValue;
  readonly createdAt?: string;
}

export interface TasksBlockerRecord {
  readonly blockerId: string;
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly kind: TasksBlockerKind;
  readonly state: TasksBlockerState;
  readonly questionText: string;
  readonly answerText: string | null;
  readonly provenance: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly answeredAt: string | null;
  readonly resolvedAt: string | null;
}

export interface CreateTasksBlockerInput {
  readonly blockerId: string;
  readonly repositoryKey: RepositoryKey;
  readonly taskId: string;
  readonly kind: TasksBlockerKind;
  readonly questionText: string;
  readonly createdAt?: string;
  readonly provenance?: JsonValue;
}

export interface UpdateTasksBlockerInput {
  readonly blockerId: string;
  readonly state: Exclude<TasksBlockerState, "open">;
  readonly answerText?: string | null;
  readonly updatedAt?: string;
}

interface TasksApprovalRow {
  approval_id: string;
  repository_key: string;
  task_id: string;
  operation_class: string;
  content_revision: string;
  provenance_json: string;
  created_at: string;
}

interface TasksDependencyRow {
  repository_key: string;
  task_id: string;
  depends_on_task_id: string;
  provenance_json: string;
  created_at: string;
}

interface TasksBlockerRow {
  blocker_id: string;
  repository_key: string;
  task_id: string;
  kind: string;
  state: string;
  question_text: string;
  answer_text: string | null;
  provenance_json: string;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
  resolved_at: string | null;
}

export interface CreateRunIntentInput {
  readonly intent: RunIntent;
  readonly canonicalRecords?: readonly CanonicalFileRecordLink[];
}

export interface CreateRunIntentResult {
  readonly created: boolean;
  readonly runId: string;
}

export interface StopIntent {
  readonly token: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly repositoryKey: RepositoryKey;
  readonly workerThreadId: string;
  readonly createdAt: string;
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
  readonly taskId?: string | null;
}

export type ReconciliationResolution = "completed" | "blocked" | "failed-safe" | "no-op";

export interface ReconciliationMetadata {
  readonly runId: string;
  readonly firstDetectedAt: string;
  readonly deadlineAt: string;
  readonly reasonCode: string;
  readonly rawObservation: string | null;
  readonly detectionCount: number;
  readonly resolvedAt: string | null;
  readonly resolution: ReconciliationResolution | null;
  readonly resolutionReason: string | null;
}

export interface ReconciliationObservation {
  readonly runId: string;
  readonly firstDetectedAt: string;
  readonly deadlineAt: string;
  readonly reasonCode: string;
  readonly rawObservation?: string | null;
}

export interface ReconciliationResolutionUpdate {
  readonly runId: string;
  readonly resolvedAt: string;
  readonly resolution: ReconciliationResolution;
  readonly reasonCode: string;
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

export type PendingActionIntentRequest =
  | RepositoryActionRequest
  | BbInteractionActionRequest
  | ScaffoldProtocolActionRequest
  | ProvisionCheckoutActionRequest;
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
  getRunSummary(runId: string): OperationalRunSummary | null;
  getRunStatus(runId: string): OperationalRunStatus | null;
  getActiveAttempt(runId: string): DispatchAttempt | null;
  hasDispatchAttemptStatus(runId: string, status: DispatchAttempt["status"]): boolean;
  getDispatchAttempt(attemptId: string): DispatchAttempt | null;
  getLeaseForRun(runId: string): OwnershipLease | null;
  getCurrentOwnership(repositoryKey: RepositoryKey): OwnershipLease | null;
  getReconciliation(runId: string): ReconciliationMetadata | null;
  getStopIntent(runId: string): StopIntent | null;
  assertGlobalCapacity(repositoryKey: RepositoryKey, limit: number, excludingRunId?: string): void;
  updateRunTaskId(runId: string, taskId: string): void;
  createRunIntent(input: CreateRunIntentInput): CreateRunIntentResult;
  updateRunDispatch(input: RunDispatchUpdate): void;
  createDispatchAttempt(attempt: DispatchAttempt): void;
  updateDispatchAttempt(attempt: DispatchAttempt): void;
  createOwnershipLease(lease: OwnershipLease): void;
  updateOwnershipLease(lease: OwnershipLease): void;
  createStopIntent(input: StopIntent): void;
  deleteStopIntent(token: string): void;
  resetReconciliation(runId: string): void;
  recordReconciliation(input: ReconciliationObservation): ReconciliationMetadata;
  resolveReconciliation(input: ReconciliationResolutionUpdate): ReconciliationMetadata | null;
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
  createTasksApproval(input: CreateTasksApprovalInput): TasksApprovalRecord;
  getTasksApproval(input: Pick<CreateTasksApprovalInput, "repositoryKey" | "taskId" | "operationClass" | "contentRevision">): TasksApprovalRecord | null;
  listTasksApprovals(repositoryKey: RepositoryKey, taskId?: string): TasksApprovalRecord[];
  createTasksDependencyEdge(input: CreateTasksDependencyEdgeInput): TasksDependencyEdge;
  listTasksDependencyEdges(repositoryKey: RepositoryKey): TasksDependencyEdge[];
  createTasksBlocker(input: CreateTasksBlockerInput): TasksBlockerRecord;
  updateTasksBlocker(input: UpdateTasksBlockerInput): TasksBlockerRecord;
  getTasksBlocker(blockerId: string): TasksBlockerRecord | null;
  listTasksBlockers(repositoryKey: RepositoryKey, taskId?: string): TasksBlockerRecord[];
}

export interface OperationalStateStore extends OperationalStateReader {
  readonly db: SqliteDatabase;
  withTransaction<T>(callback: (transaction: OperationalTransaction) => T): T;
  createRunIntent(input: CreateRunIntentInput): CreateRunIntentResult;
  updateRunDispatch(input: RunDispatchUpdate): void;
  updateRunTaskId(runId: string, taskId: string): void;
  createDispatchAttempt(attempt: DispatchAttempt): void;
  updateDispatchAttempt(attempt: DispatchAttempt): void;
  createOwnershipLease(lease: OwnershipLease): void;
  updateOwnershipLease(lease: OwnershipLease): void;
  createStopIntent(input: StopIntent): void;
  deleteStopIntent(token: string): void;
  resetReconciliation(runId: string): void;
  recordReconciliation(input: ReconciliationObservation): ReconciliationMetadata;
  resolveReconciliation(input: ReconciliationResolutionUpdate): ReconciliationMetadata | null;
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
  getReconciliation(runId: string): ReconciliationMetadata | null;
  getStopIntent(runId: string): StopIntent | null;
  findRunIdByIdempotencyKey(idempotencyKey: IdempotencyKey): string | null;
  listActiveRuns(repositoryKey: RepositoryKey): OperationalRunSummary[];
  getDispatcherState(repositoryKey: RepositoryKey): DispatcherState;
  saveDispatcherState(state: DispatcherState): void;
  createTasksApproval(input: CreateTasksApprovalInput): TasksApprovalRecord;
  getTasksApproval(input: Pick<CreateTasksApprovalInput, "repositoryKey" | "taskId" | "operationClass" | "contentRevision">): TasksApprovalRecord | null;
  listTasksApprovals(repositoryKey: RepositoryKey, taskId?: string): TasksApprovalRecord[];
  createTasksDependencyEdge(input: CreateTasksDependencyEdgeInput): TasksDependencyEdge;
  listTasksDependencyEdges(repositoryKey: RepositoryKey): TasksDependencyEdge[];
  createTasksBlocker(input: CreateTasksBlockerInput): TasksBlockerRecord;
  updateTasksBlocker(input: UpdateTasksBlockerInput): TasksBlockerRecord;
  getTasksBlocker(blockerId: string): TasksBlockerRecord | null;
  listTasksBlockers(repositoryKey: RepositoryKey, taskId?: string): TasksBlockerRecord[];
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
  task_id: string | null;
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
  task_id: string | null;
  tasks_live_status: string | null;
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

interface StopIntentRow {
  token: string;
  run_id: string;
  attempt_id: string;
  lease_id: string;
  repository_key: string;
  worker_thread_id: string;
  created_at: string;
}

interface ReconciliationRow {
  run_id: string;
  first_detected_at: string;
  deadline_at: string;
  reason_code: string;
  raw_observation: string | null;
  detection_count: number;
  resolved_at: string | null;
  resolution: string | null;
  resolution_reason: string | null;
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

class GlobalConcurrencyLimitError extends Error {
  readonly code = "global-concurrency-limit";

  constructor(limit: number) {
    super(`global run concurrency limit of ${limit} is reached`);
    this.name = "GlobalConcurrencyLimitError";
  }
}

export { GlobalConcurrencyLimitError };

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

  updateRunTaskId(runId: string, taskId: string): void {
    this.withTransaction((transaction) => transaction.updateRunTaskId(runId, taskId));
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

  createStopIntent(input: StopIntent): void {
    this.withTransaction((transaction) => transaction.createStopIntent(input));
  }

  deleteStopIntent(token: string): void {
    this.withTransaction((transaction) => transaction.deleteStopIntent(token));
  }

  resetReconciliation(runId: string): void {
    this.withTransaction((transaction) => transaction.resetReconciliation(runId));
  }

  recordReconciliation(input: ReconciliationObservation): ReconciliationMetadata {
    return this.withTransaction((transaction) => transaction.recordReconciliation(input));
  }

  resolveReconciliation(input: ReconciliationResolutionUpdate): ReconciliationMetadata | null {
    return this.withTransaction((transaction) => transaction.resolveReconciliation(input));
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
    return readCurrentOwnership(this.db, repositoryKey);
  }

  getStopIntent(runId: string): StopIntent | null {
    return readStopIntent(this.db, runId);
  }

  async listRuns(input: OperationalRunListInput): Promise<OperationalRunListProjection> {
    const parsed = operationalRunListInputSchema.parse(input);
    const cursor = parsed.cursor === undefined ? null : decodeCursor(parsed.cursor);
    const rows = this.db
      .prepare<unknown[], RunRow>(
        `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
                provider_id, worker_thread_id, project_id, environment_id,
                queue_item_ids_json, repository_revision_json, canonical_records_json, task_id
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
                repository_revision_json, canonical_records_json, task_id
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
                reasoning_level, worker_thread_id, status, started_at, finished_at,
                task_id, tasks_live_status
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
      getRunSummary: (runId) => readRunSummary(this.db, runId),
      getRunStatus: (runId) => readRunStatus(this.db, runId),
      getActiveAttempt: (runId) => readActiveAttempt(this.db, runId),
      hasDispatchAttemptStatus: (runId, status) => hasDispatchAttemptStatus(this.db, runId, status),
      getDispatchAttempt: (attemptId) => readDispatchAttempt(this.db, attemptId),
      getLeaseForRun: (runId) => readLeaseForRun(this.db, runId),
      getCurrentOwnership: (repositoryKey) => readCurrentOwnership(this.db, repositoryKey),
      getReconciliation: (runId) => readReconciliation(this.db, runId),
      getStopIntent: (runId) => readStopIntent(this.db, runId),
      assertGlobalCapacity: (repositoryKey, limit, excludingRunId) => assertGlobalCapacity(this.db, repositoryKey, limit, excludingRunId),
      updateRunTaskId: (runId, taskId) => updateRunTaskId(this.db, runId, taskId),
      createRunIntent: (input) => insertRunIntent(this.db, input),
      updateRunDispatch: (input) => updateRunDispatch(this.db, input),
      createDispatchAttempt: (attempt) => insertDispatchAttempt(this.db, attempt),
      updateDispatchAttempt: (attempt) => updateDispatchAttempt(this.db, attempt),
      createOwnershipLease: (lease) => insertOwnershipLease(this.db, lease),
      updateOwnershipLease: (lease) => updateOwnershipLease(this.db, lease),
      createStopIntent: (input) => insertStopIntent(this.db, input),
      deleteStopIntent: (token) => deleteStopIntent(this.db, token),
      resetReconciliation: (runId) => resetReconciliation(this.db, runId),
      recordReconciliation: (input) => recordReconciliation(this.db, input),
      resolveReconciliation: (input) => resolveReconciliation(this.db, input),
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
      createTasksApproval: (input) => createTasksApproval(this.db, input, this.executionNow),
      getTasksApproval: (input) => readTasksApproval(this.db, input),
      listTasksApprovals: (repositoryKey, taskId) => listTasksApprovals(this.db, repositoryKey, taskId),
      createTasksDependencyEdge: (input) => createTasksDependencyEdge(this.db, input, this.executionNow),
      listTasksDependencyEdges: (repositoryKey) => listTasksDependencyEdges(this.db, repositoryKey),
      createTasksBlocker: (input) => createTasksBlocker(this.db, input, this.executionNow),
      updateTasksBlocker: (input) => updateTasksBlocker(this.db, input, this.executionNow),
      getTasksBlocker: (blockerId) => readTasksBlocker(this.db, blockerId),
      listTasksBlockers: (repositoryKey, taskId) => listTasksBlockers(this.db, repositoryKey, taskId),
    };
  }

  getDispatchAttempt(attemptId: string): DispatchAttempt | null {
    const row = this.db
      .prepare<unknown[], AttemptRow>(
        `SELECT attempt_id, run_id, repository_key, provider_id, model,
                reasoning_level, worker_thread_id, status, started_at, finished_at,
                task_id, tasks_live_status
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

  getReconciliation(runId: string): ReconciliationMetadata | null {
    return readReconciliation(this.db, runId);
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
                queue_item_ids_json, repository_revision_json, canonical_records_json, task_id
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

  createTasksApproval(input: CreateTasksApprovalInput): TasksApprovalRecord {
    return this.withTransaction((transaction) => transaction.createTasksApproval(input));
  }

  getTasksApproval(input: Pick<CreateTasksApprovalInput, "repositoryKey" | "taskId" | "operationClass" | "contentRevision">): TasksApprovalRecord | null {
    return readTasksApproval(this.db, input);
  }

  listTasksApprovals(repositoryKey: RepositoryKey, taskId?: string): TasksApprovalRecord[] {
    return listTasksApprovals(this.db, repositoryKey, taskId);
  }

  createTasksDependencyEdge(input: CreateTasksDependencyEdgeInput): TasksDependencyEdge {
    return this.withTransaction((transaction) => transaction.createTasksDependencyEdge(input));
  }

  listTasksDependencyEdges(repositoryKey: RepositoryKey): TasksDependencyEdge[] {
    return listTasksDependencyEdges(this.db, repositoryKey);
  }

  createTasksBlocker(input: CreateTasksBlockerInput): TasksBlockerRecord {
    return this.withTransaction((transaction) => transaction.createTasksBlocker(input));
  }

  updateTasksBlocker(input: UpdateTasksBlockerInput): TasksBlockerRecord {
    return this.withTransaction((transaction) => transaction.updateTasksBlocker(input));
  }

  getTasksBlocker(blockerId: string): TasksBlockerRecord | null {
    return readTasksBlocker(this.db, blockerId);
  }

  listTasksBlockers(repositoryKey: RepositoryKey, taskId?: string): TasksBlockerRecord[] {
    return listTasksBlockers(this.db, repositoryKey, taskId);
  }
}

export function initializeOperationalStorage(
  storage: PluginStorage,
  options: OperationalStorageOptions = {},
): OperationalStateStore {
  const db = storage.database();
  // Rebuild migrations drop and rename live tables while child tables still
  // hold REFERENCES rows; enforcement must pause for the migration window.
  db.pragma("foreign_keys = OFF");
  try {
    storage.migrate(db, [...OPERATIONAL_STORAGE_MIGRATIONS]);
  } finally {
    db.pragma("foreign_keys = ON");
  }
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
  const parsedRequest = pendingActionRequestSchema.parse(input.request);
  const request = parsedRequest.expectedRevision === undefined
    ? { ...parsedRequest, expectedRevision: EMPTY_REPOSITORY_REVISION }
    : parsedRequest;
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
  if (action.kind === "recommend-approval") {
    if (target.kind !== "queue-item" || target.queueItemId !== action.queueItemId) {
      throw new Error("queue-item target does not match the action request");
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

function createTasksApproval(
  db: SqliteDatabase,
  input: CreateTasksApprovalInput,
  executionNow: () => string,
): TasksApprovalRecord {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const approvalId = z.string().trim().min(1).max(256).parse(input.approvalId);
  const taskId = tasksTaskIdSchema.parse(input.taskId);
  const operationClass = tasksOperationClassSchema.parse(input.operationClass);
  const contentRevision = tasksContentRevisionSchema.parse(input.contentRevision);
  const createdAt = executionTimestamp(() => input.createdAt ?? executionNow());
  const existingById = db.prepare<unknown[], TasksApprovalRow>(
    `SELECT approval_id, repository_key, task_id, operation_class,
            content_revision, provenance_json, created_at
       FROM tasks_approval_records
      WHERE approval_id = ?`,
  ).get(approvalId);
  if (existingById !== undefined) {
    const existing = tasksApprovalFromRow(existingById);
    if (existing.repositoryKey !== repositoryKey
      || existing.taskId !== taskId
      || existing.operationClass !== operationClass
      || existing.contentRevision !== contentRevision) {
      throw new Error(`tasks approval id is already bound to a different grant: ${approvalId}`);
    }
    return existing;
  }
  const existingByKey = db.prepare<unknown[], TasksApprovalRow>(
    `SELECT approval_id, repository_key, task_id, operation_class,
            content_revision, provenance_json, created_at
       FROM tasks_approval_records
      WHERE repository_key = ? AND task_id = ?
        AND operation_class = ? AND content_revision = ?`,
  ).get(repositoryKey, taskId, operationClass, contentRevision);
  if (existingByKey !== undefined) return tasksApprovalFromRow(existingByKey);

  db.prepare(
    `INSERT INTO tasks_approval_records (
       approval_id, repository_key, task_id, operation_class,
       content_revision, provenance_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approvalId,
    repositoryKey,
    taskId,
    operationClass,
    contentRevision,
    stableJson(input.provenance),
    createdAt,
  );
  const inserted = readTasksApproval(db, { repositoryKey, taskId, operationClass, contentRevision });
  if (inserted === null) throw new Error(`tasks approval was not persisted: ${approvalId}`);
  return inserted;
}

function readTasksApproval(
  db: SqliteDatabase,
  input: Pick<CreateTasksApprovalInput, "repositoryKey" | "taskId" | "operationClass" | "contentRevision">,
): TasksApprovalRecord | null {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const taskId = tasksTaskIdSchema.parse(input.taskId);
  const operationClass = tasksOperationClassSchema.parse(input.operationClass);
  const contentRevision = tasksContentRevisionSchema.parse(input.contentRevision);
  const row = db.prepare<unknown[], TasksApprovalRow>(
    `SELECT approval_id, repository_key, task_id, operation_class,
            content_revision, provenance_json, created_at
       FROM tasks_approval_records
      WHERE repository_key = ? AND task_id = ?
        AND operation_class = ? AND content_revision = ?`,
  ).get(repositoryKey, taskId, operationClass, contentRevision);
  return row === undefined ? null : tasksApprovalFromRow(row);
}

function listTasksApprovals(db: SqliteDatabase, repositoryKey: RepositoryKey, taskId?: string): TasksApprovalRecord[] {
  const key = repositoryKeySchema.parse(repositoryKey);
  const parsedTaskId = taskId === undefined ? undefined : tasksTaskIdSchema.parse(taskId);
  const rows = db.prepare<unknown[], TasksApprovalRow>(
    `SELECT approval_id, repository_key, task_id, operation_class,
            content_revision, provenance_json, created_at
       FROM tasks_approval_records
      WHERE repository_key = ? AND (? IS NULL OR task_id = ?)
      ORDER BY created_at ASC, approval_id ASC`,
  ).all(key, parsedTaskId ?? null, parsedTaskId ?? null);
  return rows.map(tasksApprovalFromRow);
}

function createTasksDependencyEdge(
  db: SqliteDatabase,
  input: CreateTasksDependencyEdgeInput,
  executionNow: () => string,
): TasksDependencyEdge {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const taskId = tasksTaskIdSchema.parse(input.taskId);
  const dependsOnTaskId = tasksTaskIdSchema.parse(input.dependsOnTaskId);
  if (taskId === dependsOnTaskId) throw new Error("dependency cycle rejected: a task cannot depend on itself");
  const createdAt = executionTimestamp(() => input.createdAt ?? executionNow());
  const existing = db.prepare<unknown[], TasksDependencyRow>(
    `SELECT repository_key, task_id, depends_on_task_id, provenance_json, created_at
       FROM tasks_dependency_edges
      WHERE repository_key = ? AND task_id = ? AND depends_on_task_id = ?`,
  ).get(repositoryKey, taskId, dependsOnTaskId);
  if (existing !== undefined) return tasksDependencyFromRow(existing);

  const cycle = db.prepare<unknown[], { found: number }>(
    `WITH RECURSIVE reachable(task_id) AS (
       SELECT ?
       UNION
       SELECT edge.depends_on_task_id
         FROM tasks_dependency_edges edge
         JOIN reachable ON reachable.task_id = edge.task_id
        WHERE edge.repository_key = ?
     )
     SELECT 1 AS found FROM reachable WHERE task_id = ? LIMIT 1`,
  ).get(dependsOnTaskId, repositoryKey, taskId);
  if (cycle !== undefined) {
    throw new Error(`dependency cycle rejected: ${taskId} depends on ${dependsOnTaskId}`);
  }

  db.prepare(
    `INSERT INTO tasks_dependency_edges (
       repository_key, task_id, depends_on_task_id, provenance_json, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(repositoryKey, taskId, dependsOnTaskId, stableJson(input.provenance), createdAt);
  const inserted = db.prepare<unknown[], TasksDependencyRow>(
    `SELECT repository_key, task_id, depends_on_task_id, provenance_json, created_at
       FROM tasks_dependency_edges
      WHERE repository_key = ? AND task_id = ? AND depends_on_task_id = ?`,
  ).get(repositoryKey, taskId, dependsOnTaskId);
  if (inserted === undefined) throw new Error(`tasks dependency edge was not persisted: ${taskId}/${dependsOnTaskId}`);
  return tasksDependencyFromRow(inserted);
}

function listTasksDependencyEdges(db: SqliteDatabase, repositoryKey: RepositoryKey): TasksDependencyEdge[] {
  const key = repositoryKeySchema.parse(repositoryKey);
  const rows = db.prepare<unknown[], TasksDependencyRow>(
    `SELECT repository_key, task_id, depends_on_task_id, provenance_json, created_at
       FROM tasks_dependency_edges
      WHERE repository_key = ?
      ORDER BY created_at ASC, task_id ASC, depends_on_task_id ASC`,
  ).all(key);
  return rows.map(tasksDependencyFromRow);
}

function createTasksBlocker(
  db: SqliteDatabase,
  input: CreateTasksBlockerInput,
  executionNow: () => string,
): TasksBlockerRecord {
  const blockerId = z.string().trim().min(1).max(256).parse(input.blockerId);
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const taskId = tasksTaskIdSchema.parse(input.taskId);
  const kind = tasksBlockerKindSchema.parse(input.kind);
  const questionText = z.string().trim().min(1).max(32_768).parse(input.questionText);
  const createdAt = executionTimestamp(() => input.createdAt ?? executionNow());
  const existing = readTasksBlocker(db, blockerId);
  if (existing !== null) {
    if (existing.repositoryKey !== repositoryKey || existing.taskId !== taskId || existing.kind !== kind || existing.questionText !== questionText) {
      throw new Error(`tasks blocker id is already bound to a different blocker: ${blockerId}`);
    }
    return existing;
  }
  db.prepare(
    `INSERT INTO tasks_blocker_records (
       blocker_id, repository_key, task_id, kind, state, question_text,
       answer_text, provenance_json, created_at, updated_at, answered_at, resolved_at
     ) VALUES (?, ?, ?, ?, 'open', ?, NULL, ?, ?, ?, NULL, NULL)`,
  ).run(blockerId, repositoryKey, taskId, kind, questionText, stableJson(input.provenance ?? { source: "factory" }), createdAt, createdAt);
  const inserted = readTasksBlocker(db, blockerId);
  if (inserted === null) throw new Error(`tasks blocker was not persisted: ${blockerId}`);
  return inserted;
}

function updateTasksBlocker(
  db: SqliteDatabase,
  input: UpdateTasksBlockerInput,
  executionNow: () => string,
): TasksBlockerRecord {
  const blockerId = z.string().trim().min(1).max(256).parse(input.blockerId);
  const state = z.enum(["answered", "resolved"]).parse(input.state);
  const existing = readTasksBlocker(db, blockerId);
  if (existing === null) throw new Error(`cannot update missing tasks blocker: ${blockerId}`);
  if (existing.state === "resolved") throw new Error(`cannot update resolved tasks blocker: ${blockerId}`);
  const updatedAt = executionTimestamp(() => input.updatedAt ?? executionNow());
  const answerText = input.answerText === undefined ? existing.answerText : input.answerText;
  if (state === "answered" && (answerText === null || answerText.trim().length === 0)) {
    throw new Error(`answered tasks blocker requires answer text: ${blockerId}`);
  }
  const answeredAt = state === "answered" ? existing.answeredAt ?? updatedAt : existing.answeredAt;
  const resolvedAt = state === "resolved" ? existing.resolvedAt ?? updatedAt : existing.resolvedAt;
  db.prepare(
    `UPDATE tasks_blocker_records
        SET state = ?, answer_text = ?, updated_at = ?, answered_at = ?, resolved_at = ?
      WHERE blocker_id = ?`,
  ).run(state, answerText, updatedAt, answeredAt, resolvedAt, blockerId);
  return readTasksBlocker(db, blockerId)!;
}

function readTasksBlocker(db: SqliteDatabase, blockerId: string): TasksBlockerRecord | null {
  const id = z.string().trim().min(1).max(256).parse(blockerId);
  const row = db.prepare<unknown[], TasksBlockerRow>(
    `SELECT blocker_id, repository_key, task_id, kind, state, question_text,
            answer_text, provenance_json, created_at, updated_at, answered_at, resolved_at
       FROM tasks_blocker_records
      WHERE blocker_id = ?`,
  ).get(id);
  return row === undefined ? null : tasksBlockerFromRow(row);
}

function listTasksBlockers(db: SqliteDatabase, repositoryKey: RepositoryKey, taskId?: string): TasksBlockerRecord[] {
  const key = repositoryKeySchema.parse(repositoryKey);
  const parsedTaskId = taskId === undefined ? undefined : tasksTaskIdSchema.parse(taskId);
  const rows = db.prepare<unknown[], TasksBlockerRow>(
    `SELECT blocker_id, repository_key, task_id, kind, state, question_text,
            answer_text, provenance_json, created_at, updated_at, answered_at, resolved_at
       FROM tasks_blocker_records
      WHERE repository_key = ? AND (? IS NULL OR task_id = ?)
      ORDER BY created_at ASC, blocker_id ASC`,
  ).all(key, parsedTaskId ?? null, parsedTaskId ?? null);
  return rows.map(tasksBlockerFromRow);
}

function tasksApprovalFromRow(row: TasksApprovalRow): TasksApprovalRecord {
  return {
    approvalId: z.string().trim().min(1).parse(row.approval_id),
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    taskId: tasksTaskIdSchema.parse(row.task_id),
    operationClass: tasksOperationClassSchema.parse(row.operation_class),
    contentRevision: tasksContentRevisionSchema.parse(row.content_revision),
    provenance: parseJson<JsonValue>(row.provenance_json),
    createdAt: isoTimestampSchema.parse(row.created_at),
  };
}

function tasksDependencyFromRow(row: TasksDependencyRow): TasksDependencyEdge {
  return {
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    taskId: tasksTaskIdSchema.parse(row.task_id),
    dependsOnTaskId: tasksTaskIdSchema.parse(row.depends_on_task_id),
    provenance: parseJson<JsonValue>(row.provenance_json),
    createdAt: isoTimestampSchema.parse(row.created_at),
  };
}

function tasksBlockerFromRow(row: TasksBlockerRow): TasksBlockerRecord {
  return {
    blockerId: z.string().trim().min(1).parse(row.blocker_id),
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    taskId: tasksTaskIdSchema.parse(row.task_id),
    kind: tasksBlockerKindSchema.parse(row.kind),
    state: tasksBlockerStateSchema.parse(row.state),
    questionText: z.string().trim().min(1).parse(row.question_text),
    answerText: row.answer_text,
    provenance: parseJson<JsonValue>(row.provenance_json),
    createdAt: isoTimestampSchema.parse(row.created_at),
    updatedAt: isoTimestampSchema.parse(row.updated_at),
    answeredAt: row.answered_at === null ? null : isoTimestampSchema.parse(row.answered_at),
    resolvedAt: row.resolved_at === null ? null : isoTimestampSchema.parse(row.resolved_at),
  };
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

function assertGlobalCapacity(db: SqliteDatabase, repositoryKey: RepositoryKey, limit: number, excludingRunId?: string): void {
  const parsedRepositoryKey = repositoryKeySchema.parse(repositoryKey);
  const parsedLimit = z.number().int().positive().parse(limit);
  const active = db
    .prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count
        FROM operational_runs
        WHERE repository_key = ?
          AND status IN ('pending', 'started', 'cancel-requested', 'reconciliation-required')
          AND (? IS NULL OR run_id <> ?)`,
    )
    .get(parsedRepositoryKey, excludingRunId ?? null, excludingRunId ?? null);
  if ((active?.count ?? 0) >= parsedLimit) throw new GlobalConcurrencyLimitError(parsedLimit);
}

function updateRunTaskId(db: SqliteDatabase, runId: string, taskId: string): void {
  const parsedRunId = z.string().trim().min(1).parse(runId);
  const parsedTaskId = z.string().trim().min(1).parse(taskId);
  const result = db
    .prepare(`UPDATE operational_runs SET task_id = ? WHERE run_id = ? AND status = 'pending'`)
    .run(parsedTaskId, parsedRunId);
  if (result.changes !== 1) {
    throw new Error(`cannot attach task '${parsedTaskId}' to pending run '${parsedRunId}'`);
  }
}

function updateRunDispatch(db: SqliteDatabase, input: RunDispatchUpdate): void {
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const status = dispatchedRunStatusSchema.parse(input.status);
  const repositoryRevision = repositoryRevisionSchema.parse(input.repositoryRevision);
  const row = db
    .prepare<unknown[], RunRow>(
      `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
              provider_id, worker_thread_id, project_id, environment_id,
              queue_item_ids_json, repository_revision_json, canonical_records_json, task_id
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

  deleteStopIntentForRun(db, input.runId);

  const summary = operationalRunSummarySchema.parse({
    ...currentSummary,
    status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    providerId: input.providerId,
    workerThreadId: input.workerThreadId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    taskId: input.taskId === undefined ? currentSummary.taskId : input.taskId,
    repositoryRevision,
    canonicalRecords,
  });
  db.prepare(
    `UPDATE operational_runs
        SET status = ?, started_at = ?, finished_at = ?, provider_id = ?,
            worker_thread_id = ?, project_id = ?, environment_id = ?,
            repository_revision_json = ?, canonical_records_json = ?, task_id = ?
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
    summary.taskId ?? null,
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
       worker_thread_id, status, started_at, finished_at, task_id, tasks_live_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    parsed.taskId ?? null,
    parsed.tasksLiveStatus ?? null,
  );
}

function updateDispatchAttempt(db: SqliteDatabase, attempt: DispatchAttempt): void {
  const parsed = dispatchAttemptSchema.parse(attempt);
  assertRunRepository(db, parsed.runId, parsed.repositoryKey);
  deleteStopIntentForRun(db, parsed.runId);
  const result = db.prepare(
    `UPDATE dispatch_attempts
        SET run_id = ?, repository_key = ?, provider_id = ?, model = ?,
            reasoning_level = ?, worker_thread_id = ?, status = ?,
            started_at = ?, finished_at = ?, task_id = ?, tasks_live_status = ?
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
    parsed.taskId ?? null,
    parsed.tasksLiveStatus ?? null,
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
  deleteStopIntentForRun(db, parsed.runId);
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

function insertStopIntent(db: SqliteDatabase, input: StopIntent): void {
  const token = z.string().trim().min(1).parse(input.token);
  const runId = z.string().trim().min(1).parse(input.runId);
  const attemptId = z.string().trim().min(1).parse(input.attemptId);
  const leaseId = z.string().trim().min(1).parse(input.leaseId);
  const repositoryKey = repositoryKeySchema.parse(input.repositoryKey);
  const workerThreadId = z.string().trim().min(1).parse(input.workerThreadId);
  const createdAt = isoTimestampSchema.parse(input.createdAt);
  assertRunRepository(db, runId, repositoryKey);
  db.prepare(
    `INSERT INTO stop_intents (
       token, run_id, attempt_id, lease_id, repository_key, worker_thread_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, runId, attemptId, leaseId, repositoryKey, workerThreadId, createdAt);
}

function deleteStopIntent(db: SqliteDatabase, token: string): void {
  db.prepare(`DELETE FROM stop_intents WHERE token = ?`).run(z.string().trim().min(1).parse(token));
}

function deleteStopIntentForRun(db: SqliteDatabase, runId: string): void {
  db.prepare(`DELETE FROM stop_intents WHERE run_id = ?`).run(z.string().trim().min(1).parse(runId));
}

function resetReconciliation(db: SqliteDatabase, runId: string): void {
  const parsedRunId = z.string().trim().min(1).parse(runId);
  db.prepare(`DELETE FROM run_reconciliation_metadata WHERE run_id = ?`).run(parsedRunId);
}

function recordReconciliation(db: SqliteDatabase, input: ReconciliationObservation): ReconciliationMetadata {
  const runId = z.string().trim().min(1).parse(input.runId);
  const firstDetectedAt = isoTimestampSchema.parse(input.firstDetectedAt);
  const deadlineAt = isoTimestampSchema.parse(input.deadlineAt);
  const reasonCode = z.string().trim().min(1).max(128).parse(input.reasonCode);
  const rawObservation = input.rawObservation === undefined || input.rawObservation === null
    ? null
    : z.string().max(512).parse(input.rawObservation);
  assertRunExists(db, runId);
  db.prepare(
    `INSERT INTO run_reconciliation_metadata (
       run_id, first_detected_at, deadline_at, reason_code, raw_observation,
       detection_count, resolved_at, resolution
     ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL)
     ON CONFLICT(run_id) DO UPDATE SET
       reason_code = CASE
         WHEN run_reconciliation_metadata.resolved_at IS NULL
           AND excluded.reason_code LIKE 'dead-start:%'
           AND run_reconciliation_metadata.reason_code NOT LIKE 'dead-start:%'
           THEN excluded.reason_code
         ELSE run_reconciliation_metadata.reason_code
       END,
       raw_observation = CASE
         WHEN excluded.raw_observation IS NULL THEN run_reconciliation_metadata.raw_observation
         ELSE excluded.raw_observation
       END,
       detection_count = CASE
         WHEN run_reconciliation_metadata.resolved_at IS NULL
           THEN run_reconciliation_metadata.detection_count + 1
         ELSE run_reconciliation_metadata.detection_count
       END`,
  ).run(runId, firstDetectedAt, deadlineAt, reasonCode, rawObservation);
  const row = db
    .prepare<unknown[], ReconciliationRow>(
      `SELECT run_id, first_detected_at, deadline_at, reason_code,
              raw_observation, detection_count, resolved_at, resolution,
              resolution_reason
         FROM run_reconciliation_metadata
        WHERE run_id = ?`,
    )
    .get(runId);
  if (row === undefined) throw new Error(`cannot read reconciliation metadata for run: ${runId}`);
  return reconciliationFromRow(row);
}

function resolveReconciliation(db: SqliteDatabase, input: ReconciliationResolutionUpdate): ReconciliationMetadata | null {
  const runId = z.string().trim().min(1).parse(input.runId);
  const resolvedAt = isoTimestampSchema.parse(input.resolvedAt);
  const resolution = z.enum(["completed", "blocked", "failed-safe", "no-op"]).parse(input.resolution);
  const reasonCode = z.string().trim().min(1).max(128).parse(input.reasonCode);
  const existing = db
    .prepare<unknown[], ReconciliationRow>(
      `SELECT run_id, first_detected_at, deadline_at, reason_code,
              raw_observation, detection_count, resolved_at, resolution,
              resolution_reason
         FROM run_reconciliation_metadata
        WHERE run_id = ?`,
    )
    .get(runId);
  if (existing === undefined) return null;
  if (existing.resolved_at !== null) {
    if (existing.resolution !== resolution) {
      throw new Error(`reconciliation for run '${runId}' was already resolved as ${existing.resolution}`);
    }
    return reconciliationFromRow(existing);
  }
  db.prepare(
    `UPDATE run_reconciliation_metadata
        SET resolved_at = ?, resolution = ?, resolution_reason = ?
      WHERE run_id = ? AND resolved_at IS NULL`,
  ).run(resolvedAt, resolution, reasonCode, runId);
  const row = db
    .prepare<unknown[], ReconciliationRow>(
      `SELECT run_id, first_detected_at, deadline_at, reason_code,
              raw_observation, detection_count, resolved_at, resolution,
              resolution_reason
         FROM run_reconciliation_metadata
        WHERE run_id = ?`,
    )
    .get(runId);
  return row === undefined ? null : reconciliationFromRow(row);
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

function assertRunExists(db: SqliteDatabase, runId: string): void {
  const row = db.prepare<unknown[], { run_id: string }>(`SELECT run_id FROM operational_runs WHERE run_id = ?`).get(runId);
  if (row === undefined) throw new Error(`cannot reference missing operational run: ${runId}`);
}

function readReconciliation(db: SqliteDatabase, runId: string): ReconciliationMetadata | null {
  const row = db
    .prepare<unknown[], ReconciliationRow>(
      `SELECT run_id, first_detected_at, deadline_at, reason_code,
              raw_observation, detection_count, resolved_at, resolution,
              resolution_reason
         FROM run_reconciliation_metadata
        WHERE run_id = ?`,
    )
    .get(z.string().trim().min(1).parse(runId));
  return row === undefined ? null : reconciliationFromRow(row);
}

function readStopIntent(db: SqliteDatabase, runId: string): StopIntent | null {
  const row = db
    .prepare<unknown[], StopIntentRow>(
      `SELECT token, run_id, attempt_id, lease_id, repository_key,
              worker_thread_id, created_at
         FROM stop_intents
        WHERE run_id = ?`,
    )
    .get(z.string().trim().min(1).parse(runId));
  if (row === undefined) return null;
  return {
    token: z.string().trim().min(1).parse(row.token),
    runId: z.string().trim().min(1).parse(row.run_id),
    attemptId: z.string().trim().min(1).parse(row.attempt_id),
    leaseId: z.string().trim().min(1).parse(row.lease_id),
    repositoryKey: repositoryKeySchema.parse(row.repository_key),
    workerThreadId: z.string().trim().min(1).parse(row.worker_thread_id),
    createdAt: isoTimestampSchema.parse(row.created_at),
  };
}

function readRunStatus(db: SqliteDatabase, runId: string): OperationalRunStatus | null {
  const row = db.prepare<unknown[], { status: string }>(`SELECT status FROM operational_runs WHERE run_id = ?`).get(runId);
  return row === undefined ? null : operationalRunStatusSchema.parse(row.status);
}

function readRunSummary(db: SqliteDatabase, runId: string): OperationalRunSummary | null {
  const row = db
    .prepare<unknown[], RunRow>(
      `SELECT run_id, repository_key, requested_at, status, started_at, finished_at,
              provider_id, worker_thread_id, project_id, environment_id,
              queue_item_ids_json, repository_revision_json, canonical_records_json, task_id
         FROM operational_runs
        WHERE run_id = ?`,
    )
    .get(z.string().trim().min(1).parse(runId));
  return row === undefined ? null : runSummaryFromRow(row);
}

function readActiveAttempt(db: SqliteDatabase, runId: string): DispatchAttempt | null {
  const row = db
    .prepare<unknown[], AttemptRow>(
      `SELECT attempt_id, run_id, repository_key, provider_id, model,
              reasoning_level, worker_thread_id, status, started_at, finished_at,
              task_id, tasks_live_status
         FROM dispatch_attempts
        WHERE run_id = ?
          AND status IN ('pending', 'started', 'cancel-requested', 'reconciliation-required')
        ORDER BY rowid DESC
        LIMIT 1`,
    )
    .get(z.string().trim().min(1).parse(runId));
  return row === undefined ? null : attemptFromRow(row);
}

function hasDispatchAttemptStatus(db: SqliteDatabase, runId: string, status: DispatchAttempt["status"]): boolean {
  const parsedRunId = z.string().trim().min(1).parse(runId);
  const parsedStatus = dispatchAttemptSchema.shape.status.parse(status);
  const row = db
    .prepare<unknown[], { found: number }>(
      `SELECT 1 AS found
         FROM dispatch_attempts
        WHERE run_id = ? AND status = ?
        LIMIT 1`,
    )
    .get(parsedRunId, parsedStatus);
  return row !== undefined;
}

function readDispatchAttempt(db: SqliteDatabase, attemptId: string): DispatchAttempt | null {
  const row = db
    .prepare<unknown[], AttemptRow>(
      `SELECT attempt_id, run_id, repository_key, provider_id, model,
              reasoning_level, worker_thread_id, status, started_at, finished_at,
              task_id, tasks_live_status
         FROM dispatch_attempts
        WHERE attempt_id = ?`,
    )
    .get(z.string().trim().min(1).parse(attemptId));
  return row === undefined ? null : attemptFromRow(row);
}

function readLeaseForRun(db: SqliteDatabase, runId: string): OwnershipLease | null {
  const row = db
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

function readCurrentOwnership(db: SqliteDatabase, repositoryKey: RepositoryKey): OwnershipLease | null {
  const parsedRepositoryKey = repositoryKeySchema.parse(repositoryKey);
  const row = db
    .prepare<unknown[], OwnershipRow>(
      `SELECT lease_id, repository_key, run_id, queue_item_ids_json, worker_thread_id,
              authorization_provenance_json, acquired_at, expires_at, status
         FROM ownership_leases
        WHERE repository_key = ? AND status <> 'released'
        ORDER BY acquired_at DESC
        LIMIT 1`,
    )
    .get(parsedRepositoryKey);
  return row === undefined ? null : ownershipFromRow(row);
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
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
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
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.tasks_live_status === null ? {} : { tasksLiveStatus: row.tasks_live_status }),
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

function reconciliationFromRow(row: ReconciliationRow): ReconciliationMetadata {
  return {
    runId: z.string().trim().min(1).parse(row.run_id),
    firstDetectedAt: isoTimestampSchema.parse(row.first_detected_at),
    deadlineAt: isoTimestampSchema.parse(row.deadline_at),
    reasonCode: z.string().trim().min(1).parse(row.reason_code),
    rawObservation: row.raw_observation,
    detectionCount: z.number().int().positive().parse(row.detection_count),
    resolvedAt: row.resolved_at === null ? null : isoTimestampSchema.parse(row.resolved_at),
    resolution: row.resolution === null
      ? null
      : z.enum(["completed", "blocked", "failed-safe", "no-op"]).parse(row.resolution),
    resolutionReason: row.resolution_reason === null ? null : z.string().trim().min(1).parse(row.resolution_reason),
  };
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
