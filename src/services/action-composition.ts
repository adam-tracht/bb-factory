import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  BbInteractionActionExecutor,
  ProvisionCheckoutActionExecutor,
  RepositoryActionExecutor,
  ScaffoldProtocolActionExecutor,
} from "../ports.js";
import type { RepositoryKey } from "../contracts.js";
import { createBbInteractionActionExecutor } from "../actions/interactions.js";
import { createProvisionCheckoutActionExecutor } from "../actions/provision.js";
import { createRepositoryActionExecutor } from "../actions/repository.js";
import { createScaffoldProtocolActionExecutor } from "../actions/scaffold.js";
import { createDispatchEngine, type DispatchEngine } from "../dispatch/index.js";
import type { DispatchContext } from "../dispatch/types.js";
import { createScheduler, type SchedulerTickResult } from "../schedule/index.js";
import type { OperationalStateStore } from "../storage/index.js";
import type { ReadComposition } from "./read-composition.js";

type BbSdk = BbPluginApi["sdk"];

export interface ActionCompositionOptions {
  readonly sdk: BbSdk;
  readonly composition: ReadComposition;
  readonly store: OperationalStateStore;
  readonly setDispatchMode: (mode: "enabled" | "paused") => Promise<void>;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface ActionComposition {
  readonly repositoryActionExecutor: RepositoryActionExecutor;
  readonly bbInteractionActionExecutor: BbInteractionActionExecutor;
  readonly scaffoldProtocolActionExecutor: ScaffoldProtocolActionExecutor;
  readonly provisionCheckoutActionExecutor: ProvisionCheckoutActionExecutor;
  readonly dispatchEngine: DispatchEngine;
  readonly dispatchContext: DispatchContext;
  readonly scheduler: { tick(): Promise<SchedulerTickResult[]> };
}

/** The combined read + action surface used by the plugin entry point. */
export interface FactoryComposition extends ReadComposition, ActionComposition {}

export function createActionComposition(options: ActionCompositionOptions): ActionComposition {
  const { sdk, composition, store, setDispatchMode } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log;
  const configuredKeys = (): RepositoryKey[] =>
    composition.resolution.status === "configured"
      ? composition.resolution.repositories.map((entry) => entry.configuration.repositoryKey)
      : [];

  const dispatchContext: DispatchContext = {
    sdk: { threads: sdk.threads, files: sdk.files },
    store,
    protocolReader: composition.protocolReader,
    healthReader: composition.healthReader,
    tasksIntegration: composition.tasksIntegration,
    repositoryLookup: (repositoryKey) => composition.getRepositoryEntry(repositoryKey),
    settings: composition.settings,
    now,
    log,
  };
  const dispatchEngine = createDispatchEngine(dispatchContext, configuredKeys);
  const scheduler = createScheduler(dispatchContext, configuredKeys);

  const repositoryActionExecutor = createRepositoryActionExecutor({
    files: {
      read: (args) => sdk.files.read(args),
      listPaths: (args) => sdk.files.listPaths(args),
      write: (args) => sdk.files.write(args),
    },
    store,
    protocolReader: composition.protocolReader,
    repositoryLookup: (repositoryKey) => composition.getRepositoryEntry(repositoryKey as RepositoryKey)?.configuration ?? null,
    now,
  });

  const scaffoldProtocolActionExecutor = createScaffoldProtocolActionExecutor({
    sdk,
    store,
    repositoryLookup: (repositoryKey) => composition.getRepositoryEntry(repositoryKey as RepositoryKey),
    now,
  });

  const provisionCheckoutActionExecutor = createProvisionCheckoutActionExecutor({
    sdk,
    store,
    repositoryLookup: (repositoryKey) => composition.getRepositoryEntry(repositoryKey as RepositoryKey),
    now,
  });

  const bbInteractionActionExecutor = createBbInteractionActionExecutor({
    threads: sdk.threads,
    store,
    interactionReader: composition.interactionReader,
    protocolReader: composition.protocolReader,
    repositoryLookup: (repositoryKey) => composition.getRepositoryEntry(repositoryKey),
    dispatch: dispatchEngine,
    setDispatchMode,
  });

  return {
    repositoryActionExecutor,
    bbInteractionActionExecutor,
    scaffoldProtocolActionExecutor,
    provisionCheckoutActionExecutor,
    dispatchEngine,
    dispatchContext,
    scheduler,
  };
}

export function createFactoryComposition(
  read: ReadComposition,
  action: ActionComposition,
): FactoryComposition {
  return { ...read, ...action };
}
