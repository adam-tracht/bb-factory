import type {
  OwnershipLease,
} from "../contracts.js";
import type { OperationalStateStore } from "../storage/index.js";

export class OwnershipHeldError extends Error {
  readonly existing: OwnershipLease;

  constructor(existing: OwnershipLease) {
    super(`Repository '${existing.repositoryKey}' already has an active run under lease ${existing.leaseId}.`);
    this.name = "OwnershipHeldError";
    this.existing = existing;
  }
}

export function acquireOwnership(
  store: OperationalStateStore,
  lease: Omit<OwnershipLease, "status"> & { status?: OwnershipLease["status"] },
): OwnershipLease {
  const existing = store.getCurrentOwnership(lease.repositoryKey);
  if (existing && existing.runId !== lease.runId) {
    throw new OwnershipHeldError(existing);
  }
  const created: OwnershipLease = { ...lease, status: lease.status ?? "held" };
  store.createOwnershipLease(created);
  return created;
}

export function requestRelease(store: OperationalStateStore, lease: OwnershipLease): OwnershipLease {
  if (lease.status === "released") return lease;
  const updated: OwnershipLease = { ...lease, status: "release-requested" };
  store.updateOwnershipLease(updated);
  return updated;
}

export function confirmRelease(store: OperationalStateStore, lease: OwnershipLease, workerThreadId?: string | null): OwnershipLease {
  const updated: OwnershipLease = {
    ...lease,
    workerThreadId: workerThreadId === undefined ? lease.workerThreadId : workerThreadId,
    status: "released",
  };
  store.updateOwnershipLease(updated);
  return updated;
}

export function flagLeaseForReconciliation(store: OperationalStateStore, lease: OwnershipLease): OwnershipLease {
  if (lease.status === "released") return lease;
  const updated: OwnershipLease = { ...lease, status: "reconciliation-required" };
  store.updateOwnershipLease(updated);
  return updated;
}
