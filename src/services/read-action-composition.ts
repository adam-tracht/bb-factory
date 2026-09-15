import {
  factoryActionResultSchema,
  type FactoryActionResult,
  type RepositoryRegistryEntry,
  type RevisionFreeActionRequest,
} from "../contracts.js";
import { repositoryLabel } from "../repository-label.js";
import type { ProtocolReader, ReadOnlyActionExecutor } from "../ports.js";

export interface ReadOnlyActionCompositionOptions {
  readonly protocolReader: ProtocolReader;
  readonly repositoryLookup: (repositoryKey: string) => RepositoryRegistryEntry | null;
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
      const entry = options.repositoryLookup(request.repositoryKey);
      if (!entry) {
        return factoryActionResultSchema.parse({
          ok: false,
          error: {
            category: "not-found",
            message: `Repository '${request.repositoryKey}' is not configured. Select a configured repository before requesting a read-only action.`,
            idempotencyKey: request.idempotencyKey,
          },
        });
      }
      const label = repositoryLabel(request.repositoryKey, entry.displayName);

      if (request.action.kind !== "preview" && request.action.kind !== "integration-report") {
        return disabledAction(request);
      }

      try {
        const snapshot = await options.protocolReader.loadSnapshot(entry.configuration);
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
            message: `Could not load the read-only ${request.action.kind} for repository '${label}': ${error instanceof Error ? error.message : String(error)}`,
            idempotencyKey: request.idempotencyKey,
          },
        });
      }
    },
  };
}
