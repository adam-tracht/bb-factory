import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  revisionFreeActionRequestSchema,
  type HostPreflight,
  type ProviderStatus,
  type FactoryActionRequest,
  type RepositoryKey,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import { factoryRpcContract, type FactoryRpcContract } from "../rpc.js";
import type { ReadComposition } from "../services/read-composition.js";

export type FactoryReadRpcHandlers = PluginRpcHandlers<FactoryRpcContract>;

function missingRepository(repositoryKey: RepositoryKey): Error {
  return new Error(
    `Repository '${repositoryKey}' is not configured. Configure it in the repository registry, or complete all legacy migration fields before using this read route.`,
  );
}

function requireEntry(composition: ReadComposition, repositoryKey: RepositoryKey) {
  const entry = composition.getRepositoryEntry(repositoryKey);
  if (!entry) throw missingRepository(repositoryKey);
  return entry;
}

function disabledAction(request: FactoryActionRequest) {
  return {
    ok: false as const,
    error: {
      category: "unsupported" as const,
      message:
        "P1 read-only mode keeps this action disabled. No repository, BB interaction, dispatch, scheduler, or worker mutation is performed.",
      idempotencyKey: request.idempotencyKey,
    },
  };
}

function providerReadFailure(error: unknown): ProviderStatus {
  return {
    providerId: "unknown",
    model: "unavailable",
    reasoningLevel: "none",
    availability: "unknown",
    limitedUntil: null,
    activeThreadCount: 0,
    lastError: `Could not read live provider health: ${errorMessage(error)}`,
  };
}

function hostReadFailure(repositoryKey: RepositoryKey, error: unknown): HostPreflight {
  return {
    hostId: "unknown",
    status: "unknown",
    checkoutExists: false,
    branch: null,
    requiredTools: {},
    browserAvailable: null,
    dbtStudioAvailable: null,
    ok: false,
    reasons: [`Could not read host preflight for repository '${repositoryKey}': ${errorMessage(error)}`],
  };
}

export function createFactoryReadRpcHandlers(
  getComposition: () => ReadComposition,
): FactoryReadRpcHandlers {
  return {
    async factory_snapshot(input) {
      const composition = getComposition();
      const entry = requireEntry(composition, input.repositoryKey);
      return composition.protocolReader.loadSnapshot(entry.configuration);
    },

    async factory_action(input) {
      const composition = getComposition();
      const revisionFree = revisionFreeActionRequestSchema.safeParse(input);
      if (!revisionFree.success) return disabledAction(input);
      requireEntry(composition, revisionFree.data.repositoryKey);
      return composition.readOnlyActionExecutor.execute(revisionFree.data);
    },

    factory_repositories(input) {
      return getComposition().listRepositories(input.selectedRepositoryKey);
    },

    async factory_settings(input) {
      const composition = getComposition();
      requireEntry(composition, input.repositoryKey);
      return composition.getSettingsProjection(input.repositoryKey);
    },

    async factory_health(input) {
      const composition = getComposition();
      requireEntry(composition, input.repositoryKey);
      const [providersResult, hostResult] = await Promise.allSettled([
        composition.healthReader.listProviderStatus(input.repositoryKey),
        composition.healthReader.getHostPreflight(input.repositoryKey),
      ]);
      return {
        repositoryKey: input.repositoryKey,
        providers: providersResult.status === "fulfilled"
          ? providersResult.value
          : [providerReadFailure(providersResult.reason)],
        host: hostResult.status === "fulfilled"
          ? hostResult.value
          : hostReadFailure(input.repositoryKey, hostResult.reason),
      };
    },

    async factory_interactions(input) {
      const composition = getComposition();
      requireEntry(composition, input.repositoryKey);
      return composition.interactionReader.listPendingInteractions(input.repositoryKey);
    },

    async factory_runs(input) {
      const composition = getComposition();
      requireEntry(composition, input.repositoryKey);
      return composition.operationalState.listRuns(input);
    },

    async factory_run_detail(input) {
      const composition = getComposition();
      requireEntry(composition, input.repositoryKey);
      return composition.operationalState.getRun(input);
    },
  };
}

export { factoryRpcContract };
