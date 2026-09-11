import type {
  FactoryActionResult,
  BbInteractionActionRequest,
  HostPreflight,
  OperationalRunDetailInput,
  OperationalRunDetailProjection,
  OperationalRunListInput,
  OperationalRunListProjection,
  ProviderStatus,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  ProvisionCheckoutActionRequest,
  RepositoryConfiguration,
  RepositoryKey,
  RepositoryActionRequest,
  RevisionFreeActionRequest,
  ScaffoldProtocolActionRequest,
} from "./contracts.js";

export interface ProtocolReader {
  loadSnapshot(configuration: RepositoryConfiguration): Promise<ProtocolSnapshot>;
}

export interface OperationalStateReader {
  listRuns(input: OperationalRunListInput): Promise<OperationalRunListProjection>;
  getRun(input: OperationalRunDetailInput): Promise<OperationalRunDetailProjection>;
}

export interface FactoryHealthReader {
  listProviderStatus(repositoryKey: RepositoryKey): Promise<ProviderStatus[]>;
  getHostPreflight(repositoryKey: RepositoryKey): Promise<HostPreflight>;
}

export interface PendingInteractionReader {
  listPendingInteractions(repositoryKey: RepositoryKey): Promise<PendingInteractionsProjection>;
}

export interface ReadOnlyActionExecutor {
  execute(request: RevisionFreeActionRequest): Promise<FactoryActionResult>;
}

export interface RepositoryActionExecutor {
  execute(request: RepositoryActionRequest): Promise<FactoryActionResult>;
}

export interface BbInteractionActionExecutor {
  execute(request: BbInteractionActionRequest): Promise<FactoryActionResult>;
}

export interface ScaffoldProtocolActionExecutor {
  execute(request: ScaffoldProtocolActionRequest): Promise<FactoryActionResult>;
}

export interface ProvisionCheckoutActionExecutor {
  execute(request: ProvisionCheckoutActionRequest): Promise<FactoryActionResult>;
}
