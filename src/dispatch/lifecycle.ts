import type {
  CanonicalFileRecordLink,
  OperationalRunDetail,
  OperationalRunSummary,
  OperationalRunStatus,
  RepositoryKey,
  RepositoryRevision,
} from "../contracts.js";
import { sameRevision } from "../actions/results.js";
import { errorMessage } from "../errors.js";
import { ProtocolError } from "../protocol/errors.js";
import { digestText, listFilesPage, readTextFile } from "../protocol/files.js";
import { lastNonEmptyLine, parseCurrentState, parseRunRecord } from "../protocol/markdown.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";
import type { ImmutableRunRecord } from "../protocol/types.js";
import type { OperationalTransaction } from "../storage/index.js";
import {
  boundedDiagnostic,
  PENDING_RUN_GRACE_MS,
  PROVIDER_LIMIT_SECONDS,
  QUARANTINE_ABANDONMENT_GRACE_MS,
  RECONCILIATION_GRACE_MS,
  dispatcherNowSeconds,
  nightKeyAt,
  nightState,
  runDispatchUpdate,
  sameJson,
  withWorkerOperation,
  type DispatchContext,
} from "./types.js";

type ThreadStatusValue = "active" | "error" | "idle" | "pending" | "starting" | "stopping";
type ForemanState = "success" | "blocked" | "failed-safe" | "no-op";
const ACTIVE_ATTEMPT_STATUSES = ["pending", "started", "cancel-requested", "reconciliation-required"] as const;
const TERMINAL_RUN_STATUSES = ["completed", "blocked", "failed-safe", "no-op"] as const;
const LOOKUP_DAY_MS = 24 * 60 * 60 * 1000;

function outcomeToStatus(state: ForemanState): "completed" | "blocked" | "failed-safe" | "no-op" {
  return state === "success" ? "completed" : state;
}

function isTerminalThreadStatus(status: ThreadStatusValue): boolean {
  return status === "idle" || status === "error";
}

function activeAttemptId(detail: OperationalRunDetail): string | null {
  return [...detail.attempts].reverse().find((attempt) =>
    attempt.runId === detail.summary.runId && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number]),
  )?.attemptId ?? null;
}

function newestActiveAttemptStartMs(detail: OperationalRunDetail): number {
  const starts = detail.attempts
    .filter((attempt) => attempt.runId === detail.summary.runId && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number]))
    .map((attempt) => attempt.startedAt === null ? Number.NaN : Date.parse(attempt.startedAt))
    .filter((value) => !Number.isNaN(value));
  const runStart = detail.summary.startedAt === null ? Number.NaN : Date.parse(detail.summary.startedAt);
  return Math.max(...starts, Number.isNaN(runStart) ? 0 : runStart);
}

function secondPrecision(timestampMs: number): number {
  return Math.floor(timestampMs / 1000) * 1000;
}

interface CurrentStateRead {
  readonly state: ForemanState | null;
  readonly lastRunAt: string | null;
  readonly modifiedAtMs: number | null;
  readonly sha256: string | null;
  readonly fresh: boolean;
  readonly kind: "valid" | "retryable" | "invalid";
  readonly rawObservation: string | null;
  readonly reason: string | null;
}

async function readCurrentState(
  ctx: DispatchContext,
  repositoryKey: RepositoryKey,
  startedAtMs: number,
): Promise<CurrentStateRead> {
  const entry = ctx.repositoryLookup(repositoryKey);
  if (!entry) {
    return { state: null, lastRunAt: null, modifiedAtMs: null, sha256: null, fresh: false, kind: "retryable", rawObservation: null, reason: "repository is not configured" };
  }
  let content = "";
  try {
    const file = await readTextFile(
      { read: (args) => ctx.sdk.files.read(args), listPaths: (args) => ctx.sdk.files.listPaths(args) },
      {
        hostId: entry.configuration.connectedHostId,
        rootPath: entry.configuration.checkoutPath,
        relativePath: PROTOCOL_PATHS.current,
        repositoryKey,
      },
    );
    content = file.content;
    if (file.modifiedAtMs === undefined) {
      return {
        state: null,
        lastRunAt: null,
        modifiedAtMs: null,
        sha256: file.sha256,
        fresh: false,
        kind: "retryable",
        rawObservation: lastNonEmptyLine(content),
        reason: `${PROTOCOL_PATHS.current} mtime is unavailable`,
      };
    }
    const parsed = parseCurrentState(file.content, PROTOCOL_PATHS.current);
    const fresh = startedAtMs > 0
      && secondPrecision(file.modifiedAtMs) > secondPrecision(startedAtMs);
    return {
      state: parsed.state,
      lastRunAt: parsed.lastRunAt,
      modifiedAtMs: file.modifiedAtMs ?? null,
      sha256: file.sha256,
      fresh,
      kind: fresh ? "valid" : "invalid",
      rawObservation: lastNonEmptyLine(content),
      reason: fresh ? null : `${PROTOCOL_PATHS.current} is not newer than the run start at filesystem-second precision`,
    };
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "file-not-found") {
      return { state: null, lastRunAt: null, modifiedAtMs: null, sha256: null, fresh: false, kind: "retryable", rawObservation: null, reason: `${PROTOCOL_PATHS.current} is not present` };
    }
    return {
      state: null,
      lastRunAt: null,
      modifiedAtMs: null,
      sha256: null,
      fresh: false,
      kind: error instanceof ProtocolError && error.code === "malformed-protocol" ? "invalid" : "retryable",
      rawObservation: lastNonEmptyLine(content) ?? errorMessage(error),
      reason: errorMessage(error),
    };
  }
}

interface RunEvidence {
  readonly revision: RepositoryRevision;
  readonly canonicalRecords: CanonicalFileRecordLink[];
  readonly immutableRecords: readonly ImmutableRunRecord[];
  readonly invalidImmutablePaths: readonly string[];
}

