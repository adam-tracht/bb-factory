import type {
  AddRepositoryInput,
  BbInteractionActionRequest,
  FactoryActionRequest,
  FactoryActionResult,
  FactorySettingsPatch,
  PickFolderInput,
  PickFolderResult,
  ProbeRepositoryInput,
  RegistryOptionsProjection,
  RepositoryActionRequest,
  RepositoryConfiguration,
  RepositoryKey,
  RepositoryProbe,
  RepositoryRevision,
  ResolveProjectInput,
  ResolveProjectResult,
  SettingsMutationResult,
  UpdateRepositoryInput,
} from "../contracts.js";
import type { ActionFeedback, FileLinkRenderer } from "./primitives.js";
import type { TasksIntegrationMode } from "../tasks/index.js";

export type FactorySection = "overview" | "work" | "questions" | "runs" | "settings";

/** Non-tab routes rendered outside the per-repository section tabs. */
export type FactoryRoute = FactorySection | "repositories" | "add-repository";

export type FactoryAction = RepositoryActionRequest["action"] | BbInteractionActionRequest["action"];

/**
 * The frozen context every section view receives. Views never call RPCs
 * directly; mutations go through onAction (guarded repository/dispatch
 * actions) or the settings mutation helpers.
 */
export interface ViewContext {
  /** Prefix for row DOM ids when multiple repositories share a view. */
  readonly idPrefix?: string;
  readonly repository: RepositoryConfiguration;
  /** Optional presentation name; repository.repositoryKey remains identity. */
  readonly displayName?: string;
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly tasksIntegration?: TasksIntegrationMode;
  readonly dispatchPaused: boolean;
  readonly revision: RepositoryRevision | null;
  readonly fileLink?: FileLinkRenderer;
  readonly feedback: ActionFeedback | null;
  readonly pendingTarget: string | null;
  onOpenSection(section: FactorySection, anchor?: string): void;
  onOpenRepository(repositoryKey: RepositoryKey, section?: FactorySection, anchor?: string): void;
  onOpenRun(runId: string): void;
  onOpenThread(threadId: string): void;
  onOpenProject(projectId: string): void;
  onAction(action: FactoryAction): void;
  updateSettings(patch: FactorySettingsPatch): Promise<SettingsMutationResult>;
  updateRepository(input: UpdateRepositoryInput): Promise<SettingsMutationResult>;
  addRepository(input: AddRepositoryInput): Promise<SettingsMutationResult>;
  loadRegistryOptions(): Promise<RegistryOptionsProjection>;
  /**
   * Result-returning variant of onAction for multi-step flows (the add wizard
   * orchestrates provision and scaffold itself; onAction is fire-and-forget
   * shell feedback). Failed transports surface as internal-error results.
   */
  runAction(request: FactoryActionRequest): Promise<FactoryActionResult>;
  pickRepositoryFolder(input: PickFolderInput): Promise<PickFolderResult>;
  probeRepository(input: ProbeRepositoryInput): Promise<RepositoryProbe>;
  resolveRepositoryProject(input: ResolveProjectInput): Promise<ResolveProjectResult>;
}
