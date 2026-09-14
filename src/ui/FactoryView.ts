import { useCallback, useEffect, useRef, useState } from "react";
import { createElement } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  dispatchStatusSchema,
  factoryActionResultSchema,
  healthProjectionSchema,
  invalidationEventSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  pickFolderResultSchema,
  protocolSnapshotSchema,
  registryOptionsProjectionSchema,
  repositoryProbeSchema,
  repositorySelectionProjectionSchema,
  resolveProjectResultSchema,
  settingsMutationResultSchema,
  settingsProjectionSchema,
  type DispatchStatus,
  type FactoryActionRequest,
  type FactoryActionResult,
  type HealthProjection,
  type OperationalRunDetailProjection,
  type OperationalRunListProjection,
  type OperationalRunSummary,
  type PendingInteractionsProjection,
  type PickFolderInput,
  type ProbeRepositoryInput,
  type ProtocolSnapshot,
  type QueueEntry,
  type RepositorySelection,
  type RepositorySelectionProjection,
  type ResolveProjectInput,
  type SettingsMutationResult,
  type SettingsProjection,
} from "../contracts.js";
import type { FactoryRpcContract } from "../rpc.js";
import { computeAttention, attentionCounts, type AttentionInput, type AttentionItem } from "./attention.js";
import type { FactoryAction, FactorySection, ViewContext } from "./context.js";
import {
  EmptyNotice,
  ErrorNotice,
  HostFileLink,
  LoadingNotice,
  isActiveRunStatus,
  revisionEqual,
  type ActionFeedback,
} from "./primitives.js";
import { aggregateRunDetailPath, aggregateSectionPath, parseFactoryRoute, runDetailPath, sectionPath } from "./routes.js";
import { FactoryShell } from "./shell.js";
import {
  AggregateSectionView,
  AggregateOverviewView,
  idleBundle,
  type AggregateGroup,
  type AggregateSection,
  type Loadable,
  type RepositoryBundle,
} from "./views/aggregate.js";
import { OverviewView } from "./views/overview.js";
import { QuestionsView } from "./views/questions.js";
import { AddRepositoryView, RepositoryLandingView } from "./views/repositories.js";
import { RunDetailView, RunsView } from "./views/runs.js";
import { SettingsView } from "./views/settings.js";
import { WorkView } from "./views/work.js";

const h = createElement;

export interface FactoryViewProps {
  /** Route remainder supplied by the host navPanel. */
  subPath?: string;
  /** The containing navPanel path, overridable by the integration owner. */
  panelPath?: string;
}

interface FactoryData {
  repositories: Loadable<RepositorySelectionProjection>;
  /** The repository the per-repo projections below were loaded for; render gates keep a repo switch from ever showing them. */
  repositoryKey: string | null;
  snapshot: Loadable<ProtocolSnapshot>;
  settings: Loadable<SettingsProjection>;
  health: Loadable<HealthProjection>;
  interactions: Loadable<PendingInteractionsProjection>;
  runs: Loadable<OperationalRunListProjection>;
  detail: Loadable<OperationalRunDetailProjection> | null;
  /** detailGateKey(repositoryKey, runId) the detail projection was loaded for. */
  detailKey: string | null;
  /** Aggregate ("All") per-repository projections, keyed by repositoryKey. */
  all: Record<string, RepositoryBundle>;
}

function initialData(detailRequested = false): FactoryData {
  return {
    repositories: { status: "loading" },
    repositoryKey: null,
    snapshot: { status: "idle" },
    settings: { status: "idle" },
    health: { status: "idle" },
    interactions: { status: "idle" },
    runs: { status: "idle" },
    detail: detailRequested ? { status: "loading" } : null,
    detailKey: null,
    all: {},
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The read request failed without a diagnostic message.";
}

type SafeParseSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ message: string }> } };
};

function parseProjection<T>(schema: SafeParseSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]?.message;
    throw new Error(`${label} returned malformed data${issue ? `: ${issue}` : "."}`);
  }
  return result.data;
}

