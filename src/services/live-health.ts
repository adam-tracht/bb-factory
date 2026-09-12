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
import { errorMessage } from "../errors.js";
import { normalizeAbsolutePath } from "../protocol/files.js";

type BbSdk = BbPluginApi["sdk"];
type ProviderModelsResult = Awaited<ReturnType<BbSdk["providers"]["models"]>>;
type ExecutionOptions = ProviderModelsResult;
type ProviderInfo = Awaited<ReturnType<BbSdk["providers"]["list"]>>[number];
type ProviderModel = ExecutionOptions["models"][number];
type ProviderState = Awaited<ReturnType<BbSdk["system"]["providerStates"]>>["providers"][number];
type ProviderUsage = Awaited<ReturnType<BbSdk["system"]["usageLimits"]>>[string];
type UsageWindow = Extract<ProviderUsage, { status: "ok" }>["windows"][number];
type HostInfo = Awaited<ReturnType<BbSdk["hosts"]["list"]>>[number];
type Environment = Awaited<ReturnType<BbSdk["environments"]["get"]>>;

export interface LiveHealthOptions {
  readonly sdk: BbSdk;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
}

export async function validateConfiguredEnvironment(
  sdk: BbSdk,
  entry: RepositoryRegistryEntry,
): Promise<Environment> {
  const environmentId = entry.environmentId;
  if (environmentId === undefined) {
    throw new Error(`Repository '${entry.configuration.repositoryKey}' has no configured BB environment.`);
  }
  const environment = await sdk.environments.get({ environmentId });
  if (environment.id !== environmentId) {
    throw new Error(`BB returned environment '${environment.id}', expected '${environmentId}'.`);
  }
  if (environment.projectId !== entry.projectId) {
    throw new Error(
      `Configured environment '${environmentId}' belongs to project '${environment.projectId}', expected '${entry.projectId}'.`,
    );
  }
  if (environment.hostId !== entry.configuration.connectedHostId) {
    throw new Error(
      `Configured environment '${environmentId}' belongs to host '${environment.hostId}', expected '${entry.configuration.connectedHostId}'.`,
    );
  }
  if (!environment.path) {
    throw new Error(`Configured environment '${environmentId}' has no checkout path.`);
  }
  const configuredPath = normalizeAbsolutePath(entry.configuration.checkoutPath, "checkoutPath");
  const environmentPath = normalizeAbsolutePath(environment.path, "environment.path");
  if (environmentPath !== configuredPath) {
    throw new Error(
      `Configured environment '${environmentId}' is rooted at '${environmentPath}', expected checkout '${configuredPath}'.`,
    );
  }
  return environment;
}