async function postRunRecords(
  ctx: DispatchContext,
  run: OperationalRunSummary,
  threadId: string,
  current: CurrentStateRead,
  attemptStartMs: number,
): Promise<RunEvidence> {
  const entry = ctx.repositoryLookup(run.repositoryKey);
  const records: CanonicalFileRecordLink[] = [...run.canonicalRecords];
  if (!entry) throw new Error("repository is not configured");
  const files = {
    read: (args: Parameters<DispatchContext["sdk"]["files"]["read"]>[0]) => ctx.sdk.files.read(args),
    listPaths: (args: Parameters<DispatchContext["sdk"]["files"]["listPaths"]>[0]) => ctx.sdk.files.listPaths(args),
  };
  const timestamps = [
    current.lastRunAt === null ? null : Date.parse(current.lastRunAt),
    current.modifiedAtMs,
    attemptStartMs > 0 ? attemptStartMs : null,
  ].filter((timestamp): timestamp is number => timestamp !== null && !Number.isNaN(timestamp));
  const relativePaths = new Set<string>();
  const strictPaths = new Set<string>();
  const lookupTimestamps = [...new Set(timestamps.flatMap((timestampMs) => [
    timestampMs - LOOKUP_DAY_MS,
    timestampMs,
    timestampMs + LOOKUP_DAY_MS,
  ]))];
  for (const timestampMs of lookupTimestamps) {
    for (const stamp of timestampVariants(timestampMs).stamps) {
      const relativePath = `${PROTOCOL_PATHS.runs}/${stamp}-${threadId}.md`;
      relativePaths.add(relativePath);
      strictPaths.add(relativePath);
    }
    for (const prefix of timestampVariants(timestampMs).prefixes) {
      try {
        const page = await listFilesPage(files, {
          hostId: entry.configuration.connectedHostId,
          rootPath: entry.configuration.checkoutPath,
          relativePath: PROTOCOL_PATHS.runs,
          repositoryKey: run.repositoryKey,
          query: prefix,
          limit: 256,
          allowTruncated: true,
        });
        if (page.truncated) {
          throw new ProtocolError(
            "malformed-protocol",
            `The targeted immutable run-record search for '${prefix}' was truncated`,
            { path: PROTOCOL_PATHS.runs, repositoryKey: run.repositoryKey },
          );
        }
        for (const relativePath of page.paths) {
          relativePaths.add(relativePath);
          strictPaths.add(relativePath);
        }
      } catch (error) {
        if (!(error instanceof ProtocolError && error.code === "file-not-found")) throw error;
      }
    }
  }
  for (const query of [threadId]) {
    try {
      const page = await listFilesPage(files, {
        hostId: entry.configuration.connectedHostId,
        rootPath: entry.configuration.checkoutPath,
        relativePath: PROTOCOL_PATHS.runs,
        repositoryKey: run.repositoryKey,
        query,
        limit: 256,
        allowTruncated: true,
      });
      if (page.truncated) {
        throw new ProtocolError(
          "malformed-protocol",
          `The worker-targeted immutable run-record search for '${threadId}' was truncated`,
          { path: PROTOCOL_PATHS.runs, repositoryKey: run.repositoryKey },
        );
      }
      for (const relativePath of page.paths) {
        relativePaths.add(relativePath);
        strictPaths.add(relativePath);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError && error.code === "file-not-found")) throw error;
    }
  }
  const immutableRecords: ImmutableRunRecord[] = [];
  const invalidImmutablePaths: string[] = [];
  for (const relativePath of [...relativePaths].filter((path) => path.endsWith(".md") && !path.endsWith("/.gitkeep"))) {
    const identity = recordIdentity(relativePath);
    if (identity === null && !isMalformedCandidatePath(relativePath, threadId)) continue;
    try {
      const file = await readTextFile(files, {
        hostId: entry.configuration.connectedHostId,
        rootPath: entry.configuration.checkoutPath,
        relativePath,
        repositoryKey: run.repositoryKey,
      });
      immutableRecords.push(parseRunRecord(file.content, relativePath, file.sha256));
      if (strictPaths.has(relativePath) && identity === null) invalidImmutablePaths.push(relativePath);
    } catch (error) {
      if (!(error instanceof ProtocolError && error.code === "file-not-found")) throw error;
    }
  }
  const postRunRevision = ctx.protocolReader.loadRevision !== undefined
    ? await ctx.protocolReader.loadRevision(entry.configuration)
    : (await ctx.protocolReader.loadSnapshot(entry.configuration)).revision;
  const revision = refreshedEvidenceRevision({
    ...postRunRevision,
    // Historical run records are immutable and were already part of the
    // pre-run snapshot. Keep those digests while replacing mutable files and
    // the git commit with the post-run observation from one read.
    fileDigests: { ...run.repositoryRevision.fileDigests, ...postRunRevision.fileDigests },
  }, current.sha256, immutableRecords);
  if (!records.some((record) => record.recordType === "current-run")) {
    records.push({
      relativePath: PROTOCOL_PATHS.current,
      recordType: "current-run",
      recordId: run.runId,
      repositoryRevision: revision,
    });
  }
  return { revision, canonicalRecords: records, immutableRecords, invalidImmutablePaths };
}

function timestampVariants(timestampMs: number): { readonly stamps: readonly string[]; readonly prefixes: readonly string[] } {
  const date = new Date(timestampMs);
  const iso = date.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 19);
  const fraction = iso.slice(19, 23);
  const compact = `${datePart.replace(/-/gu, "")}T${timePart.replace(/:/gu, "")}`;
  const dashed = `${datePart}T${timePart}`;
  const dashedNoColon = `${datePart}T${timePart.replace(/:/gu, "")}`;
  const legacy = `${datePart}-${timePart.replace(/:/gu, "")}`;
  return {
    stamps: [
      `${compact}Z`, `${compact}${fraction}Z`,
      `${dashed}Z`, `${dashed}${fraction}Z`,
      `${dashedNoColon}Z`, `${dashedNoColon}${fraction}Z`,
      legacy, `${legacy}Z`, `${legacy}${fraction}`,
    ],
    prefixes: [compact, dashed, dashedNoColon, legacy, datePart.replace(/-/gu, ""), datePart],
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRunGeneration(actual: OperationalRunSummary | null, expected: OperationalRunSummary): boolean {
  return actual !== null
    && actual.runId === expected.runId
    && actual.repositoryKey === expected.repositoryKey
    && actual.requestedAt === expected.requestedAt
    && actual.startedAt === expected.startedAt
    && actual.finishedAt === expected.finishedAt
    && actual.providerId === expected.providerId
    && actual.workerThreadId === expected.workerThreadId
    && actual.projectId === expected.projectId
    && actual.environmentId === expected.environmentId
    && sameStringArray(actual.queueItemIds, expected.queueItemIds)
    && sameRevision(actual.repositoryRevision, expected.repositoryRevision)
    && sameJson(actual.canonicalRecords, expected.canonicalRecords);
}

function sameAttemptGeneration(
  actual: NonNullable<ReturnType<OperationalTransaction["getActiveAttempt"]>> | null,
  expected: NonNullable<ReturnType<OperationalTransaction["getActiveAttempt"]>> | undefined,
): boolean {
  return actual !== null
    && expected !== undefined
    && actual.attemptId === expected.attemptId
    && actual.runId === expected.runId
    && actual.repositoryKey === expected.repositoryKey
    && actual.providerId === expected.providerId
    && actual.model === expected.model
    && actual.reasoningLevel === expected.reasoningLevel
    && actual.workerThreadId === expected.workerThreadId
    && actual.status === expected.status
    && actual.startedAt === expected.startedAt
    && actual.finishedAt === expected.finishedAt;
}

function sameLeaseGeneration(
  actual: NonNullable<ReturnType<OperationalTransaction["getLeaseForRun"]>> | null,
  expected: NonNullable<ReturnType<OperationalTransaction["getLeaseForRun"]>> | null,
): boolean {
  return actual !== null
    && expected !== null
    && actual.leaseId === expected.leaseId
    && actual.repositoryKey === expected.repositoryKey
    && actual.runId === expected.runId
    && sameStringArray(actual.queueItemIds, expected.queueItemIds)
    && actual.workerThreadId === expected.workerThreadId
    && sameStringArray(actual.authorizationProvenance, expected.authorizationProvenance)
    && actual.acquiredAt === expected.acquiredAt
    && actual.expiresAt === expected.expiresAt
    && actual.status === expected.status;
}

function updateLeaseIfExact(
  ctx: DispatchContext,
  expected: NonNullable<ReturnType<DispatchContext["store"]["getCurrentOwnership"]>>,
  status: "released" | "reconciliation-required",
  expectedRun?: OperationalRunSummary,
): void {
  ctx.store.withTransaction((transaction) => {
    const current = transaction.getLeaseForRun(expected.runId);
    if (current === null || !sameLeaseGeneration(current, expected)) return;
    if (expectedRun !== undefined) {
      const currentRun = transaction.getRunSummary(expectedRun.runId);
      if (currentRun === null
        || !sameRunGeneration(currentRun, expectedRun)
        || !TERMINAL_RUN_STATUSES.includes(currentRun.status as typeof TERMINAL_RUN_STATUSES[number])) return;
    }
    transaction.updateOwnershipLease({ ...current, status });
  });
}

function refreshedEvidenceRevision(
  baseRevision: RepositoryRevision,
  currentSha256: string | null,
  immutableRecords: readonly ImmutableRunRecord[],
): RepositoryRevision {
  const fileDigests = { ...baseRevision.fileDigests };
  if (currentSha256 !== null) fileDigests[PROTOCOL_PATHS.current] = currentSha256;
  for (const record of immutableRecords) fileDigests[record.relativePath] = record.sha256;
  const digestInput = Object.entries(fileDigests)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, sha256]) => `${path}\0${sha256}`)
    .join("\n");
  return {
    gitCommit: baseRevision.gitCommit,
    protocolDigest: digestText(digestInput),
    fileDigests,
  };
}

