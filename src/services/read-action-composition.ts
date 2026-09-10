import {
  factoryActionResultSchema,
  type FactoryActionResult,
  type RepositoryConfiguration,
  type RevisionFreeActionRequest,
} from "../contracts.js";
import type { ProtocolReader, ReadOnlyActionExecutor } from "../ports.js";

export interface ReadOnlyActionCompositionOptions {
  readonly protocolReader: ProtocolReader;
  readonly repositoryLookup: (repositoryKey: string) => RepositoryConfiguration | null;
}

function disabledAction(request: RevisionFreeActionRequest): FactoryActionResult {
  return {
    ok: false,
    error: {
      category: "unsupported",
      message:
        "P1 read-only mode keeps this action disabled. No repository, BB interaction, dispatch, scheduler, or worker mutation was performed.",
      idempotencyKey: request.idempotencyKey,
    },
  };
}

export function createReadOnlyActionExecutor(
  options: ReadOnlyActionCompositionOptions,
): ReadOnlyActionExecutor {
  return {
    async execute(request) {
      const configuration = options.repositoryLookup(request.repositoryKey);
      if (!configuration) {
        return factoryActionResultSchema.parse({
          ok: false,
          error: {
            category: "not-found",
            message: `Repository '${request.repositoryKey}' is not configured. Select a configured repository before requesting a read-only action.`,
            idempotencyKey: request.idempotencyKey,
          },
        });
      }

      if (request.action.kind !== "preview" && request.action.kind !== "integration-report") {
        return disabledAction(request);
      }

      try {
        const snapshot = await options.protocolReader.loadSnapshot(configuration);
        return factoryActionResultSchema.parse({
          ok: true,
          result: {
            status: "preview",
            message:
              request.action.kind === "preview"
                ? "Preview loaded from the repository protocol. No mutation was performed."
                : "Integration report loaded from the repository protocol. No mutation was performed.",
            revision: snapshot.revision,
            runId: null,
            leaseId: null,
            queueItemId: null,
            action: request.action.kind,
          },
          revision: snapshot.revision,
        });
      } catch (error) {
        return factoryActionResultSchema.parse({
          ok: false,
          error: {
            category: "internal",
            message: `Could not load the read-only ${request.action.kind} for repository '${request.repositoryKey}': ${error instanceof Error ? error.message : String(error)}`,
            idempotencyKey: request.idempotencyKey,
          },
        });
      }
    },
  };
}
