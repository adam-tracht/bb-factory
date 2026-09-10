import type { BbInteractionResolution, FactoryActionResult, IdempotencyKey } from "../contracts.js";
import {
  IdempotencyConflictError,
  PendingActionIntentExpiredError,
  type OperationalStateStore,
  type PendingActionIntentRecord,
  type PendingActionObservedStatus,
} from "../storage/index.js";
import { actionError, errorMessage } from "./results.js";

/** The deterministic reply for a consumed intent that this call did not take. */
export function consumedResult(record: PendingActionIntentRecord): FactoryActionResult {
  if (record.status === "completed" && record.result) return record.result;
  if (record.status === "reconciliation-required") {
    return actionError(
      "conflict",
      `Action '${record.idempotencyKey}' needs reconciliation: ${record.lastError ?? "the external result is ambiguous"}.`,
      record.idempotencyKey,
    );
  }
  return actionError("conflict", `Action '${record.idempotencyKey}' is already being executed.`, record.idempotencyKey);
}

/** Structural deep equality for recorded request and resolution payloads. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, index) => key === bKeys[index] && deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ));
  }
  return false;
}

/**
 * Short-circuit for a completed or reconciliation-required intent before any
 * fresh snapshot or SDK reads. The recorded request must match exactly; the
 * plan target and file change were bound to it at claim time, so a matching
 * request guarantees the stored outcome belongs to this call.
 */
export function recordedIntentResult(
  store: OperationalStateStore,
  request: { idempotencyKey: string },
): FactoryActionResult | null {
  const record = store.getPendingActionIntent(request.idempotencyKey);
  if (!record) return null;
  if (record.status !== "completed" && record.status !== "reconciliation-required") return null;
  if (!deepEqual(record.request, request)) {
    return actionError(
      "idempotency-conflict",
      `idempotency key was already used for a different request: ${request.idempotencyKey}`,
      request.idempotencyKey,
    );
  }
  return consumedResult(record);
}

export function claimErrorResult(error: unknown, idempotencyKey: IdempotencyKey): FactoryActionResult {
  if (error instanceof IdempotencyConflictError) {
    return actionError("idempotency-conflict", errorMessage(error), idempotencyKey);
  }
  if (error instanceof PendingActionIntentExpiredError) {
    return actionError("invalid-input", errorMessage(error), idempotencyKey);
  }
  return actionError("internal", errorMessage(error), idempotencyKey);
}

export function completeIntent(
  store: OperationalStateStore,
  record: PendingActionIntentRecord,
  result: FactoryActionResult,
  observed?: { observedStatus?: PendingActionObservedStatus; observedResolution?: BbInteractionResolution | null },
): FactoryActionResult {
  store.updatePendingActionIntent({
    idempotencyKey: record.idempotencyKey,
    status: "completed",
    result,
    ...(observed?.observedStatus === undefined ? {} : { observedStatus: observed.observedStatus }),
    ...(observed?.observedResolution === undefined ? {} : { observedResolution: observed.observedResolution }),
  });
  return result;
}

export function reconcileIntent(
  store: OperationalStateStore,
  record: PendingActionIntentRecord,
  message: string,
  observed?: { observedStatus?: PendingActionObservedStatus; observedResolution?: BbInteractionResolution | null },
): FactoryActionResult {
  store.updatePendingActionIntent({
    idempotencyKey: record.idempotencyKey,
    status: "reconciliation-required",
    lastError: message,
    ...(observed?.observedStatus === undefined ? {} : { observedStatus: observed.observedStatus }),
    ...(observed?.observedResolution === undefined ? {} : { observedResolution: observed.observedResolution }),
  });
  return actionError("conflict", `${message} The action was marked for reconciliation and was not retried.`, record.idempotencyKey);
}