function isMalformedCandidatePath(relativePath: string, threadId: string): boolean {
  const name = relativePath.slice(`${PROTOCOL_PATHS.runs}/`.length);
  if (recordIdentity(relativePath) !== null) return false;
  if (/^(?:\d{8}T\d{6}|\d{4}-\d{2}-\d{2}T\d{2}:?\d{2}:?\d{2}|\d{4}-\d{2}-\d{2}-\d{6})/u.test(name)) {
    return true;
  }
  const dateOnly = name.match(/^(\d{4}-\d{2}-\d{2})(?:-(.+))?\.md$/u);
  if (dateOnly) return dateOnly[2] === undefined || dateOnly[2] === threadId;
  return true;
}

function finalizeRun(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  input: {
    status: "completed" | "blocked" | "failed-safe" | "no-op";
    providerId: string;
    workerThreadId: string;
    projectId: string;
    environmentId: string | null;
    revision: RepositoryRevision;
    canonicalRecords: CanonicalFileRecordLink[];
    finishedAt: string;
    lastState: string;
    bumpFailed: boolean;
    bumpNoop: boolean;
    attemptId: string | null;
    releaseLease: boolean;
    expectedRunStatus?: OperationalRunStatus;
    expectedAttemptStatus?: string;
    expectedLeaseId?: string | null;
    expectedLeaseStatus?: string;
    leaseWorkerThreadId?: string | null;
    limitProviderSeconds?: number;
  },
): boolean {
  const run = detail.summary;
  const finalReason = boundedDiagnostic(input.lastState, 128);
  const expectedAttempt = input.attemptId === null
    ? undefined
    : detail.attempts.find((attempt) => attempt.attemptId === input.attemptId);
  const expectedLease = detail.lease;
  let applied = false;
  ctx.store.withTransaction((transaction) => {
    const currentRun = transaction.getRunSummary(run.runId);
    if (currentRun === null) throw new Error(`cannot finalize missing run '${run.runId}'`);
    const currentStatus = currentRun.status;
    if (currentStatus === input.status) return;
    if (["completed", "blocked", "failed-safe", "no-op"].includes(currentStatus)) return;
    if (!sameRunGeneration(currentRun, run)
      || (input.expectedRunStatus !== undefined && currentStatus !== input.expectedRunStatus)) return;
    const currentAttempt = transaction.getActiveAttempt(run.runId);
    if (expectedAttempt === undefined) {
      if (currentAttempt !== null) return;
    } else {
      if (!sameAttemptGeneration(currentAttempt, expectedAttempt)) return;
      if (currentAttempt === null) return;
    }
    if (input.expectedAttemptStatus !== undefined && currentAttempt?.status !== input.expectedAttemptStatus) return;
    const currentLease = transaction.getLeaseForRun(run.runId);
    if (input.expectedLeaseId !== undefined
      && (currentLease?.leaseId ?? null) !== input.expectedLeaseId) return;
    if (input.expectedLeaseStatus !== undefined && currentLease?.status !== input.expectedLeaseStatus) return;
    if (input.expectedLeaseId !== undefined && input.expectedLeaseId !== null && !sameLeaseGeneration(currentLease, expectedLease)) return;
    if (run.workerThreadId !== null && input.workerThreadId !== run.workerThreadId) return;
    if (currentAttempt !== null && currentAttempt.workerThreadId !== null && currentAttempt.workerThreadId !== input.workerThreadId) return;
    const targetLeaseWorker = input.leaseWorkerThreadId === undefined ? input.workerThreadId : input.leaseWorkerThreadId;
    if (currentLease !== null && currentLease.workerThreadId !== targetLeaseWorker) return;
    const failedCountAlreadyIncludesRun = transaction.hasDispatchAttemptStatus(run.runId, "failed-safe");
    transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
      status: input.status,
      finishedAt: input.finishedAt,
      providerId: input.providerId,
      workerThreadId: input.workerThreadId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      repositoryRevision: input.revision,
      canonicalRecords: input.canonicalRecords,
    }));
    if (currentAttempt && ["started", "cancel-requested", "pending", "reconciliation-required"].includes(currentAttempt.status)) {
      transaction.updateDispatchAttempt({ ...currentAttempt, status: input.status, finishedAt: input.finishedAt });
    }
    const lease = currentLease;
    if (lease
      && lease.runId === run.runId
      && lease.repositoryKey === run.repositoryKey
      && lease.status !== "released") {
      transaction.updateOwnershipLease({
        ...lease,
        workerThreadId: input.leaseWorkerThreadId === undefined ? input.workerThreadId : input.leaseWorkerThreadId,
        status: input.releaseLease ? "released" : "reconciliation-required",
      });
    }
    const state = nightState(
      ctx.store.getDispatcherState(run.repositoryKey),
      nightKeyAt(ctx.now(), ctx.settings.nightWindowEndHour),
    );
    const limits = { ...state.limits };
    if (input.limitProviderSeconds !== undefined) {
      limits[input.providerId] = dispatcherNowSeconds(ctx.now) + input.limitProviderSeconds;
    }
    transaction.saveDispatcherState({
      ...state,
      lastState: finalReason,
      failedCount: state.failedCount + (input.bumpFailed && !failedCountAlreadyIncludesRun ? 1 : 0),
      noopCount: state.noopCount + (input.bumpNoop ? 1 : 0),
      limits,
    });
    transaction.resolveReconciliation({
      runId: run.runId,
      resolvedAt: input.finishedAt,
      resolution: input.status,
      reasonCode: finalReason,
    });
    applied = true;
  });
  return applied;
}

