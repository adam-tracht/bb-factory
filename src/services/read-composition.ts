import type { BbPluginApi, PluginStorage } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  resolveRepositoryRegistry,
  type FactorySettings,
  type RepositoryKey,
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
        environmentId: entry.environmentId,
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

function settingsProjection(settings: FactorySettings, activeRunCount: number): SettingsProjection {
  return {
    settings,
    validation: { valid: true, fieldErrors: {} },
    dispatch: {
      mode: settings.dispatchMode,
      acceptingNewRuns: false,
      activeRunCount,
      reason: "P1 read-only integration keeps dispatch, schedulers, and workers disabled.",
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
        ? { repositoryKey, projectId: entry.projectId, environmentId: entry.environmentId }
        : null;
    },
  });
  const healthReader = createLiveHealthReader({
    sdk: options.sdk,
    repositoryLookup: lookupEntry,
  });
  const readOnlyActionExecutor = createReadOnlyActionExecutor({
    protocolReader,
    repositoryLookup: (repositoryKey) => lookupEntry(repositoryKey)?.configuration ?? null,
  });

  return {
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
      if (!lookupEntry(repositoryKey)) {
        throw new Error(`Repository '${repositoryKey}' is not configured.`);
      }
      return settingsProjection(settings, await countActiveRuns(operationalState, repositoryKey));
    },
  };
}
