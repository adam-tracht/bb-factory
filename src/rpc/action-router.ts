import {
  bbInteractionActionRequestSchema,
  repositoryActionRequestSchema,
  revisionFreeActionRequestSchema,
  factoryActionResultSchema,
  type FactoryActionResult,
  type InvalidationEvent,
} from "../contracts.js";
import { actionError } from "../actions/results.js";
import { errorMessage } from "../errors.js";
import type { FactoryComposition } from "../services/action-composition.js";
import type { FactoryReadRpcHandlers } from "./read-router.js";
import { createFactoryReadRpcHandlers } from "./read-router.js";

/**
 * The full factory RPC surface: the P1 read routes plus the guarded P2
 * action route. Revision-free actions go to the read-only executor;
 * repository actions go to the repository executor; BB interaction and
 * lifecycle actions go to the interaction executor.
 */
export function createFactoryRpcHandlers(
  getComposition: () => FactoryComposition,
  publish: (event: InvalidationEvent) => void,
): FactoryReadRpcHandlers {
  const read = createFactoryReadRpcHandlers(getComposition);
  return {
    ...read,
    async factory_action(input) {
      const composition = getComposition();
      const revisionFree = revisionFreeActionRequestSchema.safeParse(input);
      if (revisionFree.success) {
        const entry = composition.getRepositoryEntry(revisionFree.data.repositoryKey);
        if (!entry) {
          return actionError("not-found", `Repository '${revisionFree.data.repositoryKey}' is not configured.`, revisionFree.data.idempotencyKey);
        }
        return composition.readOnlyActionExecutor.execute(revisionFree.data);
      }

      const repositoryAction = repositoryActionRequestSchema.safeParse(input);
      let request;
      let execute: () => Promise<FactoryActionResult>;
      if (repositoryAction.success) {
        request = repositoryAction.data;
        const valid = repositoryAction.data;
        execute = () => composition.repositoryActionExecutor.execute(valid);
      } else {
        const bbAction = bbInteractionActionRequestSchema.safeParse(input);
        if (!bbAction.success) {
          return actionError(
            "invalid-input",
            `Invalid factory action request: ${repositoryAction.error.issues[0]?.message ?? "schema mismatch"}`,
          );
        }
        request = bbAction.data;
        const valid = bbAction.data;
        execute = () => composition.bbInteractionActionExecutor.execute(valid);
      }
      const entry = composition.getRepositoryEntry(request.repositoryKey);
      if (!entry) {
        return actionError("not-found", `Repository '${request.repositoryKey}' is not configured.`, request.idempotencyKey);
      }

      let result: FactoryActionResult;
      try {
        result = await execute();
      } catch (error) {
        return actionError(
          "internal",
          `The action executor failed: ${errorMessage(error)}`,
          request.idempotencyKey,
        );
      }
      const validated = factoryActionResultSchema.safeParse(result);
      if (!validated.success) {
        return actionError(
          "internal",
          `The action executor returned a malformed result: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          request.idempotencyKey,
        );
      }
      if (validated.data.ok && validated.data.result.status !== "preview") {
        publish({
          channel: "factory",
          kind: "repository.changed",
          repositoryKey: request.repositoryKey,
          revision: validated.data.revision,
          reason: `Factory action '${request.action.kind}' changed state.`,
          durableReloadRequired: true,
        });
      }
      return validated.data;
    },
  };
}