function markRunForReconciliation(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  reason: string,
  rawObservation: string | null = null,
  expectedAttemptId = activeAttemptId(detail),
): void {
  ctx.log?.(`run ${detail.summary.runId}: ${reason}`);
  const run = detail.summary;
  const entry = ctx.repositoryLookup(run.repositoryKey);
  const detectedAt = ctx.now();
  const detectedAtIso = detectedAt.toISOString();
  const deadlineAt = new Date(detectedAt.getTime() + RECONCILIATION_GRACE_MS).toISOString();
  const expectedAttempt = expectedAttemptId === null
    ? undefined
    : detail.attempts.find((attempt) => attempt.attemptId === expectedAttemptId);
  const expectedLease = detail.lease ?? ctx.store.getLeaseForRun(run.runId);
  const orphanPending = run.status === "pending" && expectedAttemptId === null && expectedLease === null;
  const boundedReason = boundedDiagnostic(reason, 128);
  const boundedObservation = rawObservation === null ? null : boundedDiagnostic(rawObservation, 512);
  ctx.store.withTransaction((transaction) => {
    const currentRun = transaction.getRunSummary(run.runId);
    if (currentRun === null) throw new Error(`cannot reconcile missing run '${run.runId}'`);
    if (["completed", "blocked", "failed-safe", "no-op"].includes(currentRun.status)) return;
    if (!sameRunGeneration(currentRun, run) || currentRun.status !== run.status) return;
    const currentAttempt = transaction.getActiveAttempt(run.runId);
    if (orphanPending) {
      if (currentAttempt !== null || transaction.getLeaseForRun(run.runId) !== null) return;
    } else {
      if (!sameAttemptGeneration(currentAttempt, expectedAttempt)) return;
      if (currentAttempt === null) return;
    }
    const currentLease = transaction.getLeaseForRun(run.runId);
    if (expectedLease === null) {
      if (currentLease !== null) return;
    } else if (currentLease === null || !sameLeaseGeneration(currentLease, expectedLease)) return;
    transaction.recordReconciliation({
      runId: run.runId,
      firstDetectedAt: detectedAtIso,
      deadlineAt,
      reasonCode: boundedReason,
      rawObservation: boundedObservation,
    });
    transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
      status: "reconciliation-required",
      finishedAt: currentRun.finishedAt ?? detectedAtIso,
      projectId: currentRun.projectId ?? entry?.projectId ?? "unknown",
      environmentId: currentRun.environmentId ?? entry?.environmentId ?? null,
    }));
    if (currentAttempt && ["started", "cancel-requested", "pending"].includes(currentAttempt.status)) {
      transaction.updateDispatchAttempt({ ...currentAttempt, status: "reconciliation-required", finishedAt: currentAttempt.finishedAt ?? detectedAtIso });
    }
    if (currentLease && currentLease.status !== "released") {
      transaction.updateOwnershipLease({ ...currentLease, status: "reconciliation-required" });
    }
  });
}

interface CompletionValidation {
  readonly kind: "accepted" | "retryable" | "invalid";
  readonly reason: string;
  readonly rawObservation: string | null;
  readonly state?: ForemanState;
  readonly record?: ImmutableRunRecord;
}

interface RecordIdentity {
  readonly workerThreadId: string;
  readonly timestampMs: number;
  readonly hasFraction: boolean;
}

