import type { BbPluginApi, PluginStorage } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  resolveRepositoryRegistry,
  type FactorySettings,
  type RepositoryKey,
  type RegistryOptionsProjection,
  type RepositoryRegistryEntry,
  type RepositoryRegistryResolution,
  type RepositorySelectionProjection,
  type SettingsProjection,
} from "../contracts.js";
import type {
  FactoryHealthReader,
  OperationalStateReader,
  PendingInteractionReader,
  ProtocolReader,
  ReadOnlyActionExecutor,
} from "../ports.js";
import { createPendingInteractionReader } from "../interactions/read.js";
import {
  createConnectedHostDependencyResolver,
  createProtocolReader,
  type ProtocolFiles,
  type ProtocolMergeProjection,
  type ProtocolMergeReader,
} from "../protocol/index.js";
import { ProtocolError } from "../protocol/errors.js";
import { initializeOperationalStorage } from "../storage/index.js";
import { createLiveHealthReader, validateConfiguredEnvironment } from "./live-health.js";
import { createReadOnlyActionExecutor } from "./read-action-composition.js";

type BbSdk = BbPluginApi["sdk"];

export interface ReadCompositionOptions {
  readonly sdk: BbSdk;
  readonly storage?: PluginStorage;
  readonly settings: FactorySettings;
  readonly operationalState?: OperationalStateReader;
}

export interface ReadComposition {
  readonly sdk: BbSdk;
  readonly settings: FactorySettings;
  readonly resolution: RepositoryRegistryResolution;
  readonly operationalState: OperationalStateReader;
  readonly protocolReader: ProtocolReader;
  readonly healthReader: FactoryHealthReader;
  readonly interactionReader: PendingInteractionReader;
  readonly readOnlyActionExecutor: ReadOnlyActionExecutor;
  listRepositories(selectedRepositoryKey?: RepositoryKey | null): RepositorySelectionProjection;
  getRepositoryEntry(repositoryKey: RepositoryKey): RepositoryRegistryEntry | null;
  getSettingsProjection(repositoryKey: RepositoryKey): Promise<SettingsProjection>;
  listRegistryOptions(): Promise<RegistryOptionsProjection>;
}

function configuredEntries(resolution: RepositoryRegistryResolution): readonly RepositoryRegistryEntry[] {
  return resolution.status === "configured" ? resolution.repositories : [];
}

function repositoryLookup(
  entries: readonly RepositoryRegistryEntry[],
): (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null {
  return (repositoryKey) => entries.find((entry) => entry.configuration.repositoryKey === repositoryKey) ?? null;
}

function createProtocolFiles(sdk: BbSdk): ProtocolFiles {
  return {
    read: (args) => sdk.files.read(args),
    listPaths: (args) => sdk.files.listPaths(args),
  };
}

type MergeCommit = ProtocolMergeProjection["taskCommits"][number];

const administrativeCommitSubject = /^factory:\s*(?:claim|release|run\s+record)\b/i;

export function filterTaskCommits(commits: readonly MergeCommit[]): readonly MergeCommit[] {
  return commits.filter((commit) => !administrativeCommitSubject.test(commit.subject.trim()));
}

function createMergeReader(
  sdk: BbSdk,
  lookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null,
): ProtocolMergeReader {
  return {
    async readMergeProjection(configuration): Promise<ProtocolMergeProjection> {
      const entry = lookup(configuration.repositoryKey);
      if (!entry) {
        throw new ProtocolError(
          "merge-state-unavailable",
          `No configured BB environment is available for repository '${configuration.repositoryKey}'.`,
          { repositoryKey: configuration.repositoryKey },
        );
      }

      const environmentId = entry.environmentId;
      if (environmentId === undefined) {
        // No registered environment to read merge state from. An unmanaged
        // entry still gets a usable snapshot: the commit is honestly unknown
        // and fast-forward is conservatively unsafe until the first dispatch
        // registers an environment for the checkout path.
        return {
          gitCommit: null,
          factoryAhead: 0,
          mainBehind: 0,
          taskCommits: [],
          safeFastForward: false,
        };
      }

      try {
        await validateConfiguredEnvironment(sdk, entry);
      } catch (error) {
        throw new ProtocolError(
          "merge-state-unavailable",
          `Configured BB environment is not valid for repository '${configuration.repositoryKey}': ${error instanceof Error ? error.message : String(error)}`,
          { repositoryKey: configuration.repositoryKey, cause: error },
        );
      }

      const status = await sdk.environments.status({
        environmentId,
        mergeBaseBranch: configuration.mainRef,
      });
      if (status.outcome !== "available") {
        const message = status.outcome === "unavailable" ? status.failure.message : status.message;
        throw new ProtocolError(
          "merge-state-unavailable",
          `Could not read merge state for repository '${configuration.repositoryKey}': ${message}`,
          { repositoryKey: configuration.repositoryKey, path: "plans/README.md" },
        );
      }

      const checkout = status.workspace.checkout;
      const gitCommit = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
      const mergeBase = status.workspace.mergeBase;
      return {
        gitCommit,
        factoryAhead: mergeBase?.aheadCount ?? 0,
        mainBehind: mergeBase?.behindCount ?? 0,
        taskCommits: filterTaskCommits(mergeBase?.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })) ?? []),
        safeFastForward:
          mergeBase !== null &&
          mergeBase.behindCount === 0 &&
          status.workspace.workingTree.state === "clean",
      };
    },
  };
}

function activeRun(status: string): boolean {
  return status === "pending" || status === "started" || status === "cancel-requested" || status === "reconciliation-required";
}

