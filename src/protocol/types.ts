import type {
  DashboardSummary,
  ForemanOutcome,
  ProtocolSnapshot,
  RepositoryConfiguration,
} from "../contracts.js";
import type { RepositoryDiscoveryOptions } from "./discovery.js";
import type { ProtocolFiles } from "./files.js";

export interface DashboardRowProjection {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly nextAction: string;
  readonly evidence: string;
}

export interface CanonicalDashboardProjection {
  readonly relativePath: "plans/README.md";
  readonly content: string;
  readonly sha256: string;
  readonly rows: readonly DashboardRowProjection[];
  readonly url: string | null;
}

export interface ImmutableRunRecord {
  readonly relativePath: string;
  readonly content: string;
  readonly sha256: string;
  readonly state: ForemanOutcome | null;
}

export interface ProtocolMergeProjection {
  readonly gitCommit: string | null;
  readonly factoryAhead: number;
  readonly mainBehind: number;
  readonly taskCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly safeFastForward: boolean;
}

export interface ProtocolMergeReader {
  readMergeProjection(configuration: import("../contracts.js").RepositoryConfiguration): Promise<ProtocolMergeProjection>;
}

export interface ProtocolRepositoryPolicy {
  readonly qualifiedDependencies: readonly {
    readonly repositoryKey: string;
    readonly dashboardRequirement: "done" | "done-with-evidence";
    readonly allowNamedDeliverableEvidence: boolean;
  }[];
}

export interface ProtocolDependencySource {
  readonly id: string;
  readonly title: string;
  readonly planPath: string;
  readonly acceptance: readonly string[];
  readonly validate: readonly string[];
  readonly notes: string | null;
}

export interface ProtocolDependencyResolverInput {
  readonly sourceConfiguration: import("../contracts.js").RepositoryConfiguration;
  readonly sourceEntry: ProtocolDependencySource;
  readonly dependency: string;
  readonly policy: ProtocolRepositoryPolicy;
}

export interface ProtocolDependencyResolver {
  resolveDependency(input: ProtocolDependencyResolverInput): Promise<boolean>;
}

export interface ProtocolRepositoryRegistry {
  listRepositories(): readonly RepositoryConfiguration[] | Promise<readonly RepositoryConfiguration[]>;
}

export type ProtocolRepositoryLookup = (
  repositoryKey: string,
) => RepositoryConfiguration | null | Promise<RepositoryConfiguration | null>;

export interface ConnectedHostDependencyResolverOptions {
  readonly files: ProtocolFiles;
  readonly repositoryRegistry?: ProtocolRepositoryRegistry;
  readonly repositoryLookup?: ProtocolRepositoryLookup;
  readonly signal?: AbortSignal;
  /** Optional migration input. Runtime callers should inject registry or lookup. */
  readonly repositoryDiscovery?: RepositoryDiscoveryOptions;
}

export interface ProtocolReaderOptions {
  readonly mergeReader?: ProtocolMergeReader;
  readonly dependencyResolver?: ProtocolDependencyResolver;
  readonly canonicalDashboardUrl?: string | null;
  readonly now?: () => Date;
}

export interface ProtocolProjection {
  readonly snapshot: ProtocolSnapshot;
  readonly dashboard: CanonicalDashboardProjection;
  readonly runRecords: readonly ImmutableRunRecord[];
  readonly lock: { readonly content: string; readonly sha256: string } | null;
}

export type ProtocolDashboardSummary = DashboardSummary;
