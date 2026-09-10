import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import {
  Markdown,
  UrlLink,
  experimental_FileLink,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type MarkdownProps,
} from "@get-bb/plugin-sdk/app";
import {
  factoryActionResultSchema,
  healthProjectionSchema,
  invalidationEventSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  protocolSnapshotSchema,
  repositorySelectionProjectionSchema,
  settingsProjectionSchema,
  type FactoryAction,
  type FactoryActionRequest,
  type HealthProjection,
  type OperationalRunDetailProjection,
  type OperationalRunListProjection,
  type PendingInteractionsProjection,
  type ProtocolSnapshot,
  type RepositorySelectionProjection,
  type SettingsProjection,
} from "../contracts.js";
import type { FactoryRpcContract } from "../rpc.js";
import {
  ErrorNotice,
  FactoryShell,
  LoadingNotice,
  OverviewView,
  QueueView,
  QuestionsView,
  RepositorySelectionView,
  RouteNotFound,
  RunDetailView,
  RunsView,
  SettingsView,
  buttonClass,
  parseFactoryRoute,
  type FileLinkProps,
  type FileLinkRenderer,
  sectionPath,
  type FactorySection,
} from "./views.js";
import {
  DispatchControls,
  idleActionFeedback,
  type ActionFeedback,
} from "./action-entry.js";
import { createElement } from "react";

const h = createElement;

export interface FactoryViewProps {
  /** Route remainder supplied by the host navPanel. */
  subPath?: string;
  /** The containing navPanel path, overridable by the integration owner. */
  panelPath?: string;
}

type Loadable<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

interface FactoryData {
  repositories: Loadable<RepositorySelectionProjection>;
  snapshot: Loadable<ProtocolSnapshot>;
  settings: Loadable<SettingsProjection>;
  health: Loadable<HealthProjection>;
  interactions: Loadable<PendingInteractionsProjection>;
  runs: Loadable<OperationalRunListProjection>;
  detail: Loadable<OperationalRunDetailProjection> | null;
}