async function countActiveRuns(
  operationalState: OperationalStateReader,
  repositoryKey: RepositoryKey,
): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await operationalState.listRuns({ repositoryKey, cursor, limit: 100 });
    count += page.runs.filter((run) => activeRun(run.status)).length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return count;
}

function omitUndefinedObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefinedObjectFields);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, omitUndefinedObjectFields(child)]),
    );
  }
  return value;
}

function settingsProjection(
  settings: FactorySettings,
  entry: RepositoryRegistryEntry,
  activeRunCount: number,
): SettingsProjection {
  const repositorySettings = omitUndefinedObjectFields({
    ...settings,
    repositoryKey: entry.configuration.repositoryKey,
    repositoryRoot: entry.configuration.repositoryRoot,
    connectedHostId: entry.configuration.connectedHostId,
    checkoutPath: entry.configuration.checkoutPath,
    projectId: entry.projectId,
    environmentId: entry.environmentId,
  }) as FactorySettings;
  const repositoryPaused = entry.dispatchPaused === true;
  const accepting =
    settings.dispatchMode === "enabled" && !repositoryPaused && activeRunCount < settings.concurrencyLimit;
  return {
    settings: repositorySettings,
    validation: { valid: true, fieldErrors: {} },
    dispatch: {
      mode: settings.dispatchMode,
      repositoryPaused,
      acceptingNewRuns: accepting,
      activeRunCount,
      reason: settings.dispatchMode !== "enabled"
        ? "Dispatch is paused."
        : repositoryPaused
          ? "Dispatch is paused for this repository."
          : accepting
            ? "Dispatch is enabled."
            : "The concurrency limit is reached.",
    },
  };
}

export function createReadComposition(options: ReadCompositionOptions): ReadComposition {
  const settings = factorySettingsSchema.parse(options.settings);
  const resolution = resolveRepositoryRegistry(settings);
  const entries = configuredEntries(resolution);
  const lookupEntry = repositoryLookup(entries);
  const files = createProtocolFiles(options.sdk);
  const protocolRegistry = {
    listRepositories: () => entries.map((entry) => entry.configuration),
  };
  const protocolReader = createProtocolReader(files, {
    mergeReader: createMergeReader(options.sdk, lookupEntry),
    dependencyResolver: createConnectedHostDependencyResolver({
      files,
      repositoryRegistry: protocolRegistry,
    }),
    canonicalDashboardUrl: null,
  });
  const operationalState = options.operationalState ?? (options.storage ? initializeOperationalStorage(options.storage) : null);
  if (!operationalState) {
    throw new Error("Read composition requires the BB operational storage adapter or an injected operational reader.");
  }
  const interactionReader = createPendingInteractionReader({
    sdk: options.sdk,
    repositoryConfigLookup: async (repositoryKey) => {
      const entry = lookupEntry(repositoryKey);
      return entry
        ? { repositoryKey, projectId: entry.projectId, environmentId: entry.environmentId ?? null }
        : null;
    },
  });
  const healthReader = createLiveHealthReader({
    sdk: options.sdk,
    repositoryLookup: lookupEntry,
  });
  const readOnlyActionExecutor = createReadOnlyActionExecutor({
    protocolReader,
    repositoryLookup: lookupEntry,
  });

  return {
    sdk: options.sdk,
    settings,
    resolution,
    operationalState,
    protocolReader,
    healthReader,
    interactionReader,
    readOnlyActionExecutor,
    listRepositories(selectedRepositoryKey) {
      if (resolution.status !== "configured") {
        return { repositories: [], selectedRepositoryKey: null };
      }
      const selected = selectedRepositoryKey === undefined || selectedRepositoryKey === null
        ? resolution.selectedRepositoryKey
        : entries.some((entry) => entry.configuration.repositoryKey === selectedRepositoryKey)
          ? selectedRepositoryKey
          : null;
      const selectionIssue = selectedRepositoryKey !== undefined &&
        selectedRepositoryKey !== null &&
        !entries.some((entry) => entry.configuration.repositoryKey === selectedRepositoryKey)
        ? `Requested repository '${selectedRepositoryKey}' is not present in the configured registry.`
        : null;
      return {
        repositories: entries.map((entry) => ({
          configuration: entry.configuration,
          projectId: entry.projectId,
          environmentId: entry.environmentId ?? null,
          dispatchPaused: entry.dispatchPaused === true,
          ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
          selected: entry.configuration.repositoryKey === selected,
          available: true,
          reasons: selectionIssue ? [selectionIssue] : [],
        })),
        selectedRepositoryKey: selected,
      };
    },
    getRepositoryEntry(repositoryKey) {
      return lookupEntry(repositoryKey);
    },
    async getSettingsProjection(repositoryKey) {
      const entry = lookupEntry(repositoryKey);
      if (!entry) {
        throw new Error(`Repository '${repositoryKey}' is not configured.`);
      }
      return settingsProjection(settings, entry, await countActiveRuns(operationalState, repositoryKey));
    },
    async listRegistryOptions() {
      const [hostsResult, projectsResult] = await Promise.allSettled([
        options.sdk.hosts.list(),
        options.sdk.projects.list(),
      ]);
      return {
        hosts: hostsResult.status === "fulfilled"
          ? hostsResult.value.map((host) => ({ hostId: host.id, label: host.name, status: host.status }))
          : [],
        projects: projectsResult.status === "fulfilled"
          ? projectsResult.value.map((project) => ({ projectId: project.id, label: project.name }))
          : [],
      } satisfies RegistryOptionsProjection;
    },
  };
}
