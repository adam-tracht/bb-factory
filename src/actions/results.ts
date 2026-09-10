import {
  factoryActionResultSchema,
  type ActionOutcome,
  type FactoryActionResult,
  type FactoryErrorCategory,
  type IdempotencyKey,
  type RepositoryRevision,
} from "../contracts.js";

export function actionError(
  category: Exclude<FactoryErrorCategory, "stale-revision">,
  message: string,
  idempotencyKey?: IdempotencyKey,
): FactoryActionResult {
  return factoryActionResultSchema.parse({
    ok: false,
    error: {
      category,
      message,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  });
}

export function staleRevisionError(
  message: string,
  expectedRevision: RepositoryRevision,
  actualRevision: RepositoryRevision,
  idempotencyKey?: IdempotencyKey,
): FactoryActionResult {
  return factoryActionResultSchema.parse({
    ok: false,
    error: {
      category: "stale-revision",
      message,
      expectedRevision,
      actualRevision,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  });
}

export function actionSuccess(
  outcome: ActionOutcome,
  revision: RepositoryRevision | null,
): FactoryActionResult {
  return factoryActionResultSchema.parse({ ok: true, result: outcome, revision });
}

export function sameRevision(left: RepositoryRevision, right: RepositoryRevision): boolean {
  if (left.gitCommit !== right.gitCommit || left.protocolDigest !== right.protocolDigest) return false;
  const leftKeys = Object.keys(left.fileDigests);
  const rightKeys = Object.keys(right.fileDigests);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left.fileDigests[key] === right.fileDigests[key]);
}

export { errorMessage } from "../errors.js";