function recordIdentity(relativePath: string): RecordIdentity | null {
  const match = relativePath.match(/^plans\/factory\/runs\/(\d{8}T\d{6}(?:\.\d{1,9})?Z|\d{4}-\d{2}-\d{2}T\d{2}:?\d{2}:?\d{2}(?:\.\d{1,9})?Z|\d{4}-\d{2}-\d{2}-\d{6}(?:\.\d{1,9})?Z?)-(.+)\.md$/u);
  if (!match) return null;
  const stamp = match[1]!;
  const compact = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/u);
  const dashed = stamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(\.\d+)?Z$/u);
  const legacyDashed = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(\.\d+)?Z?$/u);
  const parts = compact ?? dashed ?? legacyDashed;
  const fraction = parts?.[7] === undefined ? ".000" : `${parts[7]}000`.slice(0, 4);
  const timestampMs = parts
    ? Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${fraction}Z`)
    : Number.NaN;
  return Number.isNaN(timestampMs)
    ? null
    : { workerThreadId: match[2]!, timestampMs, hasFraction: parts?.[7] !== undefined };
}

function evidenceIsFresh(identity: RecordIdentity, attemptStartMs: number): boolean {
  if (attemptStartMs <= 0) return true;
  if (identity.hasFraction) return identity.timestampMs >= attemptStartMs;
  // A second-precision filename cannot prove ordering within its filesystem
  // second. Require the next full second so pre-attempt evidence cannot pass.
  return secondPrecision(identity.timestampMs) > secondPrecision(attemptStartMs);
}

function validateCompletion(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  threadId: string,
  current: CurrentStateRead,
  evidence: RunEvidence,
): CompletionValidation {
  const run = detail.summary;
  const rawObservation = current.rawObservation ?? evidence.immutableRecords[0]?.content.trim().slice(-512) ?? null;
  const activeAttempt = detail.attempts.find((attempt) =>
    attempt.runId === run.runId
      && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number])
      && (attempt.workerThreadId === null || attempt.workerThreadId === threadId),
  );
  if (!activeAttempt) return { kind: "invalid", reason: "no active attempt is correlated to this run", rawObservation };

  const lease = ctx.store.getLeaseForRun(run.runId);
  const currentLease = ctx.store.getCurrentOwnership(run.repositoryKey);
  if (!lease || lease.repositoryKey !== run.repositoryKey || lease.runId !== run.runId
    || !currentLease || currentLease.leaseId !== lease.leaseId || currentLease.runId !== run.runId) {
    return { kind: "invalid", reason: "the current lease is not correlated to this run", rawObservation };
  }
  if (current.kind === "retryable") return { kind: "retryable", reason: current.reason ?? "terminal state is not readable", rawObservation };
  if (current.kind === "invalid" || current.state === null || !current.fresh) {
    return { kind: "invalid", reason: current.reason ?? "terminal state is stale or malformed", rawObservation };
  }
  if (run.workerThreadId !== threadId) {
    return { kind: "invalid", reason: "observed terminal worker does not match the recorded run worker", rawObservation };
  }
  if (evidence.invalidImmutablePaths.length > 0) {
    return { kind: "invalid", reason: `immutable run record filename is malformed: ${evidence.invalidImmutablePaths[0]}`, rawObservation };
  }

  const startedAtMs = newestActiveAttemptStartMs(detail);
  const identifiedRecords = evidence.immutableRecords
    .map((record) => ({ record, identity: recordIdentity(record.relativePath) }))
    .filter((entry): entry is { readonly record: ImmutableRunRecord; readonly identity: RecordIdentity } =>
      entry.identity !== null)
    .sort((left, right) => right.identity.timestampMs - left.identity.timestampMs);
  const records = identifiedRecords
    .filter(({ identity }) => evidenceIsFresh(identity, startedAtMs));
  const candidateForeignRecord = identifiedRecords.find(({ identity }) =>
    identity.workerThreadId !== threadId
      && secondPrecision(identity.timestampMs) >= secondPrecision(startedAtMs),
  );
  if (current.state === "failed-safe" && candidateForeignRecord && !records.some(({ identity }) => identity.workerThreadId === threadId)) {
    return { kind: "invalid", reason: "immutable run record belongs to a different worker thread", rawObservation };
  }
  const latestTimestampMs = records[0]?.identity.timestampMs;
  const latestRecords = latestTimestampMs === undefined
    ? []
    : records.filter(({ identity }) => identity.timestampMs === latestTimestampMs);
  if (latestRecords.some(({ identity }) => identity.workerThreadId !== threadId)) {
    return { kind: "invalid", reason: "latest immutable run record belongs to a different worker thread", rawObservation };
  }
  const recordsForRun = records
    .filter(({ identity }) => identity.workerThreadId === threadId)
    .sort((left, right) => right.identity.timestampMs - left.identity.timestampMs);
  if (recordsForRun.length === 0 && records.length > 0) {
    return { kind: "invalid", reason: "immutable run record belongs to a different worker thread", rawObservation };
  }
  if (current.state === "failed-safe" && recordsForRun.length === 0) {
    const firstAttempt = detail.attempts.find((attempt) => attempt.runId === run.runId);
    if (firstAttempt?.attemptId !== activeAttempt.attemptId) {
      return { kind: "invalid", reason: "legacy failed-safe evidence predates the active retry generation", rawObservation };
    }
    return { kind: "accepted", reason: "failed-safe current state is correlated to the terminal worker", rawObservation, state: current.state };
  }
  const record = recordsForRun[0]?.record;
  if (!record) return { kind: "invalid", reason: "no immutable run record is attributable to this terminal outcome", rawObservation };
  const identity = recordIdentity(record.relativePath);
  if (!identity) return { kind: "invalid", reason: "immutable run record filename is not a supported UTC timestamp format", rawObservation };
  if (!evidenceIsFresh(identity, startedAtMs)) {
    return { kind: "invalid", reason: "immutable run record predates the run start", rawObservation };
  }
  try {
    const parsedRecord = parseCurrentState(record.content, record.relativePath);
    if (parsedRecord.state !== current.state || record.state !== current.state) {
      return { kind: "invalid", reason: "immutable run record and current state disagree", rawObservation };
    }
  } catch (error) {
    return { kind: "invalid", reason: errorMessage(error), rawObservation };
  }
  return { kind: "accepted", reason: "correlated terminal evidence accepted", rawObservation, state: current.state, record };
}

function finalizationInput(
  run: OperationalRunSummary,
  revision: RepositoryRevision,
  canonicalRecords: CanonicalFileRecordLink[],
  workerThreadId: string,
  finishedAt: string,
  status: "completed" | "blocked" | "failed-safe" | "no-op",
  lastState: string,
  limitProviderSeconds?: number,
  bumpFailed = status === "failed-safe",
  attemptId: string | null = null,
  releaseLease = true,
) {
  return {
    status,
    providerId: run.providerId ?? "unknown",
    workerThreadId,
    projectId: run.projectId ?? "unknown",
    environmentId: run.environmentId,
    revision,
    canonicalRecords,
    finishedAt,
    lastState,
    bumpFailed,
    bumpNoop: status === "no-op",
    attemptId,
    releaseLease,
    expectedRunStatus: run.status,
    ...(limitProviderSeconds === undefined ? {} : { limitProviderSeconds }),
  };
}

export function finalizeCancelledRun(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  options: {
    readonly releaseLease: boolean;
    readonly workerThreadId: string;
  },
): boolean {
  const run = detail.summary;
  const attempt = [...detail.attempts].reverse().find((candidate) =>
    candidate.runId === run.runId && ACTIVE_ATTEMPT_STATUSES.includes(candidate.status as typeof ACTIVE_ATTEMPT_STATUSES[number]),
  );
  if (!attempt) return false;
  const input = finalizationInput(
    run,
    run.repositoryRevision,
    [...run.canonicalRecords],
    options.workerThreadId,
    ctx.now().toISOString(),
    "no-op",
    "cancelled",
    undefined,
    false,
    attempt.attemptId,
    options.releaseLease,
  );
  return finalizeRun(ctx, detail, {
    ...input,
    expectedAttemptStatus: attempt.status,
    expectedLeaseId: detail.lease?.leaseId ?? null,
    expectedLeaseStatus: detail.lease?.status,
    ...(options.releaseLease ? {} : { leaseWorkerThreadId: null }),
  });
}

function finalizeCancellationDeadline(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  workerThreadId: string,
  reason: string,
): void {
  const run = detail.summary;
  const attempt = [...detail.attempts].reverse().find((candidate) =>
    candidate.runId === run.runId && candidate.status === "cancel-requested",
  );
  if (!attempt) return;
  finalizeRun(ctx, detail, {
    ...finalizationInput(
      run,
      run.repositoryRevision,
      [...run.canonicalRecords],
      workerThreadId,
      ctx.now().toISOString(),
      "failed-safe",
      reason,
      undefined,
      true,
      attempt.attemptId,
      false,
    ),
    expectedAttemptStatus: "cancel-requested",
    expectedLeaseId: detail.lease?.leaseId ?? null,
    expectedLeaseStatus: "release-requested",
  });
}

async function settlePendingAttemptAtDeadline(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  activeAttempt: NonNullable<ReturnType<OperationalTransaction["getActiveAttempt"]>>,
  lease: ReturnType<OperationalTransaction["getLeaseForRun"]>,
): Promise<void> {
  const run = detail.summary;
  const workerThreadId = activeAttempt.workerThreadId ?? run.workerThreadId;
  if (!workerThreadId) {
    finalizeRun(ctx, detail, {
      ...finalizationInput(
        run,
        run.repositoryRevision,
        [...run.canonicalRecords],
        "unknown-thread",
        ctx.now().toISOString(),
        "failed-safe",
        "retry-settlement-deadline-expired",
        undefined,
        true,
        activeAttempt.attemptId,
        false,
      ),
      expectedAttemptStatus: "pending",
      expectedLeaseId: lease?.leaseId ?? null,
      expectedLeaseStatus: lease?.status,
      leaseWorkerThreadId: lease?.workerThreadId ?? null,
    });
    return;
  }

  let threadStatus: ThreadStatusValue;
  try {
    threadStatus = (await ctx.sdk.threads.get({ threadId: workerThreadId })).status as ThreadStatusValue;
  } catch (error) {
    finalizeRun(ctx, detail, {
      ...finalizationInput(
        run,
        run.repositoryRevision,
        [...run.canonicalRecords],
        workerThreadId,
        ctx.now().toISOString(),
        "failed-safe",
        `retry settlement could not read worker: ${errorMessage(error)}`,
        undefined,
        true,
        activeAttempt.attemptId,
        false,
      ),
      expectedAttemptStatus: "pending",
      expectedLeaseId: lease?.leaseId ?? null,
      expectedLeaseStatus: lease?.status,
      leaseWorkerThreadId: lease?.workerThreadId ?? null,
    });
    return;
  }

  if (!isTerminalThreadStatus(threadStatus)) {
    try {
      await withWorkerOperation(ctx, workerThreadId, "stop", () => ctx.sdk.threads.stop({ threadId: workerThreadId }));
    } catch (error) {
      finalizeRun(ctx, detail, {
        ...finalizationInput(
          run,
          run.repositoryRevision,
          [...run.canonicalRecords],
          workerThreadId,
          ctx.now().toISOString(),
          "failed-safe",
          `retry settlement stop failed: ${errorMessage(error)}`,
          undefined,
          true,
          activeAttempt.attemptId,
          false,
        ),
        expectedAttemptStatus: "pending",
        expectedLeaseId: lease?.leaseId ?? null,
        expectedLeaseStatus: lease?.status,
        leaseWorkerThreadId: lease?.workerThreadId ?? null,
      });
      return;
    }
    finalizeRun(ctx, detail, {
      ...finalizationInput(
        run,
        run.repositoryRevision,
        [...run.canonicalRecords],
        workerThreadId,
        ctx.now().toISOString(),
        "failed-safe",
        `retry settlement deadline expired while worker was ${threadStatus}`,
        undefined,
        true,
        activeAttempt.attemptId,
        false,
      ),
      expectedAttemptStatus: "pending",
      expectedLeaseId: lease?.leaseId ?? null,
      expectedLeaseStatus: lease?.status,
      leaseWorkerThreadId: lease?.workerThreadId ?? null,
    });
    return;
  }

  finalizeRun(ctx, detail, {
    ...finalizationInput(
      run,
      run.repositoryRevision,
      [...run.canonicalRecords],
      workerThreadId,
      ctx.now().toISOString(),
      "failed-safe",
      `retry settlement deadline expired after worker became ${threadStatus}`,
      undefined,
      true,
      activeAttempt.attemptId,
      false,
    ),
    expectedAttemptStatus: "pending",
    expectedLeaseId: lease?.leaseId ?? null,
    expectedLeaseStatus: lease?.status,
    leaseWorkerThreadId: lease?.workerThreadId ?? null,
  });
}

async function reconcileTerminalRun(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  threadId: string,
  threadStatus: ThreadStatusValue,
): Promise<boolean> {
  const run = detail.summary;
  const startedAtMs = newestActiveAttemptStartMs(detail);
  const current = await readCurrentState(ctx, run.repositoryKey, startedAtMs);
  let evidence: RunEvidence;
  try {
    evidence = await postRunRecords(ctx, run, threadId, current, startedAtMs);
  } catch (error) {
    markRunForReconciliation(ctx, detail, `could not read immutable terminal evidence: ${errorMessage(error)}`, current.rawObservation);
    return false;
  }
  const validation = validateCompletion(ctx, detail, threadId, current, evidence);
  if (validation.kind !== "accepted") {
    const firstAttempt = detail.attempts.find((attempt) => attempt.runId === run.runId);
    const initialGeneration = activeAttemptId(detail) === (firstAttempt?.attemptId ?? null);
    const reason = threadStatus === "error" && current.kind !== "retryable" && initialGeneration
      ? `dead-start: ${validation.reason}`
      : validation.reason;
    markRunForReconciliation(ctx, detail, reason, validation.rawObservation);
    return false;
  }
  const state = validation.state!;
  const finishedAt = ctx.now().toISOString();
  const reconciliation = ctx.store.getReconciliation(run.runId);
  const deadStart = state === "failed-safe" && reconciliation?.reasonCode.startsWith("dead-start") === true;
  const canonicalRecords = [...evidence.canonicalRecords];
  if (validation.record && !canonicalRecords.some((record) => record.relativePath === validation.record!.relativePath)) {
    canonicalRecords.push({
      relativePath: validation.record.relativePath,
      recordType: "immutable-run",
      recordId: validation.record.relativePath.split("/").pop() ?? run.runId,
      repositoryRevision: evidence.revision,
    });
  }
  const status = outcomeToStatus(state);
  const terminalAttempt = [...detail.attempts].reverse().find((attempt) =>
    attempt.runId === run.runId && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number]),
  );
  finalizeRun(ctx, detail, {
    ...finalizationInput(
      run,
      evidence.revision,
      canonicalRecords,
      threadId,
      finishedAt,
      status,
      deadStart ? "dead-start" : state,
      deadStart ? PROVIDER_LIMIT_SECONDS : undefined,
      deadStart ? false : status === "failed-safe",
      activeAttemptId(detail),
    ),
    expectedAttemptStatus: terminalAttempt?.status,
    expectedLeaseId: detail.lease?.leaseId ?? null,
    expectedLeaseStatus: detail.lease?.status,
  });
  ctx.log?.(`run ${run.runId}: finished ${state} on ${threadStatus}`);
  return true;
}

async function reconcileStartedRun(ctx: DispatchContext, detail: OperationalRunDetail): Promise<void> {
  const run = detail.summary;
  if (["completed", "blocked", "failed-safe", "no-op"].includes(run.status)) return;
  const activeAttempt = [...detail.attempts].reverse().find((attempt) =>
    attempt.runId === run.runId && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number]),
  );
  const lease = detail.lease ?? ctx.store.getLeaseForRun(run.runId);
  // Retry creates this generation before the external retry call. It is a
  // durable in-flight fence while its lease deadline is still open. After the
  // deadline, recovery must re-observe the known worker so a hung provider
  // call cannot consume global capacity forever.
  if (activeAttempt?.status === "pending") {
    if (activeAttempt.startedAt === null) return;
    const pendingDeadline = lease === null ? Number.NaN : Date.parse(lease.expiresAt);
    if (!Number.isFinite(pendingDeadline) || ctx.now().getTime() < pendingDeadline) return;
    await settlePendingAttemptAtDeadline(ctx, detail, activeAttempt, lease);
    return;
  }
  if (!activeAttempt || activeAttempt.startedAt === null) return;
  const threadId = run.workerThreadId;
  if (!threadId || threadId === "spawn-ambiguous" || threadId === "unknown-thread") {
    markRunForReconciliation(ctx, detail, "has no recorded worker thread to observe");
    return;
  }

  let threadStatus: ThreadStatusValue;
  try {
    const thread = await ctx.sdk.threads.get({ threadId });
    threadStatus = thread.status as ThreadStatusValue;
  } catch (error) {
    if (run.status === "cancel-requested" && lease !== null && Date.parse(lease.expiresAt) <= ctx.now().getTime()) {
      finalizeCancellationDeadline(ctx, detail, threadId, `cancellation deadline expired while worker was unreadable: ${errorMessage(error)}`);
      return;
    }
    markRunForReconciliation(ctx, detail, `could not read worker thread '${threadId}': ${errorMessage(error)}`);
    return;
  }

  if (run.status === "cancel-requested") {
    if (isTerminalThreadStatus(threadStatus)) {
      finalizeCancelledRun(ctx, detail, { releaseLease: true, workerThreadId: threadId });
      return;
    }
    const expired = lease !== null && Date.parse(lease.expiresAt) <= ctx.now().getTime();
    if (!expired) return;
    try {
      await withWorkerOperation(ctx, threadId, "stop", () => ctx.sdk.threads.stop({ threadId }));
    } catch (error) {
      finalizeCancellationDeadline(ctx, detail, threadId, `cancellation deadline expired; stop failed: ${errorMessage(error)}`);
      return;
    }
    finalizeCancellationDeadline(ctx, detail, threadId, `cancellation deadline expired while worker was ${threadStatus}`);
    return;
  }

  const nowMs = ctx.now().getTime();
  if (!isTerminalThreadStatus(threadStatus)) {
    const expired = lease !== null && Date.parse(lease.expiresAt) <= nowMs;
    if (!expired) return;
    try {
      await withWorkerOperation(ctx, threadId, "stop", () => ctx.sdk.threads.stop({ threadId }));
    } catch (error) {
      markRunForReconciliation(ctx, detail, `stop request for '${threadId}' failed: ${errorMessage(error)}`);
      return;
    }
    const transitioned = transitionRuntimeExpiryToCancelRequested(ctx, detail, activeAttempt, lease, threadId);
    if (!transitioned) {
      ctx.log?.(`run ${run.runId}: ignored stale runtime-cap stop result for generation ${activeAttempt.attemptId}`);
      return;
    }
    ctx.log?.(`run ${run.runId}: runtime cap reached; stop requested on '${threadId}'`);
    return;
  }

  await reconcileTerminalRun(ctx, detail, threadId, threadStatus);
}

function transitionRuntimeExpiryToCancelRequested(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  expectedAttempt: NonNullable<OperationalRunDetail["attempts"][number]>,
  expectedLease: OperationalRunDetail["lease"],
  workerThreadId: string,
): boolean {
  const run = detail.summary;
  if (!expectedLease) return false;
  return ctx.store.withTransaction((transaction) => {
    const currentRun = transaction.getRunSummary(run.runId);
    const currentAttempt = transaction.getActiveAttempt(run.runId);
    const currentLease = transaction.getLeaseForRun(run.runId);
    if (currentRun === null
      || !sameRunGeneration(currentRun, run)
      || currentRun.status !== "started"
      || !sameAttemptGeneration(currentAttempt, expectedAttempt)
      || currentAttempt?.status !== "started"
      || currentAttempt.workerThreadId !== workerThreadId
      || !sameLeaseGeneration(currentLease, expectedLease)
      || currentLease?.status !== "held"
      || currentLease.workerThreadId !== workerThreadId) return false;
    transaction.updateRunDispatch(runDispatchUpdate(currentRun, {
      status: "cancel-requested",
      finishedAt: null,
      workerThreadId,
    }));
    transaction.updateDispatchAttempt({ ...currentAttempt, status: "cancel-requested" });
    transaction.updateOwnershipLease({ ...currentLease, status: "release-requested" });
    return true;
  });
}

async function reconcileReconciliationRun(ctx: DispatchContext, detail: OperationalRunDetail): Promise<void> {
  const run = detail.summary;
  if (["completed", "blocked", "failed-safe", "no-op"].includes(run.status)) return;
  const metadata = ctx.store.getReconciliation(run.runId);
  if (!metadata) {
    markRunForReconciliation(ctx, detail, "entered reconciliation without persisted metadata");
    return;
  }
  const deadlinePassed = ctx.now().getTime() >= Date.parse(metadata.deadlineAt);
  const threadId = run.workerThreadId;
  if (!threadId || threadId === "spawn-ambiguous" || threadId === "unknown-thread") {
    if (deadlinePassed) {
      finalizeAtReconciliationDeadline(ctx, detail, metadata, threadId ?? "unknown-thread", false);
      ctx.log?.(`run ${run.runId}: reconciliation deadline expired; finalized failed-safe`);
      return;
    }
    markRunForReconciliation(ctx, detail, "has no recorded worker thread to observe");
    return;
  }
  let threadStatus: ThreadStatusValue;
  try {
    const thread = await ctx.sdk.threads.get({ threadId });
    threadStatus = thread.status as ThreadStatusValue;
  } catch (error) {
    const reason = `could not read worker thread '${threadId}': ${errorMessage(error)}`;
    if (deadlinePassed) {
      finalizeAtReconciliationDeadline(ctx, detail, metadata, threadId, false, reason);
    } else {
      markRunForReconciliation(ctx, detail, reason);
    }
    return;
  }
  if (!isTerminalThreadStatus(threadStatus)) {
    if (!deadlinePassed) return;
    try {
      await withWorkerOperation(ctx, threadId, "stop", () => ctx.sdk.threads.stop({ threadId }));
    } catch (error) {
      const reason = `stop request for '${threadId}' failed: ${errorMessage(error)}`;
      finalizeAtReconciliationDeadline(ctx, detail, metadata, threadId, false, reason);
      return;
    }
    finalizeAtReconciliationDeadline(ctx, detail, metadata, threadId, false, `worker '${threadId}' was still ${threadStatus} at the reconciliation deadline`);
    ctx.log?.(`run ${run.runId}: reconciliation deadline reached; finalized failed-safe and quarantined the lease after stop request on '${threadId}'`);
    return;
  }

  if (deadlinePassed) {
    finalizeAtReconciliationDeadline(
      ctx,
      detail,
      ctx.store.getReconciliation(run.runId) ?? metadata,
      threadId,
      true,
      "reconciliation deadline expired after terminal worker re-observation",
    );
    ctx.log?.(`run ${run.runId}: reconciliation deadline expired after terminal re-observation; finalized failed-safe`);
    return;
  }
  await reconcileTerminalRun(ctx, detail, threadId, threadStatus);
}

function finalizeAtReconciliationDeadline(
  ctx: DispatchContext,
  detail: OperationalRunDetail,
  metadata: { readonly reasonCode: string },
  workerThreadId: string,
  releaseLease: boolean,
  resolutionReason?: string,
): void {
  const run = detail.summary;
  const deadStart = metadata.reasonCode.startsWith("dead-start");
  const finalReason = boundedDiagnostic(deadStart ? "dead-start" : (resolutionReason ?? "reconciliation-deadline-expired"), 128);
  const terminalAttempt = [...detail.attempts].reverse().find((attempt) =>
    attempt.runId === run.runId && ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number]),
  );
  finalizeRun(ctx, detail, {
    ...finalizationInput(
      run,
      run.repositoryRevision,
      [...run.canonicalRecords],
      workerThreadId,
      ctx.now().toISOString(),
      "failed-safe",
      finalReason,
      deadStart || workerThreadId === "spawn-ambiguous" ? PROVIDER_LIMIT_SECONDS : undefined,
      deadStart ? false : true,
      activeAttemptId(detail),
      releaseLease,
    ),
    expectedAttemptStatus: terminalAttempt?.status,
    expectedLeaseId: detail.lease?.leaseId ?? null,
    expectedLeaseStatus: detail.lease?.status,
    leaseWorkerThreadId: detail.lease?.workerThreadId ?? null,
  });
}

async function reconcileQuarantinedLease(
  ctx: DispatchContext,
  lease: NonNullable<ReturnType<DispatchContext["store"]["getCurrentOwnership"]>>,
  detail: OperationalRunDetail,
): Promise<void> {
  const threadId = lease.workerThreadId;
  if (!threadId || threadId === "spawn-ambiguous" || threadId === "unknown-thread") return;
  let threadStatus: ThreadStatusValue;
  try {
    threadStatus = (await ctx.sdk.threads.get({ threadId })).status as ThreadStatusValue;
  } catch {
    return;
  }
  if (!isTerminalThreadStatus(threadStatus)) {
    const stillOwnsWorker = ctx.store.withTransaction((transaction) => {
      const currentLease = transaction.getLeaseForRun(lease.runId);
      return sameLeaseGeneration(currentLease, lease)
        && currentLease?.status === "reconciliation-required"
        && currentLease.workerThreadId === threadId;
    });
    if (!stillOwnsWorker) return;
    try {
      await withWorkerOperation(ctx, threadId, "stop", () => ctx.sdk.threads.stop({ threadId }));
    } catch {
      // The lease remains quarantined until a later observation confirms exit.
    }
    return;
  }
  ctx.store.withTransaction((transaction) => {
    const expectedRun = detail.summary;
    const currentLease = transaction.getLeaseForRun(lease.runId);
    if (currentLease === null || !sameLeaseGeneration(currentLease, lease) || currentLease.status !== "reconciliation-required") return;
    const currentRun = transaction.getRunSummary(expectedRun.runId);
    if (!sameRunGeneration(currentRun, expectedRun)
      || currentLease.repositoryKey !== lease.repositoryKey
      || currentLease.workerThreadId !== threadId
      || !currentRun
      || !TERMINAL_RUN_STATUSES.includes(currentRun.status as typeof TERMINAL_RUN_STATUSES[number])) return;
    const expectedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.runId === expectedRun.runId);
    if (expectedAttempt !== undefined) {
      const currentAttempt = transaction.getDispatchAttempt(expectedAttempt.attemptId);
      if (currentAttempt === null
        || currentAttempt.attemptId !== expectedAttempt.attemptId
        || currentAttempt.runId !== expectedAttempt.runId
        || currentAttempt.repositoryKey !== expectedAttempt.repositoryKey
        || currentAttempt.providerId !== expectedAttempt.providerId
        || currentAttempt.model !== expectedAttempt.model
        || currentAttempt.reasoningLevel !== expectedAttempt.reasoningLevel
        || currentAttempt.workerThreadId !== expectedAttempt.workerThreadId
        || currentAttempt.status !== expectedAttempt.status
        || currentAttempt.startedAt !== expectedAttempt.startedAt
        || currentAttempt.finishedAt !== expectedAttempt.finishedAt) return;
    }
    transaction.updateOwnershipLease({ ...currentLease, workerThreadId: threadId, status: "released" });
  });
}

/**
 * Explicit operator-only abandonment for a lease whose spawn never yielded a
 * trusted thread id. The durable reconciliation deadline, a second durable
 * wait, and repository pause are all required. A current.md marker is never
 * used as ownership proof.
 */
export function releaseQuarantinedOwnership(ctx: DispatchContext, repositoryKey: RepositoryKey): boolean {
  const entry = ctx.repositoryLookup(repositoryKey);
  if (!entry?.dispatchPaused) return false;
  const lease = ctx.store.getCurrentOwnership(repositoryKey);
  if (!lease || lease.status !== "reconciliation-required") return false;
  const metadata = ctx.store.getReconciliation(lease.runId);
  if (!metadata || metadata.resolution !== "failed-safe" || metadata.resolvedAt === null) return false;
  const deadline = Date.parse(metadata.deadlineAt);
  if (!Number.isFinite(deadline) || ctx.now().getTime() < deadline + QUARANTINE_ABANDONMENT_GRACE_MS) return false;
  if (lease.workerThreadId !== null
    && lease.workerThreadId !== "spawn-ambiguous"
    && lease.workerThreadId !== "unknown-thread"
    && lease.workerThreadId !== "never-dispatched") return false;
  return ctx.store.withTransaction((transaction) => {
    const currentLease = transaction.getLeaseForRun(lease.runId);
    const currentRun = transaction.getRunSummary(lease.runId);
    const currentMetadata = transaction.getReconciliation(lease.runId);
    if (!sameLeaseGeneration(currentLease, lease)
      || currentRun === null
      || currentRun.repositoryKey !== repositoryKey
      || currentRun.status !== "failed-safe"
      || currentMetadata?.resolution !== "failed-safe"
      || currentMetadata.resolvedAt !== metadata.resolvedAt
      || currentMetadata.deadlineAt !== metadata.deadlineAt
      || currentMetadata.reasonCode !== metadata.reasonCode
      || currentLease === null
      || currentLease.status !== "reconciliation-required") return false;
    transaction.updateOwnershipLease({ ...currentLease, status: "released" });
    return true;
  });
}

export async function reconcileRepository(ctx: DispatchContext, repositoryKey: RepositoryKey): Promise<void> {
  for (const run of ctx.store.listActiveRuns(repositoryKey)) {
    const detail = (await ctx.store.getRun({ repositoryKey, runId: run.runId })).run;
    if (!detail) continue;
    const currentStatus = detail.summary.status;
    if (["completed", "blocked", "failed-safe", "no-op"].includes(currentStatus)) continue;
    if (currentStatus === "pending") {
      const ageMs = ctx.now().getTime() - Date.parse(detail.summary.requestedAt);
      if (ageMs > PENDING_RUN_GRACE_MS) {
        markRunForReconciliation(ctx, detail, "was never dispatched within the start grace period");
      }
      continue;
    }
    if (currentStatus === "reconciliation-required") {
      await reconcileReconciliationRun(ctx, detail);
      continue;
    }
    await reconcileStartedRun(ctx, detail);
  }

  const lease = ctx.store.getCurrentOwnership(repositoryKey);
  if (lease && lease.status === "reconciliation-required") {
    const detail = (await ctx.store.getRun({ repositoryKey, runId: lease.runId })).run;
    if (detail && TERMINAL_RUN_STATUSES.includes(detail.summary.status as typeof TERMINAL_RUN_STATUSES[number])) {
      await reconcileQuarantinedLease(ctx, lease, detail);
    }
  } else if (lease && lease.status !== "released") {
    const detail = (await ctx.store.getRun({ repositoryKey, runId: lease.runId })).run;
    if (detail === null) {
      updateLeaseIfExact(ctx, lease, "reconciliation-required");
    } else if (!["pending", "started", "cancel-requested", "reconciliation-required"].includes(detail.summary.status)) {
      // A terminal run is not proof that its worker stopped. Quarantine the
      // lease first, then release it only through the trusted worker
      // re-observation path. Unknown workers remain quarantined for the
      // explicit operator repair seam.
      updateLeaseIfExact(ctx, lease, "reconciliation-required", detail.summary);
      const quarantined = ctx.store.getCurrentOwnership(repositoryKey);
      if (quarantined?.leaseId === lease.leaseId) {
        await reconcileQuarantinedLease(ctx, quarantined, detail);
      }
    }
  }
}