function readRepositoryKey(values: Record<string, string | number | boolean> | undefined): string | undefined {
  const value = values?.repositoryKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSettingsIdentity(values: Record<string, string | number | boolean> | undefined): string {
  const repositoryKey = readRepositoryKey(values) ?? "";
  const registry = values?.repositoryRegistry;
  return `${repositoryKey}\u0000${typeof registry === "string" ? registry : ""}`;
}

function selectedRepository(projection: RepositorySelectionProjection): RepositorySelection | null {
  return projection.repositories.find((repository) => repository.configuration.repositoryKey === projection.selectedRepositoryKey)
    ?? projection.repositories.find((repository) => repository.selected)
    ?? null;
}

function selectedRepositoryKey(projection: RepositorySelectionProjection): string | null {
  return selectedRepository(projection)?.configuration.repositoryKey ?? null;
}

// A plain concat would collide ("ab"+"c" vs "a"+"bc"); the tuple encoding is
// unambiguous and is the only producer/gate format for detail retention.
function detailGateKey(repositoryKey: string, runId: string): string {
  return JSON.stringify([repositoryKey, runId]);
}

/** Aggregate tabs: no Settings (repository-scoped) and no Repositories pill. */
const AGGREGATE_TABS: readonly FactorySection[] = ["overview", "work", "questions", "runs"];

function bundleAttentionInput(bundle: RepositoryBundle): AttentionInput {
  return {
    snapshot: bundle.snapshot.status === "ready" ? bundle.snapshot.data : null,
    snapshotError: bundle.snapshot.status === "error",
    settings: bundle.settings.status === "ready" ? bundle.settings.data : null,
    health: bundle.health.status === "ready" ? bundle.health.data : null,
    interactions: bundle.interactions.status === "ready" ? bundle.interactions.data : null,
    runs: bundle.runs.status === "ready" ? bundle.runs.data : null,
  };
}

function ready<T>(resource: Loadable<T>): T | null {
  return resource.status === "ready" ? resource.data : null;
}

function resourceError(resource: Loadable<unknown>): string | null {
  return resource.status === "error" ? resource.error : null;
}

/** Queue rows still needing a human; the Work tab badge counts these. */
function needsYouEntry(entry: QueueEntry): boolean {
  return entry.status.kind !== "done"
    && entry.status.kind !== "in-progress"
    && (entry.eligibilityReasons.includes("missing-authorization")
      || entry.blockingQuestionIds.length > 0
      || entry.blockedBy.length > 0
      || (entry.status.kind === "blocked-by" && entry.status.questionId !== null));
}

// Badges count the underlying items so they match what the views show; the
// aggregate scope sums this same function over every repository's bundle.
function projectionBadges(input: AttentionInput): { work: number; questions: number; runsActive: boolean } {
  const counts = attentionCounts(computeAttention(input));
  const snapshot = input.snapshot;
  const work = snapshot?.queue.filter(needsYouEntry).length ?? counts.work;
  const questions = ((snapshot?.questions.filter((question) => question.answer === null).length ?? 0)
    + (input.interactions?.interactions.length ?? 0)) || counts.questions;
  return {
    work,
    questions,
    runsActive: input.runs?.runs.some((run) => isActiveRunStatus(run.status)) ?? false,
  };
}

const idleFeedback: ActionFeedback = {
  pending: false,
  target: null,
  message: null,
  error: null,
  scope: { repositoryKey: "", section: "" },
};

function actionTarget(action: FactoryAction, routeRunId: string | null): string {
  switch (action.kind) {
    case "approve-queue":
      return `queued:${action.queueItemId}`;
    case "answer-question":
      return action.source === "bb-interaction"
        ? `interaction:${action.interactionId}`
        : `question:${action.questionId}`;
    case "recommend-question":
      return `question:${action.questionId}`;
    case "recommend-approval":
      return `queued:${action.queueItemId}`;
    case "retry":
    case "stop":
      return `run:${routeRunId ?? "?"}`;
    default:
      return "dispatch";
  }
}

export function FactoryView({ subPath = "", panelPath = "factory" }: FactoryViewProps) {
  const route = parseFactoryRoute(subPath);
  const routeRunId = route.section === "runs" ? route.runId : null;
  const aggregateScope = route.scope === "all";
  const sdkSettings = useSettings();
  const configuredRepositoryKey = readRepositoryKey(sdkSettings.values);
  const settingsIdentity = readSettingsIdentity(sdkSettings.values);
  const rpc = useRpc<FactoryRpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const navigate = useBbNavigate();
  const connectionState = useRealtimeConnectionState();
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [malformedSignal, setMalformedSignal] = useState(false);
  const [repositoryOverride, setRepositoryOverride] = useState<{ configuredKey: string | null; repositoryKey: string } | null>(null);
  const [data, setData] = useState<FactoryData>(() => initialData(Boolean(routeRunId)));
  const [actionState, setActionState] = useState<{ pendingTarget: string | null; feedback: ActionFeedback }>({ pendingTarget: null, feedback: idleFeedback });
  const [repositoriesPending, setRepositoriesPending] = useState(true);
  const loadToken = useRef(0);
  // Set by onAddRepository just before the wizard navigation so the wizard's
  // Back restores the exact view it was opened from. Null on a deep link.
  const wizardOriginRef = useRef<{ repositoryKey: string | null; subPath: string } | null>(null);
  // The override is keyed to the configured repositoryKey only. Registry writes
  // (dispatch toggle, add repository) change the registry JSON but must not
  // snap the selection back to the default repository.
  const requestedRepositoryKey = repositoryOverride && repositoryOverride.configuredKey === (configuredRepositoryKey ?? null)
    ? repositoryOverride.repositoryKey
    : configuredRepositoryKey;

  useEffect(() => {
    setRepositoryOverride((current) => current && current.configuredKey === (configuredRepositoryKey ?? null) ? current : null);
  }, [configuredRepositoryKey]);

  const reload = useCallback(() => {
    setRefreshSequence((current) => current + 1);
  }, []);

  // Events that name another repository do not concern the visible one; global
  // events (repositoryKey null) still reload everything. In the aggregate
  // scope every repository is visible, so no event is filtered out.
  const requestedKeyRef = useRef(requestedRepositoryKey);
  requestedKeyRef.current = requestedRepositoryKey;
  const aggregateScopeRef = useRef(aggregateScope);
  aggregateScopeRef.current = aggregateScope;
  const onRealtime = useCallback((payload: unknown) => {
    const parsed = invalidationEventSchema.safeParse(payload);
    setMalformedSignal(!parsed.success);
    if (parsed.success && parsed.data.repositoryKey && !aggregateScopeRef.current && parsed.data.repositoryKey !== requestedKeyRef.current) return;
    reload();
  }, [reload]);
  useRealtime("factory", onRealtime);

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    if (connectionState === "connected" && previousConnectionState.current !== "connected") reload();
    previousConnectionState.current = connectionState;
  }, [connectionState, reload]);

  // Leaving the wizard by any path other than its own Back (a switcher pill,
  // a fresh deep link) drops the remembered origin.
  useEffect(() => {
    if (route.section !== "add-repository") wizardOriginRef.current = null;
  }, [route.section]);

  const onRepositorySelect = useCallback((repositoryKey: string) => {
    if (repositoryKey === requestedRepositoryKey) return;
    setRepositoryOverride({ configuredKey: configuredRepositoryKey ?? null, repositoryKey });
  }, [requestedRepositoryKey, configuredRepositoryKey]);

  // In-flight per-repository bundle reads, shared with the repository cards'
  // loadSummary so an aggregate overview does not fetch twice.
  const bundlePromisesRef = useRef(new Map<string, Promise<RepositoryBundle>>());

  const fetchRepositoryBundle = useCallback(async (repositoryKey: string): Promise<RepositoryBundle> => {
    const settle = <T,>(promise: Promise<T>): Promise<Loadable<T>> =>
      promise.then(
        (data): Loadable<T> => ({ status: "ready", data }),
        (error): Loadable<T> => ({ status: "error", error: errorText(error) }),
      );
    const [snapshot, settings, health, interactions, runs] = await Promise.all([
      settle(rpcRef.current.call("factory_snapshot", { repositoryKey }).then((value) => parseProjection(protocolSnapshotSchema, value, "Repository snapshot"))),
      settle(rpcRef.current.call("factory_settings", { repositoryKey }).then((value) => parseProjection(settingsProjectionSchema, value, "Settings projection"))),
      settle(rpcRef.current.call("factory_health", { repositoryKey }).then((value) => parseProjection(healthProjectionSchema, value, "Health projection"))),
      settle(rpcRef.current.call("factory_interactions", { repositoryKey }).then((value) => parseProjection(pendingInteractionsProjectionSchema, value, "BB interactions projection"))),
      settle(rpcRef.current.call("factory_runs", { repositoryKey, limit: 50 }).then((value) => parseProjection(operationalRunListProjectionSchema, value, "Runs projection"))),
    ]);
    return { snapshot, settings, health, interactions, runs };
  }, []);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    bundlePromisesRef.current = new Map();
    // Keep ready projections mounted during reloads so views (and their form
    // drafts) survive a refresh; the repositoryKey/detailKey render gates stop
    // a repo or run switch from ever showing the retained data.
    setData((current) => ({
      ...initialData(Boolean(routeRunId)),
      repositories: current.repositories.status === "ready" ? current.repositories : { status: "loading" },
      repositoryKey: current.repositoryKey,
      snapshot: current.snapshot,
      settings: current.settings,
      health: current.health,
      interactions: current.interactions,
      runs: current.runs,
      detail: current.detail,
      detailKey: current.detailKey,
      all: current.all,
    }));
    setRepositoriesPending(true);

    try {
      const repositories = parseProjection(
        repositorySelectionProjectionSchema,
        await rpcRef.current.call("factory_repositories", { selectedRepositoryKey: requestedRepositoryKey ?? null }),
        "Repository selection",
      );
      if (token !== loadToken.current) return;
      setData((current) => ({ ...current, repositories: { status: "ready", data: repositories } }));
      const repositoryKey = selectedRepositoryKey(repositories);
      const detailRepositoryKey = aggregateScope ? route.runRepositoryKey : repositoryKey;
      const nextDetailKey = routeRunId && detailRepositoryKey ? detailGateKey(detailRepositoryKey, routeRunId) : null;
      const detailRequest = routeRunId && detailRepositoryKey
        ? rpcRef.current.call("factory_run_detail", { repositoryKey: detailRepositoryKey, runId: routeRunId }).then((value) => parseProjection(operationalRunDetailProjectionSchema, value, "Run detail projection"))
        : Promise.resolve<OperationalRunDetailProjection | null>(null);

      if (aggregateScope || !repositoryKey) {
        // Aggregate scope (or a projection with no selection): every
        // registered repository loads its own projections, keyed so a row can
        // never be attributed to the wrong repository.
        const bundlePromises = new Map<string, Promise<RepositoryBundle>>();
        for (const entry of repositories.repositories) {
          const key = entry.configuration.repositoryKey;
          bundlePromises.set(key, fetchRepositoryBundle(key));
        }
        bundlePromisesRef.current = bundlePromises;
        // Retained bundles for de-registered repositories are dropped here.
        // A batched commit used to get that pruning for free by replacing the
        // whole map; per-repository commits have to do it explicitly.
        setData((current) => ({
          ...current,
          all: Object.fromEntries(Object.entries(current.all).filter(([key]) => bundlePromises.has(key))),
        }));
        // Commit each repository the moment it settles: one slow repository no
        // longer holds back groups whose data has already arrived. The token
        // check plus the promise-identity check keep a superseded load from
        // writing into the current scope, and every group falls back to
        // idleBundle() until its own commit lands.
        const bundleCommits = [...bundlePromises.entries()].map(async ([key, promise]) => {
          const bundle = await promise;
          if (token !== loadToken.current || bundlePromisesRef.current.get(key) !== promise) return;
          setData((current) => ({ ...current, all: { ...current.all, [key]: bundle } }));
        });
        const detailCommit = detailRequest.then(
          (value): PromiseSettledResult<OperationalRunDetailProjection> => ({ status: "fulfilled", value: value as OperationalRunDetailProjection }),
          (reason): PromiseSettledResult<OperationalRunDetailProjection> => ({ status: "rejected", reason }),
        ).then((detailResult) => {
          if (token !== loadToken.current) return;
          setData((current) => ({
            ...current,
            detailKey: nextDetailKey,
            detail: detailResult.status === "fulfilled" && detailResult.value
              ? { status: "ready", data: detailResult.value }
              : detailResult.status === "rejected"
                ? { status: "error", error: errorText(detailResult.reason) }
                : null,
          }));
        });
        await Promise.all([...bundleCommits, detailCommit]);
        if (token !== loadToken.current) return;
        setRefreshedAt(Date.now());
        setRepositoriesPending(false);
        return;
      }

      const snapshotRequest = rpcRef.current.call("factory_snapshot", { repositoryKey }).then((value) => parseProjection(protocolSnapshotSchema, value, "Repository snapshot"));
      const settingsRequest = rpcRef.current.call("factory_settings", { repositoryKey }).then((value) => parseProjection(settingsProjectionSchema, value, "Settings projection"));
      const healthRequest = rpcRef.current.call("factory_health", { repositoryKey }).then((value) => parseProjection(healthProjectionSchema, value, "Health projection"));
      const interactionsRequest = rpcRef.current.call("factory_interactions", { repositoryKey }).then((value) => parseProjection(pendingInteractionsProjectionSchema, value, "BB interactions projection"));
      const runsRequest = rpcRef.current.call("factory_runs", { repositoryKey, limit: 50 }).then((value) => parseProjection(operationalRunListProjectionSchema, value, "Runs projection"));

      const [snapshotResult, settingsResult, healthResult, interactionsResult, runsResult, detailResult] = await Promise.all([
        Promise.allSettled([snapshotRequest]).then(([result]) => result!),
        Promise.allSettled([settingsRequest]).then(([result]) => result!),
        Promise.allSettled([healthRequest]).then(([result]) => result!),
        Promise.allSettled([interactionsRequest]).then(([result]) => result!),
        Promise.allSettled([runsRequest]).then(([result]) => result!),
        Promise.allSettled([detailRequest]).then(([result]) => result!),
      ]);
      if (token !== loadToken.current) return;

      const resource = <T,>(result: PromiseSettledResult<T>): Loadable<T> => result.status === "fulfilled" ? { status: "ready", data: result.value } : { status: "error", error: errorText(result.reason) };
      setData((current) => ({
        ...current,
        repositoryKey,
        snapshot: resource(snapshotResult),
        settings: resource(settingsResult),
        health: resource(healthResult),
        interactions: resource(interactionsResult),
        runs: resource(runsResult),
        detailKey: nextDetailKey,
        detail: routeRunId ? resource(detailResult as PromiseSettledResult<OperationalRunDetailProjection>) : null,
      }));
      setRefreshedAt(Date.now());
      setRepositoriesPending(false);
    } catch (error) {
      if (token === loadToken.current) {
        setData((current) => ({ ...current, repositories: { status: "error", error: errorText(error) } }));
        setRepositoriesPending(false);
      }
    }
  }, [requestedRepositoryKey, routeRunId, route.runRepositoryKey, aggregateScope, refreshSequence, settingsIdentity, fetchRepositoryBundle]);

  useEffect(() => {
    if (sdkSettings.isLoading) {
      loadToken.current += 1;
      setData(initialData(Boolean(routeRunId)));
      return;
    }

    void load();
    return () => {
      loadToken.current += 1;
    };
  }, [load, routeRunId, sdkSettings.isLoading]);

  const onRetry = reload;
  const onNavigate = useCallback((section: FactorySection, anchor?: string) => {
    navigate.toPluginPanel(panelPath, { subPath: sectionPath(section, anchor) });
  }, [navigate, panelPath]);
  const onOpenRun = useCallback((runId: string) => {
    navigate.toPluginPanel(panelPath, { subPath: runDetailPath(runId) });
  }, [navigate, panelPath]);
  const onShowRepositories = useCallback((section: FactorySection = "overview") => {
    const aggregateSection = section === "settings" ? "overview" : section;
    navigate.toPluginPanel(panelPath, { subPath: aggregateSectionPath(aggregateSection) });
  }, [navigate, panelPath]);
  // Aggregate tabs stay inside the "all/..." namespace so the scope survives
  // reloads and deep links.
  const onOpenAggregateSection = useCallback((section: FactorySection) => {
    navigate.toPluginPanel(panelPath, { subPath: aggregateSectionPath(section as AggregateSection) });
  }, [navigate, panelPath]);
  const onAddRepository = useCallback(() => {
    // Remember the origin before navigating so the wizard's Back restores it.
    // A second trigger while already on the wizard keeps the first origin.
    if (route.section !== "add-repository") {
      wizardOriginRef.current = { repositoryKey: requestedRepositoryKey ?? null, subPath };
    }
    navigate.toPluginPanel(panelPath, { subPath: "repositories/new" });
  }, [navigate, panelPath, requestedRepositoryKey, subPath, route.section]);
  // A wizard reached by deep link has no remembered origin; Back then lands
  // on the aggregate repositories view.
  const onWizardBack = useCallback(() => {
    const origin = wizardOriginRef.current;
    wizardOriginRef.current = null;
    if (origin === null) {
      onShowRepositories();
      return;
    }
    if (origin.repositoryKey !== null) onRepositorySelect(origin.repositoryKey);
    navigate.toPluginPanel(panelPath, { subPath: origin.subPath });
  }, [navigate, panelPath, onRepositorySelect, onShowRepositories]);
  const onOpenThread = useCallback((threadId: string) => navigate.toThread(threadId), [navigate]);
  const onOpenProject = useCallback((projectId: string) => navigate.toProject(projectId), [navigate]);

  const repositoryProjection = ready(data.repositories);
  const selectedEntry = repositoryProjection ? selectedRepository(repositoryProjection) : null;
  const selectedConfiguration = selectedEntry?.configuration ?? null;
  const repoKey = selectedConfiguration?.repositoryKey ?? null;
  // Retained projections describe data.repositoryKey only; a repository switch
  // must never paint the previous repository's rows.
  const repoDataCurrent = data.repositoryKey !== null && data.repositoryKey === repoKey;
  const snapshot = repoDataCurrent ? ready(data.snapshot) : null;
  const settings = repoDataCurrent ? ready(data.settings) : null;
  const health = repoDataCurrent ? ready(data.health) : null;
  const interactions = repoDataCurrent ? ready(data.interactions) : null;
  const runs = repoDataCurrent ? ready(data.runs) : null;
  const snapshotError = repoDataCurrent ? resourceError(data.snapshot) : null;
  const settingsError = repoDataCurrent ? resourceError(data.settings) : null;
  const runsError = repoDataCurrent ? resourceError(data.runs) : null;
  const detailRepositoryKey = aggregateScope ? route.runRepositoryKey : repoKey;
  const expectedDetailKey = routeRunId && detailRepositoryKey ? detailGateKey(detailRepositoryKey, routeRunId) : null;
  const detailCurrent = data.detail !== null && data.detailKey === expectedDetailKey;
  const detailProjection = detailCurrent && data.detail ? ready(data.detail) : null;
  const detail = detailProjection?.run ?? null;
  const detailError = detailCurrent && data.detail ? resourceError(data.detail) : null;
  const detailLoading = routeRunId !== null && detailProjection === null && detailError === null;

  const scopeSection: FactorySection = route.section === "not-found" || route.section === "repositories" || route.section === "add-repository"
    ? "overview"
    : route.section;
  const feedbackFor = (key: string | null) =>
    actionState.feedback.scope.repositoryKey === (key ?? "") && actionState.feedback.scope.section === scopeSection
      ? actionState.feedback
      : null;
  const pendingFor = (key: string | null) =>
    actionState.feedback.pending && actionState.feedback.scope.repositoryKey === (key ?? "")
      ? actionState.pendingTarget
      : null;

  const attention = computeAttention({
    snapshot,
    snapshotError: snapshotError !== null,
    settings,
    health,
    runs,
    interactions,
  });
  const activeRun: OperationalRunSummary | null = runs?.runs.find((run) => isActiveRunStatus(run.status))
    ?? (detail && isActiveRunStatus(detail.summary.status) ? detail.summary : null);

  // The repository and snapshot come from the calling context, not the global
  // selection, so an aggregate row always mutates its own repository at its
  // own revision.
  const submitAction = useCallback(async (
    action: FactoryAction,
    target: string,
    repositoryKey: string | null,
    currentSnapshot: ProtocolSnapshot | null,
    section: FactorySection,
  ) => {
    const scope = { repositoryKey: repositoryKey ?? "", section };
    if (!repositoryKey) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "No repository is selected.", scope } });
      return;
    }
    const fileGuarded = action.kind === "approve-queue" || (action.kind === "answer-question" && action.source === "repository-question");
    if (fileGuarded && !currentSnapshot) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "The repository snapshot must load before repository file actions can run.", scope } });
      return;
    }
    const idempotencyKey = `bbf:v1:${repositoryKey}:${action.kind}:${crypto.randomUUID()}`;
    let request: FactoryActionRequest;
    if (action.kind === "approve-queue" || (action.kind === "answer-question" && action.source === "repository-question")) {
      request = { repositoryKey, action, idempotencyKey, expectedRevision: currentSnapshot!.revision };
    } else {
      request = { repositoryKey, action, idempotencyKey, ...(currentSnapshot ? { expectedRevision: currentSnapshot.revision } : {}) };
    }
    setActionState({ pendingTarget: target, feedback: { pending: true, target, message: null, error: null, scope } });
    try {
      const raw = await rpcRef.current.call("factory_action", request);
      const parsed = factoryActionResultSchema.safeParse(raw);
      if (!parsed.success) {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "The action result was malformed.", scope } });
      } else if (parsed.data.ok) {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: parsed.data.result.message, error: null, scope } });
        if (parsed.data.result.action === "recommend-question" || parsed.data.result.action === "recommend-approval") {
          navigate.toThread(parsed.data.result.threadId);
        }
      } else {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: parsed.data.error.message, scope } });
      }
    } catch (error) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: errorText(error), scope } });
    }
    reload();
  }, [reload]);

  const callMutation = useCallback(async (
    method: "factory_update_settings" | "factory_update_repository" | "factory_add_repository",
    input: unknown,
  ): Promise<SettingsMutationResult> => {
    try {
      const raw = await rpcRef.current.call(method, input as never);
      const parsed = settingsMutationResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { category: "internal", message: "The mutation result was malformed." } };
      }
      if (parsed.data.ok) reload();
      return parsed.data;
    } catch (error) {
      return { ok: false, error: { category: "internal", message: errorText(error) } };
    }
  }, [reload]);

  const loadRegistryOptions = useCallback(async () => {
    const raw = await rpcRef.current.call("factory_registry_options", {});
    return parseProjection(registryOptionsProjectionSchema, raw, "Registry options");
  }, []);

  const pickRepositoryFolder = useCallback(async (input: PickFolderInput) => {
    const raw = await rpcRef.current.call("factory_pick_folder", input);
    return parseProjection(pickFolderResultSchema, raw, "Folder pick");
  }, []);

  const probeRepository = useCallback(async (input: ProbeRepositoryInput) => {
    const raw = await rpcRef.current.call("factory_probe_repository", input);
    return parseProjection(repositoryProbeSchema, raw, "Repository probe");
  }, []);

  const resolveRepositoryProject = useCallback(async (input: ResolveProjectInput) => {
    const raw = await rpcRef.current.call("factory_resolve_project", input);
    return parseProjection(resolveProjectResultSchema, raw, "Project resolution");
  }, []);

  /**
   * Result-returning factory_action call for the add wizard's multi-step
   * orchestration. Unlike submitAction it does not touch shell feedback; it
   * still reloads durable projections when an accepted action changed state.
   */
  const runAction = useCallback(async (request: FactoryActionRequest): Promise<FactoryActionResult> => {
    try {
      const raw = await rpcRef.current.call("factory_action", request);
      const parsed = factoryActionResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { category: "internal", message: "The action result was malformed." } };
      }
      if (parsed.data.ok && parsed.data.result.status !== "preview") reload();
      return parsed.data;
    } catch (error) {
      return { ok: false, error: { category: "internal", message: errorText(error) } };
    }
  }, [reload]);

  const loadRepositorySummary = useCallback(async (repositoryKey: string) => {
    try {
      // Share the aggregate load's in-flight bundle fetch when one exists so
      // cards on the overview do not issue a second round of RPCs.
      const promise = bundlePromisesRef.current.get(repositoryKey) ?? fetchRepositoryBundle(repositoryKey);
      const bundle = await promise;
      const items = computeAttention({
        snapshot: bundle.snapshot.status === "ready" ? bundle.snapshot.data : null,
        snapshotError: bundle.snapshot.status === "error",
        settings: bundle.settings.status === "ready" ? bundle.settings.data : null,
        health: null,
        interactions: bundle.interactions.status === "ready" ? bundle.interactions.data : null,
        runs: bundle.runs.status === "ready" ? bundle.runs.data : null,
      });
      const actionable = items.filter((item) => item.severity !== "info").length;
      const dispatch: DispatchStatus | null = bundle.settings.status === "ready"
        ? bundle.settings.data.dispatch
        : null;
      if (dispatch) dispatchStatusSchema.parse(dispatch);
      return { attention: actionable, dispatch, error: null };
    } catch (error) {
      return { attention: 0, dispatch: null, error: errorText(error) };
    }
  }, [fetchRepositoryBundle]);

  const ctx: ViewContext | null = selectedConfiguration
    ? {
        repository: selectedConfiguration,
        environmentId: selectedEntry?.environmentId ?? null,
        projectId: selectedEntry?.projectId ?? null,
        dispatchPaused: selectedEntry?.dispatchPaused ?? false,
        revision: snapshot?.revision ?? null,
        fileLink: HostFileLink,
        feedback: feedbackFor(repoKey),
        pendingTarget: pendingFor(repoKey),
        onOpenSection: onNavigate,
        onOpenRepository: (repositoryKey, section = "overview", anchor) => {
          onRepositorySelect(repositoryKey);
          onNavigate(section, anchor);
        },
        onOpenRun,
        onOpenThread,
        onOpenProject,
        onAction: (action) => void submitAction(action, actionTarget(action, routeRunId), repoKey, snapshot, scopeSection),
        updateSettings: (patch) => {
          const repositoryKey = selectedRepositoryKey(repositoryProjection!);
          return repositoryKey
            ? callMutation("factory_update_settings", { repositoryKey, patch })
            : Promise.resolve<SettingsMutationResult>({ ok: false, error: { category: "not-found", message: "No repository is selected." } });
        },
        updateRepository: (input) => callMutation("factory_update_repository", input),
        addRepository: (input) => callMutation("factory_add_repository", input),
        loadRegistryOptions,
        runAction,
        pickRepositoryFolder,
        probeRepository,
        resolveRepositoryProject,
      }
    : null;

  // A context pinned to one repository's own bundle and key; aggregate groups
  // render through this so actions, revisions, and feedback stay repo-exact.
  const scopedContext = (entry: RepositorySelection, bundle: RepositoryBundle): ViewContext => {
    const key = entry.configuration.repositoryKey;
    const bundleSnapshot = bundle.snapshot.status === "ready" ? bundle.snapshot.data : null;
    return {
      idPrefix: `${key}:`,
      repository: entry.configuration,
      environmentId: entry.environmentId ?? null,
      projectId: entry.projectId ?? null,
      dispatchPaused: entry.dispatchPaused ?? false,
      revision: bundleSnapshot?.revision ?? null,
      fileLink: HostFileLink,
      feedback: feedbackFor(key),
      pendingTarget: pendingFor(key),
      onOpenSection: (section, anchor) => {
        // Sections without an aggregate tab (overview detail, settings) hop to
        // the row's own repository; the rest stay inside the aggregate.
        if (section === "overview" || section === "settings") {
          onRepositorySelect(key);
          onNavigate(section, anchor);
          return;
        }
        navigate.toPluginPanel(panelPath, { subPath: aggregateSectionPath(section, anchor ? `${key}/${anchor}` : undefined) });
      },
      onOpenRepository: (repositoryKey, section = "overview", anchor) => {
        onRepositorySelect(repositoryKey);
        onNavigate(section, anchor);
      },
      onOpenRun: (runId) => navigate.toPluginPanel(panelPath, { subPath: aggregateRunDetailPath(key, runId) }),
      onOpenThread,
      onOpenProject,
      onAction: (action) => void submitAction(action, actionTarget(action, routeRunId), key, bundleSnapshot, scopeSection),
      updateSettings: (patch) => callMutation("factory_update_settings", { repositoryKey: key, patch }),
      updateRepository: (input) => callMutation("factory_update_repository", input),
      addRepository: (input) => callMutation("factory_add_repository", input),
      loadRegistryOptions,
      runAction,
      pickRepositoryFolder,
      probeRepository,
      resolveRepositoryProject,
    };
  };

  const hasRepositories = (repositoryProjection?.repositories.length ?? 0) > 0;
  const aggregate = aggregateScope || (hasRepositories && !selectedEntry);
  const aggregateGroups: AggregateGroup[] = aggregate && repositoryProjection
    ? repositoryProjection.repositories.map((entry) => {
        const bundle = data.all[entry.configuration.repositoryKey] ?? idleBundle();
        return { entry, bundle, ctx: scopedContext(entry, bundle) };
      })
    : [];

  // Run-now confirmation copy includes provider context from health.
  const preferredProvider = settings?.settings.providerPreference && settings.settings.providerPreference !== "alternate"
    ? settings.settings.providerPreference
    : null;
  const preferredStatus = preferredProvider
    ? health?.providers.find((provider) => provider.providerId === preferredProvider) ?? null
    : null;
  const providerLine = preferredProvider
    ? `Provider: ${preferredProvider}${preferredStatus ? ` (${preferredStatus.availability})` : ""}.`
    : "Provider: rotates between available providers.";
  const runNowDisabledReason = !settings
    ? null
    : settings.dispatch.mode !== "enabled"
      ? "Dispatch is paused. Resume first."
      : settings.dispatch.repositoryPaused
        ? "Dispatch is paused for this repository. Turn it on in Settings."
        : null;

  let content: ReturnType<typeof h>;
  if (data.repositories.status === "loading" || data.repositories.status === "idle") {
    content = h(LoadingNotice, { label: "Loading repositories" });
  } else if (data.repositories.status === "error") {
    content = h(ErrorNotice, { message: data.repositories.error, onRetry });
  } else if (route.section === "add-repository") {
    const wizardCtx: ViewContext | null = ctx ?? {
      repository: {
        repositoryKey: "",
        repositoryRoot: "",
        connectedHostId: "",
        checkoutPath: "",
        factoryBranch: "factory",
        mainRef: "origin/main",
      },
      environmentId: null,
      projectId: null,
      dispatchPaused: true,
      revision: null,
      feedback: null,
      pendingTarget: actionState.pendingTarget,
      onOpenSection: onNavigate,
      onOpenRepository: (repositoryKey, section = "overview", anchor) => {
        onRepositorySelect(repositoryKey);
        onNavigate(section, anchor);
      },
      onOpenRun,
      onOpenThread,
      onOpenProject,
      onAction: (action) => void submitAction(action, actionTarget(action, routeRunId), repoKey, snapshot, scopeSection),
      updateSettings: () => Promise.resolve<SettingsMutationResult>({ ok: false, error: { category: "not-found", message: "No repository is selected." } }),
      updateRepository: (input) => callMutation("factory_update_repository", input),
      addRepository: (input) => callMutation("factory_add_repository", input),
      loadRegistryOptions,
      runAction,
      pickRepositoryFolder,
      probeRepository,
      resolveRepositoryProject,
    };
    content = h(AddRepositoryView, {
      ctx: wizardCtx,
      onDone: (repositoryKey) => {
        onRepositorySelect(repositoryKey);
        onNavigate("settings");
      },
      onCancel: onWizardBack,
    });
  } else if (!repositoryProjection || repositoryProjection.repositories.length === 0) {
    // No registered repositories: the landing doubles as the empty state in
    // either scope.
    content = aggregateScope
      ? h(AggregateOverviewView, { groups: [], onRetry })
      : h(RepositoryLandingView, {
          repositories: [],
          onSelect: (repositoryKey) => {
            onRepositorySelect(repositoryKey);
            onNavigate("overview");
          },
          onAddRepository,
          loadSummary: loadRepositorySummary,
        });
  } else if (route.section === "not-found") {
    content = h(EmptyNotice, {
      title: "Page not found",
      detail: `No factory view matches "${route.raw ?? ""}".`,
      action: h("button", { type: "button", className: "text-sm font-medium text-primary hover:underline", onClick: () => (aggregateScope ? onOpenAggregateSection("overview") : onNavigate("overview")) }, "Back to overview"),
    });
  } else if (aggregate && route.section === "overview") {
    content = h(AggregateOverviewView, { groups: aggregateGroups, onRetry });
  } else if (aggregate && route.section === "runs" && routeRunId) {
    const detailEntry = route.runRepositoryKey
      ? repositoryProjection.repositories.find((entry) => entry.configuration.repositoryKey === route.runRepositoryKey) ?? null
      : null;
    const detailBundle = detailEntry ? data.all[detailEntry.configuration.repositoryKey] ?? idleBundle() : idleBundle();
    const detailCtx = detailEntry ? scopedContext(detailEntry, detailBundle) : null;
    content = detailCtx === null
      ? h(ErrorNotice, { message: `Repository "${route.runRepositoryKey ?? ""}" is not registered.`, onRetry })
      : detailError
        ? h(ErrorNotice, { message: detailError, onRetry })
        : detailLoading || !detail
          ? h(LoadingNotice, { label: "Loading run detail" })
          : h(RunDetailView, { detail, ctx: detailCtx });
  } else if (aggregate && (route.section === "work" || route.section === "questions" || route.section === "runs")) {
    content = h(AggregateSectionView, {
      section: route.section,
      groups: aggregateGroups,
      anchor: route.anchor,
      onRetry,
    });
  } else if (!ctx) {
    content = h(ErrorNotice, { message: "The selected repository configuration is unavailable.", onRetry });
  } else if (route.section === "overview") {
    const stillLoading = (snapshot === null && snapshotError === null) || (settings === null && settingsError === null);
    content = stillLoading
      ? h(LoadingNotice, { label: "Loading repository state" })
      : h(OverviewView, {
          snapshot,
          snapshotError,
          settings,
          health,
          runs,
          attention,
          activeRun,
          ctx,
        });
  } else if (route.section === "work") {
    content = snapshot
      ? h(WorkView, {
          snapshot,
          ctx,
          focusItemId: route.anchor?.replace(/^work-/u, "") ?? null,
          providers: health?.providers ?? [],
          preferredProviderId: preferredProvider,
        })
      : snapshotError !== null
        ? h(ErrorNotice, { message: snapshotError, onRetry })
        : h(LoadingNotice, { label: "Loading repository work" });
  } else if (route.section === "questions") {
    content = snapshot
      ? h(QuestionsView, {
          snapshot,
          interactions,
          ctx,
          focusQuestionId: route.anchor?.replace(/^question-/u, "") ?? null,
          providers: health?.providers ?? [],
          preferredProviderId: preferredProvider,
        })
      : snapshotError !== null
        ? h(ErrorNotice, { message: snapshotError, onRetry })
        : h(LoadingNotice, { label: "Loading questions" });
  } else if (route.section === "runs") {
    content = routeRunId
      ? detailError
        ? h(ErrorNotice, { message: detailError, onRetry })
        : detailLoading || !detail
          ? h(LoadingNotice, { label: "Loading run detail" })
          : h(RunDetailView, { detail, ctx })
      : runs
        ? h(RunsView, { runs, ctx })
        : runsError !== null
          ? h(ErrorNotice, { message: runsError, onRetry })
          : h(LoadingNotice, { label: "Loading run history" });
  } else {
    content = settings
      ? h(SettingsView, { projection: settings, health, ctx })
      : settingsError !== null
        ? h(ErrorNotice, { message: settingsError, onRetry })
        : h(LoadingNotice, { label: "Loading settings" });
  }

  const dispatch = settings?.dispatch ?? null;
  const sectionForShell: FactorySection = scopeSection;
  // "All" owns the switcher's active state whenever the aggregate is the
  // rendered scope (explicit all/* routes, or no selection to scope to).
  const repositoriesActive = data.repositories.status === "ready"
    && route.section !== "add-repository"
    && (aggregate || !repositoryProjection || repositoryProjection.repositories.length === 0);

  // On aggregate and landing routes a selection must navigate to that repo's
  // view: otherwise the click reloads data but repaints the same screen, which
  // reads as a dead control. On repo-scoped tabs selection keeps the tab.
  const selectionNavigates = aggregate
    || route.section === "not-found"
    || route.section === "add-repository";

  // Aggregate badges sum the same per-repository badge counts.
  const badges = aggregate
    ? aggregateGroups.reduce((total, group) => {
        const badge = projectionBadges(bundleAttentionInput(group.bundle));
        return {
          work: total.work + badge.work,
          questions: total.questions + badge.questions,
          runsActive: total.runsActive || badge.runsActive,
        };
      }, { work: 0, questions: 0, runsActive: false })
    : (() => {
        const badge = projectionBadges({
          snapshot,
          snapshotError: snapshotError !== null,
          settings,
          health,
          interactions,
          runs,
        });
        return {
          work: badge.work,
          questions: badge.questions,
          runsActive: badge.runsActive || (detail !== null && isActiveRunStatus(detail.summary.status)),
        };
      })();

  return h(FactoryShell, {
    section: sectionForShell,
    onNavigate: aggregate ? onOpenAggregateSection : onNavigate,
    tabs: aggregate ? AGGREGATE_TABS : undefined,
    repositories: repositoryProjection?.repositories ?? [],
    selectedRepositoryKey: selectedRepositoryKey(repositoryProjection ?? { repositories: [], selectedRepositoryKey: null }),
    aggregateScope,
    repositoriesActive,
    wizardMode: route.section === "add-repository",
    repositorySelectionLoading: repositoriesPending || data.repositories.status === "loading",
    onSelectRepository: (repositoryKey) => {
      onRepositorySelect(repositoryKey);
      if (selectionNavigates) onNavigate(scopeSection);
    },
    onShowRepositories,
    onAddRepository,
    dispatch,
    branch: health?.host.branch ?? snapshot?.repository.factoryBranch ?? null,
    commit: snapshot?.revision.gitCommit ?? null,
    activeRun: aggregate ? null : activeRun,
    badges,
    refreshedAt,
    onRefresh: reload,
    onPause: () => void submitAction({ kind: "pause" }, "dispatch", repoKey, snapshot, scopeSection),
    onResume: () => void submitAction({ kind: "resume" }, "dispatch", repoKey, snapshot, scopeSection),
    runNow: dispatch && activeRun === null
      ? {
          disabled: runNowDisabledReason !== null,
          reason: runNowDisabledReason,
          confirmTitle: `Run the foreman on ${selectedConfiguration?.repositoryKey ?? "this repository"}?`,
          confirmBody: `Starts a foreman run on ${selectedConfiguration?.repositoryKey ?? "the repository"} now, ignoring the night window and minimum gap. ${providerLine}`,
          onConfirm: () => void submitAction({ kind: "run-now" }, "dispatch", repoKey, snapshot, scopeSection),
        }
      : null,
    actionPending: actionState.pendingTarget !== null,
    connectionState: connectionState === "connecting" ? "reconnecting" : connectionState,
    malformedSignal,
    children: content,
  });
}

export default FactoryView;

// Re-export for tests and the legacy barrel.
export { revisionEqual };
export type { AttentionItem };