function initialData(detailRequested = false): FactoryData {
  return {
    repositories: { status: "loading" },
    snapshot: { status: "idle" },
    settings: { status: "idle" },
    health: { status: "idle" },
    interactions: { status: "idle" },
    runs: { status: "idle" },
    detail: detailRequested ? { status: "loading" } : null,
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

function selectedRepository(projection: RepositorySelectionProjection) {
  return projection.repositories.find((repository) => repository.configuration.repositoryKey === projection.selectedRepositoryKey)
    ?? projection.repositories.find((repository) => repository.selected)
    ?? null;
}

function selectedRepositoryKey(projection: RepositorySelectionProjection): string | null {
  return selectedRepository(projection)?.configuration.repositoryKey ?? null;
}

function ready<T>(resource: Loadable<T>): T | null {
  return resource.status === "ready" ? resource.data : null;
}

function resourceMessage(resource: Loadable<unknown>, label: string): string | null {
  return resource.status === "error" ? `${label}: ${resource.error}` : null;
}

export function FactoryView({ subPath = "", panelPath = "factory" }: FactoryViewProps) {
  const route = parseFactoryRoute(subPath);
  const routeRunId = route.section === "runs" ? route.runId : null;
  const sdkSettings = useSettings();
  const configuredRepositoryKey = readRepositoryKey(sdkSettings.values);
  const settingsIdentity = readSettingsIdentity(sdkSettings.values);
  const rpc = useRpc<FactoryRpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const navigate = useBbNavigate();
  const connectionState = useRealtimeConnectionState();
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [malformedSignal, setMalformedSignal] = useState(false);
  const [repositoryOverride, setRepositoryOverride] = useState<{ settingsIdentity: string; repositoryKey: string } | null>(null);
  const [data, setData] = useState<FactoryData>(() => initialData(Boolean(routeRunId)));
  const [actionState, setActionState] = useState<{ pendingTarget: string | null; feedback: ActionFeedback }>({ pendingTarget: null, feedback: idleActionFeedback });
  const loadToken = useRef(0);
  const requestedRepositoryKey = repositoryOverride?.settingsIdentity === settingsIdentity ? repositoryOverride.repositoryKey : configuredRepositoryKey;

  useEffect(() => {
    setRepositoryOverride((current) => current?.settingsIdentity === settingsIdentity ? current : null);
  }, [settingsIdentity]);

  const reload = useCallback(() => {
    setRefreshSequence((current) => current + 1);
  }, []);

  const onRealtime = useCallback((payload: unknown) => {
    const parsed = invalidationEventSchema.safeParse(payload);
    setMalformedSignal(!parsed.success);
    reload();
  }, [reload]);
  useRealtime("factory", onRealtime);

  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    if (connectionState === "connected" && previousConnectionState.current !== "connected") reload();
    previousConnectionState.current = connectionState;
  }, [connectionState, reload]);

  const onRepositorySelect = useCallback((repositoryKey: string) => {
    if (repositoryKey === requestedRepositoryKey) return;
    setRepositoryOverride({ settingsIdentity, repositoryKey });
  }, [requestedRepositoryKey, settingsIdentity]);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    setData({ ...initialData(Boolean(routeRunId)), repositories: { status: "loading" } });

    try {
      const repositories = parseProjection(
        repositorySelectionProjectionSchema,
        await rpcRef.current.call("factory_repositories", { selectedRepositoryKey: requestedRepositoryKey ?? null }),
        "Repository selection",
      );
      if (token !== loadToken.current) return;
      setData((current) => ({ ...current, repositories: { status: "ready", data: repositories } }));
      const repositoryKey = selectedRepositoryKey(repositories);
      if (!repositoryKey) {
        setData((current) => ({ ...current, snapshot: { status: "idle" }, settings: { status: "idle" }, health: { status: "idle" }, interactions: { status: "idle" }, runs: { status: "idle" }, detail: null }));
        return;
      }

      const snapshotRequest = rpcRef.current.call("factory_snapshot", { repositoryKey }).then((value) => parseProjection(protocolSnapshotSchema, value, "Repository snapshot"));
      const settingsRequest = rpcRef.current.call("factory_settings", { repositoryKey }).then((value) => parseProjection(settingsProjectionSchema, value, "Settings projection"));
      const healthRequest = rpcRef.current.call("factory_health", { repositoryKey }).then((value) => parseProjection(healthProjectionSchema, value, "Health projection"));
      const interactionsRequest = rpcRef.current.call("factory_interactions", { repositoryKey }).then((value) => parseProjection(pendingInteractionsProjectionSchema, value, "BB interactions projection"));
      const runsRequest = rpcRef.current.call("factory_runs", { repositoryKey, limit: 50 }).then((value) => parseProjection(operationalRunListProjectionSchema, value, "Runs projection"));
      const detailRequest = routeRunId
        ? rpcRef.current.call("factory_run_detail", { repositoryKey, runId: routeRunId }).then((value) => parseProjection(operationalRunDetailProjectionSchema, value, "Run detail projection"))
        : Promise.resolve<OperationalRunDetailProjection | null>(null);

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
        snapshot: resource(snapshotResult),
        settings: resource(settingsResult),
        health: resource(healthResult),
        interactions: resource(interactionsResult),
        runs: resource(runsResult),
        detail: routeRunId ? resource(detailResult as PromiseSettledResult<OperationalRunDetailProjection>) : null,
      }));
    } catch (error) {
      if (token === loadToken.current) setData((current) => ({ ...current, repositories: { status: "error", error: errorText(error) } }));
    }
  }, [requestedRepositoryKey, routeRunId, refreshSequence, settingsIdentity]);

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
  const onNavigate = useCallback((section: FactorySection) => {
    navigate.toPluginPanel(panelPath, { subPath: sectionPath(section) });
  }, [navigate, panelPath]);
  const onOpenRun = useCallback((runId: string) => {
    navigate.toPluginPanel(panelPath, { subPath: `runs/${encodeURIComponent(runId)}` });
  }, [navigate, panelPath]);
  const onBackToRuns = useCallback(() => onNavigate("runs"), [onNavigate]);
  const onOpenThread = useCallback((threadId: string) => navigate.toThread(threadId), [navigate]);
  const onOpenProject = useCallback((projectId: string) => navigate.toProject(projectId), [navigate]);

  const repositoryProjection = ready(data.repositories);
  const selectedRepositoryConfiguration = repositoryProjection ? selectedRepository(repositoryProjection)?.configuration ?? null : null;
  const fileLink = experimental_FileLink as ComponentType<FileLinkProps> as FileLinkRenderer;

  const submitAction = useCallback(async (action: FactoryAction, target: string) => {
    const repositoryKey = repositoryProjection ? selectedRepositoryKey(repositoryProjection) : null;
    const snapshot = data.snapshot.status === "ready" ? data.snapshot.data : null;
    if (!repositoryKey) {
      setActionState({ pendingTarget: null, feedback: { pending: false, message: null, error: "No repository is selected." } });
      return;
    }
    const revisionFree = action.kind === "preview" || action.kind === "integration-report";
    if (!revisionFree && !snapshot) {
      setActionState({ pendingTarget: null, feedback: { pending: false, message: null, error: "The repository snapshot must load before guarded actions can run." } });
      return;
    }
    const idempotencyKey = `bbf:v1:${repositoryKey}:${action.kind}:${crypto.randomUUID()}`;
    let request: FactoryActionRequest;
    if (action.kind === "preview" || action.kind === "integration-report") {
      request = { repositoryKey, action, idempotencyKey };
    } else if (action.kind === "approve-queue" || (action.kind === "answer-question" && action.source === "repository-question")) {
      request = { repositoryKey, action, idempotencyKey, expectedRevision: snapshot!.revision };
    } else {
      request = { repositoryKey, action, idempotencyKey, expectedRevision: snapshot!.revision };
    }
    setActionState({ pendingTarget: target, feedback: idleActionFeedback });
    try {
      const raw = await rpcRef.current.call("factory_action", request);
      const parsed = factoryActionResultSchema.safeParse(raw);
      if (!parsed.success) {
        setActionState({ pendingTarget: null, feedback: { pending: false, message: null, error: "The action result was malformed." } });
      } else if (parsed.data.ok) {
        setActionState({ pendingTarget: null, feedback: { pending: false, message: parsed.data.result.message, error: null } });
      } else {
        setActionState({ pendingTarget: null, feedback: { pending: false, message: null, error: parsed.data.error.message } });
      }
    } catch (error) {
      setActionState({ pendingTarget: null, feedback: { pending: false, message: null, error: errorText(error) } });
    }
    reload();
  }, [repositoryProjection, data.snapshot, reload]);

  const onApprove = useCallback((queueItemId: string, approvedText: string) => {
    void submitAction({ kind: "approve-queue", queueItemId, approvedText }, `approve:${queueItemId}`);
  }, [submitAction]);
  const onAnswerQuestion = useCallback((questionId: string, answer: string) => {
    void submitAction({ kind: "answer-question", source: "repository-question", questionId, answer }, `question:${questionId}`);
  }, [submitAction]);
  const onResolveInteraction = useCallback((interactionId: string, resolution: { kind: "approval"; decision: "allow_once" | "allow_for_session" | "deny" } | { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> }) => {
    void submitAction({ kind: "answer-question", source: "bb-interaction", interactionId, resolution }, `interaction:${interactionId}`);
  }, [submitAction]);
  const onRunNow = useCallback(() => void submitAction({ kind: "run-now" }, "run-now"), [submitAction]);
  const onPause = useCallback(() => void submitAction({ kind: "pause" }, "pause"), [submitAction]);
  const onResume = useCallback(() => void submitAction({ kind: "resume" }, "resume"), [submitAction]);
  const onStopRun = useCallback(() => void submitAction({ kind: "stop" }, "stop"), [submitAction]);
  const onRetryAttempt = useCallback((attemptId: string) => void submitAction({ kind: "retry", attemptId }, `retry:${attemptId}`), [submitAction]);
  let content: ReturnType<typeof h>;
  if (data.repositories.status === "loading" || data.repositories.status === "idle") {
    content = h(LoadingNotice, { label: "Loading repository selection" });
  } else if (data.repositories.status === "error") {
    content = h(ErrorNotice, { message: data.repositories.error, onRetry });
  } else if (!repositoryProjection || !selectedRepositoryKey(repositoryProjection)) {
    content = h(RepositorySelectionView, { projection: repositoryProjection! });
  } else if (route.section === "not-found") {
    content = h(RouteNotFound, { raw: route.raw, onBack: () => onNavigate("overview") });
  } else if (route.section === "overview") {
    const snapshot = ready(data.snapshot);
    content = snapshot ? h(OverviewView, {
      snapshot,
      settings: ready(data.settings),
      settingsError: data.settings.status === "error" ? data.settings.error : null,
      health: ready(data.health),
      healthError: data.health.status === "error" ? data.health.error : null,
      dashboardLink: snapshot.dashboard.canonicalDashboardUrl ? h(UrlLink, { href: snapshot.dashboard.canonicalDashboardUrl, className: `${buttonClass} shrink-0` }, `Open ${snapshot.dashboard.canonicalPath}`) : null,
      fileLink,
      onRetry,
      feedback: actionState.feedback.message || actionState.feedback.error ? actionState.feedback : null,
      dispatchActions: ready(data.settings) ? h(DispatchControls, {
        mode: ready(data.settings)!.dispatch.mode,
        acceptingNewRuns: ready(data.settings)!.dispatch.acceptingNewRuns,
        feedback: actionState.pendingTarget ? { pending: true, message: null, error: null } : null,
        onRunNow,
        onPause,
        onResume,
      }) : null,
    }) : data.snapshot.status === "error" ? h(ErrorNotice, { message: resourceMessage(data.snapshot, "Repository snapshot")!, onRetry }) : h(LoadingNotice, { label: "Loading repository overview" });
  } else if (route.section === "queue") {
    const snapshot = ready(data.snapshot);
    content = snapshot ? h(QueueView, { snapshot, fileLink, onApprove, pendingTarget: actionState.pendingTarget, feedback: actionState.feedback.message || actionState.feedback.error ? actionState.feedback : null }) : data.snapshot.status === "error" ? h(ErrorNotice, { message: resourceMessage(data.snapshot, "Repository queue")!, onRetry }) : h(LoadingNotice, { label: "Loading repository queue" });
  } else if (route.section === "questions") {
    const snapshot = ready(data.snapshot);
    content = snapshot ? h(QuestionsView, { snapshot, interactions: ready(data.interactions), interactionsError: data.interactions.status === "error" ? data.interactions.error : null, markdownRenderer: Markdown as ComponentType<MarkdownProps>, onOpenThread, onRetry, onAnswerQuestion, onResolveInteraction, pendingTarget: actionState.pendingTarget, feedback: actionState.feedback.message || actionState.feedback.error ? actionState.feedback : null }) : data.snapshot.status === "error" ? h(ErrorNotice, { message: resourceMessage(data.snapshot, "Repository questions")!, onRetry }) : h(LoadingNotice, { label: "Loading repository questions" });
  } else if (route.section === "runs") {
    const detailResource = routeRunId ? data.detail : null;
    const detail = detailResource ? ready(detailResource)?.run ?? null : null;
    content = routeRunId ? (detailResource?.status === "error" ? h(ErrorNotice, { message: resourceMessage(detailResource, "Run detail")!, onRetry }) : detailResource?.status === "loading" || !detailResource ? h(LoadingNotice, { label: "Loading run detail" }) : selectedRepositoryConfiguration ? h(RunDetailView, { detail, repository: selectedRepositoryConfiguration, fileLink, onBack: onBackToRuns, onOpenThread, onOpenProject, onStop: onStopRun, onRetry: onRetryAttempt, pendingTarget: actionState.pendingTarget, feedback: actionState.feedback.message || actionState.feedback.error ? actionState.feedback : null }) : h(ErrorNotice, { message: "The selected repository configuration is unavailable for file links.", onRetry })) : ready(data.runs) ? h(RunsView, { runs: ready(data.runs)!.runs, nextCursor: ready(data.runs)!.nextCursor, onOpenRun, onOpenThread, onOpenProject }) : data.runs.status === "error" ? h(ErrorNotice, { message: resourceMessage(data.runs, "Run history")!, onRetry }) : h(LoadingNotice, { label: "Loading run history" });
  } else {
    content = ready(data.settings) ? h(SettingsView, { projection: ready(data.settings)! }) : data.settings.status === "error" ? h(ErrorNotice, { message: resourceMessage(data.settings, "Settings")!, onRetry }) : h(LoadingNotice, { label: "Loading settings" });
  }

  return h(FactoryShell, {
    activeSection: route.section === "not-found" ? "overview" : route.section,
    connectionState,
    malformedSignal,
    onNavigate,
    repositoryProjection,
    repositorySelectionKey: requestedRepositoryKey ?? repositoryProjection?.selectedRepositoryKey,
    repositorySelectionLoading: data.repositories.status === "loading",
    onRepositorySelect,
    children: content,
  });
}

export default FactoryView;
