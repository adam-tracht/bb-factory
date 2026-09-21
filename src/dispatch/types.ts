import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  DispatcherState,
  OperationalStateStore,
  RunDispatchUpdate,
} from "../storage/index.js";
import type {
  CanonicalFileRecordLink,
  FactorySettings,
  OperationalRunStatus,
  OperationalRunSummary,
  RepositoryKey,
  RepositoryRegistryEntry,
} from "../contracts.js";
import type { FactoryHealthReader, ProtocolReader } from "../ports.js";
import type { TasksIntegrationMode } from "../tasks/index.js";

export type DispatchSdk = Pick<BbPluginApi["sdk"], "threads" | "files">;

type SpawnEnvironmentArgs = Parameters<DispatchSdk["threads"]["spawn"]>[0]["environment"];

/**
 * The spawn environment for a registry entry. A pinned environment id keeps
 * the legacy reuse path; without one, bb spawns against the configured
 * checkout on the factory branch and registers an unmanaged environment
 * record for it, returning the new environment id on the spawned thread.
 */
export function spawnEnvironment(entry: RepositoryRegistryEntry): SpawnEnvironmentArgs {
  if (entry.environmentId !== undefined) {
    return { type: "reuse", environmentId: entry.environmentId };
  }
  return {
    type: "host",
    hostId: entry.configuration.connectedHostId,
    workspace: {
      type: "unmanaged",
      path: entry.configuration.checkoutPath,
      branch: { kind: "existing", name: entry.configuration.factoryBranch },
    },
  };
}

export interface DispatchContext {
  readonly sdk: DispatchSdk;
  readonly store: OperationalStateStore;
  readonly protocolReader: ProtocolReader;
  readonly healthReader: FactoryHealthReader;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
  readonly settings: FactorySettings;
  readonly tasksIntegration?: TasksIntegrationMode;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
}

type WorkerOperation = "stop" | "retry";
interface WorkerOperationState {
  stop: Promise<void> | null;
  retry: Promise<void> | null;
}
const workerOperationStates = new WeakMap<object, Map<string, WorkerOperationState>>();

/** Serialize destructive and retry operations that target the same provider worker. */
export async function withWorkerOperation<T>(
  ctx: DispatchContext,
  workerThreadId: string,
  kind: WorkerOperation,
  operation: () => Promise<T>,
): Promise<T> {
  let operations = workerOperationStates.get(ctx);
  if (!operations) {
    operations = new Map();
    workerOperationStates.set(ctx, operations);
  }
  const state = operations.get(workerThreadId) ?? { stop: null, retry: null };
  operations.set(workerThreadId, state);
  const previous = kind === "retry" ? state.retry : state.stop;
  const blockedByStop = kind === "retry" ? state.stop : null;
  const operationPromise = (async () => {
    if (previous) await previous;
    if (blockedByStop && blockedByStop !== previous) await blockedByStop;
    return operation();
  })();
  const completion = operationPromise.then(() => undefined, () => undefined);
  state[kind] = completion;
  try {
    return await operationPromise;
  } finally {
    if (state[kind] === completion) state[kind] = null;
    if (state.stop === null && state.retry === null && operations.get(workerThreadId) === state) {
      operations.delete(workerThreadId);
    }
  }
}

/** The shell dispatcher marks a provider limited for six hours after a dead start or a long provider retry. */
export const PROVIDER_LIMIT_SECONDS = 6 * 3600;
/** A run left in `pending` past this grace period needs reconciliation: its worker spawn never landed. */
export const PENDING_RUN_GRACE_MS = 10 * 60 * 1000;
/** A reconciliation-required run gets one persisted settlement window. */
export const RECONCILIATION_GRACE_MS = 10 * 60 * 1000;
/** A terminal quarantined lease gets one more durable operator window. */
export const QUARANTINE_ABANDONMENT_GRACE_MS = 10 * 60 * 1000;
/** Retry budget per run: the initial attempt plus this many retries. */
export const MAX_RUN_ATTEMPTS = 3;

/** Keep provider and host diagnostics inside the storage field limits. */
export function boundedDiagnostic(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return (normalized.length > 0 ? normalized : "unknown").slice(0, maxLength);
}

/** Compare persisted JSON-shaped values without duplicating field walkers. */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function dispatcherNowSeconds(now: () => Date): number {
  return Math.floor(now().getTime() / 1000);
}

export function nightKeyAt(date: Date, windowEndHour: number): string {
  const shifted = new Date(date.getTime() - windowEndHour * 3600 * 1000);
  const year = shifted.getFullYear();
  const month = `${shifted.getMonth() + 1}`.padStart(2, "0");
  const day = `${shifted.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nightState(state: DispatcherState, nightKey: string): DispatcherState {
  if (state.nightKey === nightKey) return state;
  return { ...state, nightKey, lastState: "", failedCount: 0, noopCount: 0, lastStartProvider: "" };
}

/**
 * Builds a RunDispatchUpdate from the recorded run, applying the caller's
 * overrides. Unrecorded identities fall back to explicit sentinels rather than
 * null so stored rows stay queryable; environmentId is the exception and stays
 * honestly null when neither the run nor the update recorded one.
 */
export function runDispatchUpdate(
  run: OperationalRunSummary,
  update: {
    status: Exclude<OperationalRunStatus, "pending">;
    finishedAt?: string | null;
    providerId?: string;
    workerThreadId?: string;
    projectId?: string;
    environmentId?: string | null;
    repositoryRevision?: OperationalRunSummary["repositoryRevision"];
    canonicalRecords?: readonly CanonicalFileRecordLink[];
  },
): RunDispatchUpdate {
  return {
    repositoryKey: run.repositoryKey,
    runId: run.runId,
    status: update.status,
    startedAt: run.startedAt,
    finishedAt: update.finishedAt === undefined ? run.finishedAt : update.finishedAt,
    providerId: update.providerId ?? run.providerId ?? "unknown",
    workerThreadId: update.workerThreadId ?? run.workerThreadId ?? "unknown-thread",
    projectId: update.projectId ?? run.projectId ?? "unknown",
    environmentId: update.environmentId === undefined ? run.environmentId : update.environmentId,
    repositoryRevision: update.repositoryRevision ?? run.repositoryRevision,
    ...(update.canonicalRecords === undefined ? {} : { canonicalRecords: update.canonicalRecords }),
  };
}
