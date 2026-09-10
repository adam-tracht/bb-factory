import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  providerIdSchema,
  reasoningLevelSchema,
  type HostPreflight,
  type ProviderStatus,
  type RepositoryRegistryEntry,
  type RepositoryKey,
} from "../contracts.js";
import type { FactoryHealthReader } from "../ports.js";
import { normalizeAbsolutePath } from "../protocol/files.js";

type BbSdk = BbPluginApi["sdk"];
type ExecutionOptions = Awaited<ReturnType<BbSdk["system"]["executionOptions"]>>;
type ProviderInfo = Awaited<ReturnType<BbSdk["providers"]["list"]>>[number];
type ProviderModel = ExecutionOptions["models"][number];
type ProviderState = Awaited<ReturnType<BbSdk["system"]["providerStates"]>>["providers"][number];
type ProviderUsage = Awaited<ReturnType<BbSdk["system"]["usageLimits"]>>[string];
type UsageWindow = Extract<ProviderUsage, { status: "ok" }>["windows"][number];
type HostInfo = Awaited<ReturnType<BbSdk["hosts"]["get"]>>;
type Environment = Awaited<ReturnType<BbSdk["environments"]["get"]>>;

export interface LiveHealthOptions {
  readonly sdk: BbSdk;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

export async function validateConfiguredEnvironment(
  sdk: BbSdk,
  entry: RepositoryRegistryEntry,
): Promise<Environment> {
  const environment = await sdk.environments.get({ environmentId: entry.environmentId });
  if (environment.id !== entry.environmentId) {
    throw new Error(`BB returned environment '${environment.id}', expected '${entry.environmentId}'.`);
  }
  if (environment.projectId !== entry.projectId) {
    throw new Error(
      `Configured environment '${entry.environmentId}' belongs to project '${environment.projectId}', expected '${entry.projectId}'.`,
    );
  }
  if (environment.hostId !== entry.configuration.connectedHostId) {
    throw new Error(
      `Configured environment '${entry.environmentId}' belongs to host '${environment.hostId}', expected '${entry.configuration.connectedHostId}'.`,
    );
  }
  if (!environment.path) {
    throw new Error(`Configured environment '${entry.environmentId}' has no checkout path.`);
  }
  const configuredPath = normalizeAbsolutePath(entry.configuration.checkoutPath, "checkoutPath");
  const environmentPath = normalizeAbsolutePath(environment.path, "environment.path");
  if (environmentPath !== configuredPath) {
    throw new Error(
      `Configured environment '${entry.environmentId}' is rooted at '${environmentPath}', expected checkout '${configuredPath}'.`,
    );
  }
  return environment;
}

function currentModel(executionOptions: ExecutionOptions, providerId: string): ProviderModel | null {
  const selected = executionOptions.selectedOnlyModels.filter((model) => model.routeProviderId === providerId);
  const catalog = executionOptions.models.filter((model) => model.routeProviderId === providerId);
  return selected.find((model) => model.isDefault)
    ?? (selected.length === 1 ? selected[0] : null)
    ?? catalog.find((model) => model.isDefault)
    ?? (catalog.length === 1 ? catalog[0] : null)
    ?? null;
}

function validTimestamp(value: string | null): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function exhaustedUsageWindows(usage: ProviderUsage): readonly UsageWindow[] {
  return usage.status === "ok" ? usage.windows.filter((window) => window.usedPercent >= 100) : [];
}

function quotaLimit(usage: ProviderUsage): string | null {
  const exhausted = exhaustedUsageWindows(usage)
    .map((window) => validTimestamp(window.resetsAt))
    .filter((value): value is string => value !== null)
    .sort();
  return exhausted[0] ?? null;
}

function usageError(usage: ProviderUsage | undefined): string | null {
  if (!usage || usage.status === "ok") return null;
  if (usage.status === "error") return usage.message;
  return `Provider usage state is ${usage.status}.`;
}

function providerStatus(
  providerId: string,
  provider: ProviderInfo | undefined,
  executionOptions: ExecutionOptions,
  providerState: ProviderState | undefined,
  usage: ProviderUsage | undefined,
  activeThreadCounts: ReadonlyMap<string, number>,
): ProviderStatus {
  const parsedProviderId = providerIdSchema.parse(providerId);
  const model = currentModel(executionOptions, providerId);
  const reasoningLevel = reasoningLevelSchema.safeParse(model?.defaultReasoningEffort);
  const modelLoadError = executionOptions.modelLoadError?.providerId === providerId
    ? `Could not load the configured model (${executionOptions.modelLoadError.code}).`
    : null;
  const stateError = providerState?.statusMessage
    ?? (providerState && providerState.status !== "ready" ? `Provider state is ${providerState.status}.` : null);
  const lastError = modelLoadError ?? stateError ?? usageError(usage);
  const limitedUntil = usage ? quotaLimit(usage) : null;
  const quotaExhausted = usage !== undefined && exhaustedUsageWindows(usage).length > 0;
  const usageUnavailable = usage !== undefined && usage.status !== "ok";
  const unavailable = provider?.available === false
    || modelLoadError !== null
    || providerState?.status === "not_installed"
    || providerState?.status === "unauthenticated"
    || providerState?.status === "expired"
    || providerState?.status === "unsupported_version"
    || usageUnavailable
    || model === null;
  const unknown = !unavailable && (
    provider === undefined
    || providerState === undefined
    || providerState.status === "unknown"
  );
  const availability = unavailable
    ? "unavailable"
    : quotaExhausted
      ? "limited"
      : unknown
        ? "unknown"
        : "available";
  return {
    providerId: parsedProviderId,
    model: model?.model ?? "unavailable",
    reasoningLevel: reasoningLevel.success ? reasoningLevel.data : "none",
    availability,
    limitedUntil,
    activeThreadCount: activeThreadCounts.get(parsedProviderId) ?? 0,
    lastError,
  };
}

async function readActiveThreadCounts(sdk: BbSdk, hostId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const statuses = ["starting", "active"] as const;
  const results = await Promise.all(statuses.map((status) => sdk.threads.count({ groupBy: "provider", hostId, status })));
  for (const result of results) {
    for (const group of result.groups ?? []) {
      if (group.key !== null) counts.set(group.key, (counts.get(group.key) ?? 0) + group.count);
    }
  }
  return counts;
}

function hostStatus(host: HostInfo | null): HostPreflight["status"] {
  if (!host) return "unknown";
  return host.status === "connected" ? "online" : "offline";
}

function selectHost(host: HostInfo | null, hosts: readonly HostInfo[], hostId: string): HostInfo | null {
  return host ?? hosts.find((candidate) => candidate.id === hostId) ?? null;
}

async function readHostPreflight(
  sdk: BbSdk,
  entry: RepositoryRegistryEntry,
  hostId: string,
): Promise<HostPreflight> {
  const configuration = entry.configuration;
  const [hostResult, hostsResult] = await Promise.allSettled([
    sdk.hosts.get({ hostId }),
    sdk.hosts.list(),
  ]);
  const environmentResult = await Promise.allSettled([
    validateConfiguredEnvironment(sdk, entry).then(() => sdk.environments.status({ environmentId: entry.environmentId })),
  ]).then(([result]) => result);

  const host = hostResult.status === "fulfilled" ? hostResult.value : null;
  const hosts = hostsResult.status === "fulfilled" ? hostsResult.value : [];
  const selectedHost = selectHost(host, hosts, hostId);
  const status = hostStatus(selectedHost);
  const reasons: string[] = [];

  if (hostResult.status === "rejected" && hostsResult.status === "rejected") {
    reasons.push(`Could not read BB host '${hostId}': ${errorMessage(hostResult.reason)}`);
  } else if (!selectedHost) {
    reasons.push(`BB host '${hostId}' was not found.`);
  } else if (status !== "online") {
    reasons.push(`BB host '${hostId}' is disconnected.`);
  }

  let checkoutExists = false;
  let branch: string | null = null;
  if (environmentResult.status === "fulfilled") {
    const environment = environmentResult.value;
    if (environment.outcome === "available") {
      checkoutExists = status === "online";
      branch = environment.workspace.branch.currentBranch;
      if (branch !== configuration.factoryBranch) {
        reasons.push(`Configured checkout is on '${branch ?? "no branch"}', expected '${configuration.factoryBranch}'.`);
      }
    } else if (environment.outcome === "unavailable") {
      reasons.push(`BB could not inspect the configured checkout: ${environment.failure.message}`);
    } else {
      reasons.push(`Configured environment is not a Git checkout: ${environment.message}`);
    }
  } else {
    reasons.push(`Could not inspect the configured checkout: ${errorMessage(environmentResult.reason)}`);
  }

  return {
    hostId,
    status,
    checkoutExists,
    branch,
    requiredTools: {},
    browserAvailable: null,
    dbtStudioAvailable: null,
    ok: status === "online" && checkoutExists && branch === configuration.factoryBranch,
    reasons,
  };
}

export function createLiveHealthReader(options: LiveHealthOptions): FactoryHealthReader {
  return {
    async listProviderStatus(repositoryKey) {
      const entry = options.repositoryLookup(repositoryKey);
      if (!entry) throw new Error(`Repository '${repositoryKey}' is not configured.`);
      const configuration = entry.configuration;

      try {
        const [providers, executionOptions, providerStates, usageLimits, activeThreadCounts] = await Promise.all([
          options.sdk.providers.list({ hostId: configuration.connectedHostId }),
          options.sdk.system.executionOptions({ hostId: configuration.connectedHostId }),
          options.sdk.system.providerStates({ hostId: configuration.connectedHostId }),
          options.sdk.system.usageLimits({ hostId: configuration.connectedHostId }),
          readActiveThreadCounts(options.sdk, configuration.connectedHostId),
        ]);
        const states = new Map(providerStates.providers.map((state) => [state.providerId, state]));
        const providerIds = new Set([
          ...providers.map((provider) => provider.id),
          ...executionOptions.providers.map((provider) => provider.id),
          ...providerStates.providers.map((state) => state.providerId),
          ...Object.keys(usageLimits),
          ...(executionOptions.modelLoadError ? [executionOptions.modelLoadError.providerId] : []),
        ]);
        return [...providerIds].map((providerId) => providerStatus(
          providerId,
          providers.find((provider) => provider.id === providerId),
          executionOptions,
          states.get(providerId),
          usageLimits[providerId],
          activeThreadCounts,
        ));
      } catch (error) {
        throw new Error(
          `Could not read live provider health for repository '${repositoryKey}': ${errorMessage(error)}`,
          { cause: error },
        );
      }
    },

    async getHostPreflight(repositoryKey) {
      const entry = options.repositoryLookup(repositoryKey);
      if (!entry) throw new Error(`Repository '${repositoryKey}' is not configured.`);
      return readHostPreflight(options.sdk, entry, entry.configuration.connectedHostId);
    },
  };
}