function currentModel(executionOptions: ExecutionOptions, providerId: string): ProviderModel | null {
  const scoped = (model: ProviderModel) => model.routeProviderId === undefined || model.routeProviderId === providerId;
  const selected = executionOptions.selectedOnlyModels.filter(scoped);
  const catalog = executionOptions.models.filter(scoped);
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
  catalog: ProviderModelsResult | null,
  providerState: ProviderState | undefined,
  usage: ProviderUsage | undefined,
  activeThreadCounts: ReadonlyMap<string, number>,
): ProviderStatus {
  const parsedProviderId = providerIdSchema.parse(providerId);
  const model = catalog ? currentModel(catalog, providerId) : null;
  const reasoningLevel = reasoningLevelSchema.safeParse(model?.defaultReasoningEffort);
  const modelLoadError = catalog === null
    ? "Could not load the provider model catalog."
    : catalog.modelLoadError !== null
      ? `Could not load the configured model (${catalog.modelLoadError.code}).`
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
  const permissionModes = provider?.capabilities?.permissionModes;
  return {
    providerId: parsedProviderId,
    model: model?.model ?? "unavailable",
    reasoningLevel: reasoningLevel.success ? reasoningLevel.data : "none",
    availability,
    limitedUntil,
    activeThreadCount: activeThreadCounts.get(parsedProviderId) ?? 0,
    lastError,
    ...(permissionModes === undefined ? {} : { permissionModes: [...permissionModes] }),
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

function branchDriftReason(factoryBranch: string, branch: string | null): string {
  return `Configured checkout is on '${branch ?? "no branch"}', expected '${factoryBranch}'. If the '${factoryBranch}' branch does not exist yet, initialize the factory protocol and create it first (the protocol scaffolder action covers both).`;
}

const GIT_HEAD_REF = /^ref:\s*refs\/heads\/(.+?)\s*$/m;

/**
 * Reads the checked-out branch through the host file API: `.git/HEAD` for a
 * plain checkout, or the worktree's gitdir pointer followed by its HEAD for a
 * linked worktree. Detached HEAD yields null.
 */
export async function readCheckoutBranch(sdk: Pick<BbSdk, "files">, hostId: string, root: string): Promise<string | null> {
  const dotgit = `${root}/.git`;
  let head: string | null = null;
  try {
    head = (await sdk.files.read({ hostId, path: `${dotgit}/HEAD` })).content;
  } catch {
    try {
      const pointer = (await sdk.files.read({ hostId, path: dotgit })).content;
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
      if (gitdir !== undefined) {
        const resolved = /^(?:\/|[A-Za-z]:[\\/])/.test(gitdir) ? gitdir : `${root}/${gitdir}`;
        head = (await sdk.files.read({ hostId, path: `${resolved}/HEAD` })).content;
      }
    } catch {
      head = null;
    }
  }
  if (head === null) return null;
  return GIT_HEAD_REF.exec(head.trim())?.[1] ?? null;
}

interface UnmanagedCheckoutProbe {
  readonly pathExists: boolean;
  readonly gitPresent: boolean;
  readonly protocolPresent: boolean;
  readonly branch: string | null;
  readonly error: string | null;
}

/** Host-file checkout probe for an entry with no registered BB environment. */
async function probeUnmanagedCheckout(sdk: BbSdk, hostId: string, checkoutPath: string): Promise<UnmanagedCheckoutProbe> {
  const root = checkoutPath.replace(/[\\/]+$/u, "");
  const dotgit = `${root}/.git`;
  const protocolDir = `${root}/plans/factory`;
  let existence: Record<string, boolean>;
  try {
    existence = (await sdk.hosts.pathsExist({ hostId, paths: [root, dotgit, protocolDir] })).existence;
  } catch (error) {
    return { pathExists: false, gitPresent: false, protocolPresent: false, branch: null, error: errorMessage(error) };
  }
  const pathExists = existence[root] === true;
  const gitPresent = existence[dotgit] === true;
  const branch = pathExists && gitPresent ? await readCheckoutBranch(sdk, hostId, root).catch(() => null) : null;
  return { pathExists, gitPresent, protocolPresent: existence[protocolDir] === true, branch, error: null };
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
  const environmentId = entry.environmentId;
  const environmentResult = environmentId === undefined
    ? null
    : await Promise.allSettled([
        validateConfiguredEnvironment(sdk, entry).then(() => sdk.environments.status({ environmentId })),
      ]).then(([result]) => result);
  const unmanaged = environmentId === undefined
    ? await probeUnmanagedCheckout(sdk, hostId, configuration.checkoutPath)
    : null;

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
  let protocolReady = true;
  if (environmentResult !== null) {
    if (environmentResult.status === "fulfilled") {
      const environment = environmentResult.value;
      if (environment.outcome === "available") {
        checkoutExists = status === "online";
        branch = environment.workspace.branch.currentBranch;
        if (branch !== configuration.factoryBranch) {
          reasons.push(branchDriftReason(configuration.factoryBranch, branch));
        }
      } else if (environment.outcome === "unavailable") {
        reasons.push(`BB could not inspect the configured checkout: ${environment.failure.message}`);
      } else {
        reasons.push(`Configured environment is not a Git checkout: ${environment.message}`);
      }
    } else {
      reasons.push(`Could not inspect the configured checkout: ${errorMessage(environmentResult.reason)}`);
    }
  } else if (unmanaged !== null) {
    if (unmanaged.error !== null) {
      reasons.push(`Could not inspect the configured checkout: ${unmanaged.error}`);
    } else {
      checkoutExists = unmanaged.pathExists && unmanaged.gitPresent;
      branch = unmanaged.branch;
      protocolReady = unmanaged.protocolPresent;
      if (!unmanaged.pathExists) {
        reasons.push(`Configured checkout '${configuration.checkoutPath}' does not exist on host '${hostId}'.`);
      } else if (!unmanaged.gitPresent) {
        reasons.push(`Configured checkout '${configuration.checkoutPath}' is not a Git checkout.`);
      } else if (branch !== configuration.factoryBranch) {
        reasons.push(branchDriftReason(configuration.factoryBranch, branch));
      }
      if (!unmanaged.protocolPresent) {
        reasons.push(`No plans/factory protocol files were found in the checkout; run the protocol scaffolder action to initialize them on '${configuration.factoryBranch}'.`);
      }
    }
    reasons.push("No BB environment is registered for this checkout; the first dispatch registers one for the configured path.");
  }

  return {
    hostId,
    status,
    checkoutExists,
    branch,
    requiredTools: {},
    browserAvailable: null,
    dbtStudioAvailable: null,
    ok: status === "online" && checkoutExists && branch === configuration.factoryBranch && protocolReady,
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
        const [providers, providerStates, usageLimits, activeThreadCounts] = await Promise.all([
          options.sdk.providers.list({ hostId: configuration.connectedHostId }),
          options.sdk.system.providerStates({ hostId: configuration.connectedHostId }),
          options.sdk.system.usageLimits({ hostId: configuration.connectedHostId }),
          readActiveThreadCounts(options.sdk, configuration.connectedHostId),
        ]);
        const states = new Map(providerStates.providers.map((state) => [state.providerId, state]));
        const providerIds = new Set([
          ...providers.map((provider) => provider.id),
          ...providerStates.providers.map((state) => state.providerId),
          ...Object.keys(usageLimits),
        ]);
        const modelCatalogs = await Promise.all(
          [...providerIds].map(async (providerId) => [
            providerId,
            await options.sdk.providers.models({
              hostId: configuration.connectedHostId,
              providerId,
            }).catch(() => null),
          ] as const),
        );
        const catalogByProvider = new Map(modelCatalogs);
        return [...providerIds].map((providerId) => providerStatus(
          providerId,
          providers.find((provider) => provider.id === providerId),
          catalogByProvider.get(providerId) ?? null,
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
