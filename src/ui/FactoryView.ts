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
  type RepositorySelection,
  type RepositorySelectionProjection,
  type ResolveProjectInput,
  type SettingsMutationResult,
  type SettingsProjection,
} from "../contracts.js";
import type { FactoryRpcContract } from "../rpc.js";
import { computeAttention, attentionCounts, type AttentionItem } from "./attention.js";
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
import { parseFactoryRoute, runDetailPath, sectionPath } from "./routes.js";
import { FactoryShell } from "./shell.js";
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

function selectedRepository(projection: RepositorySelectionProjection): RepositorySelection | null {
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

function resourceError(resource: Loadable<unknown>): string | null {
  return resource.status === "error" ? resource.error : null;
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
  // events (repositoryKey null) still reload everything.
  const requestedKeyRef = useRef(requestedRepositoryKey);
  requestedKeyRef.current = requestedRepositoryKey;
  const onRealtime = useCallback((payload: unknown) => {
    const parsed = invalidationEventSchema.safeParse(payload);
    setMalformedSignal(!parsed.success);
    if (parsed.success && parsed.data.repositoryKey && parsed.data.repositoryKey !== requestedKeyRef.current) return;
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
    setRepositoryOverride({ configuredKey: configuredRepositoryKey ?? null, repositoryKey });
  }, [requestedRepositoryKey, configuredRepositoryKey]);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    // Keep a ready repositories projection mounted during reloads so the
    // switcher pills never unmount mid-click.
    setData((current) => ({
      ...initialData(Boolean(routeRunId)),
      repositories: current.repositories.status === "ready" ? current.repositories : { status: "loading" },
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
      if (!repositoryKey) {
        setData((current) => ({ ...current, snapshot: { status: "idle" }, settings: { status: "idle" }, health: { status: "idle" }, interactions: { status: "idle" }, runs: { status: "idle" }, detail: null }));
        setRefreshedAt(Date.now());
        setRepositoriesPending(false);
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
      setRefreshedAt(Date.now());
      setRepositoriesPending(false);
    } catch (error) {
      if (token === loadToken.current) {
        setData((current) => ({ ...current, repositories: { status: "error", error: errorText(error) } }));
        setRepositoriesPending(false);
      }
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
  const onNavigate = useCallback((section: FactorySection, anchor?: string) => {
    navigate.toPluginPanel(panelPath, { subPath: sectionPath(section, anchor) });
  }, [navigate, panelPath]);
  const onOpenRun = useCallback((runId: string) => {
    navigate.toPluginPanel(panelPath, { subPath: runDetailPath(runId) });
  }, [navigate, panelPath]);
  const onShowRepositories = useCallback(() => {
    navigate.toPluginPanel(panelPath, { subPath: "repositories" });
  }, [navigate, panelPath]);
  const onAddRepository = useCallback(() => {
    navigate.toPluginPanel(panelPath, { subPath: "repositories/new" });
  }, [navigate, panelPath]);
  const onOpenThread = useCallback((threadId: string) => navigate.toThread(threadId), [navigate]);
  const onOpenProject = useCallback((projectId: string) => navigate.toProject(projectId), [navigate]);

  const repositoryProjection = ready(data.repositories);
  const selectedEntry = repositoryProjection ? selectedRepository(repositoryProjection) : null;
  const selectedConfiguration = selectedEntry?.configuration ?? null;
  const snapshot = ready(data.snapshot);
  const settings = ready(data.settings);
  const health = ready(data.health);
  const interactions = ready(data.interactions);
  const runs = ready(data.runs);
  const detail = routeRunId && data.detail ? ready(data.detail)?.run ?? null : null;
  const detailError = routeRunId && data.detail ? resourceError(data.detail) : null;
  const detailLoading = routeRunId ? (data.detail === null || data.detail.status !== "ready") && !detailError : false;

  const scopeSection = route.section === "not-found" || route.section === "repositories" || route.section === "add-repository"
    ? "overview"
    : route.section;
  const actionScope = { repositoryKey: selectedConfiguration?.repositoryKey ?? "", section: scopeSection };
  const scopedFeedback = actionState.feedback.scope.repositoryKey === actionScope.repositoryKey
    && actionState.feedback.scope.section === actionScope.section
    ? actionState.feedback
    : null;

  const attention = computeAttention({
    snapshot,
    snapshotError: data.snapshot.status === "error",
    settings,
    health,
    runs,
    interactions,
  });
  const counts = attentionCounts(attention);
  // Badges count the underlying items so they match what the views show.
  const needsYouCount = snapshot?.queue.filter((entry) =>
    entry.status.kind !== "done"
    && entry.status.kind !== "in-progress"
    && (entry.eligibilityReasons.includes("missing-authorization")
      || entry.blockingQuestionIds.length > 0
      || entry.blockedBy.length > 0
      || (entry.status.kind === "blocked-by" && entry.status.questionId !== null)),
  ).length ?? counts.work;
  const openQuestionCount = (snapshot?.questions.filter((question) => question.answer === null).length ?? 0)
    + (interactions?.interactions.length ?? 0) || counts.questions;
  const activeRun: OperationalRunSummary | null = runs?.runs.find((run) => isActiveRunStatus(run.status))
    ?? (detail && isActiveRunStatus(detail.summary.status) ? detail.summary : null);

  const submitAction = useCallback(async (action: FactoryAction, target: string) => {
    const repositoryKey = repositoryProjection ? selectedRepositoryKey(repositoryProjection) : null;
    const currentSnapshot = data.snapshot.status === "ready" ? data.snapshot.data : null;
    if (!repositoryKey) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "No repository is selected.", scope: actionScope } });
      return;
    }
    const fileGuarded = action.kind === "approve-queue" || (action.kind === "answer-question" && action.source === "repository-question");
    if (fileGuarded && !currentSnapshot) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "The repository snapshot must load before repository file actions can run.", scope: actionScope } });
      return;
    }
    const idempotencyKey = `bbf:v1:${repositoryKey}:${action.kind}:${crypto.randomUUID()}`;
    let request: FactoryActionRequest;
    if (action.kind === "approve-queue" || (action.kind === "answer-question" && action.source === "repository-question")) {
      request = { repositoryKey, action, idempotencyKey, expectedRevision: currentSnapshot!.revision };
    } else {
      request = { repositoryKey, action, idempotencyKey, ...(currentSnapshot ? { expectedRevision: currentSnapshot.revision } : {}) };
    }
    setActionState({ pendingTarget: target, feedback: { pending: true, target, message: null, error: null, scope: actionScope } });
    try {
      const raw = await rpcRef.current.call("factory_action", request);
      const parsed = factoryActionResultSchema.safeParse(raw);
      if (!parsed.success) {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: "The action result was malformed.", scope: actionScope } });
      } else if (parsed.data.ok) {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: parsed.data.result.message, error: null, scope: actionScope } });
        if (parsed.data.result.action === "recommend-question" || parsed.data.result.action === "recommend-approval") {
          navigate.toThread(parsed.data.result.threadId);
        }
      } else {
        setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: parsed.data.error.message, scope: actionScope } });
      }
    } catch (error) {
      setActionState({ pendingTarget: null, feedback: { pending: false, target, message: null, error: errorText(error), scope: actionScope } });
    }
    reload();
  }, [repositoryProjection, data.snapshot, reload, actionScope.repositoryKey, actionScope.section]);

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
      const [snapshotResult, settingsResult, interactionsResult, runsResult] = await Promise.allSettled([
        rpcRef.current.call("factory_snapshot", { repositoryKey }).then((value) => parseProjection(protocolSnapshotSchema, value, "Repository snapshot")),
        rpcRef.current.call("factory_settings", { repositoryKey }).then((value) => parseProjection(settingsProjectionSchema, value, "Settings projection")),
        rpcRef.current.call("factory_interactions", { repositoryKey }).then((value) => parseProjection(pendingInteractionsProjectionSchema, value, "BB interactions projection")),
        rpcRef.current.call("factory_runs", { repositoryKey, limit: 50 }).then((value) => parseProjection(operationalRunListProjectionSchema, value, "Runs projection")),
      ]);
      const items = computeAttention({
        snapshot: snapshotResult.status === "fulfilled" ? snapshotResult.value : null,
        snapshotError: snapshotResult.status === "rejected",
        settings: settingsResult.status === "fulfilled" ? settingsResult.value : null,
        health: null,
        interactions: interactionsResult.status === "fulfilled" ? interactionsResult.value : null,
        runs: runsResult.status === "fulfilled" ? runsResult.value : null,
      });
      const actionable = items.filter((item) => item.severity !== "info").length;
      const dispatch: DispatchStatus | null = settingsResult.status === "fulfilled"
        ? settingsResult.value.dispatch
        : null;
      if (dispatch) dispatchStatusSchema.parse(dispatch);
      return { attention: actionable, dispatch, error: null };
    } catch (error) {
      return { attention: 0, dispatch: null, error: errorText(error) };
    }
  }, []);

  const ctx: ViewContext | null = selectedConfiguration
    ? {
        repository: selectedConfiguration,
        environmentId: selectedEntry?.environmentId ?? null,
        projectId: selectedEntry?.projectId ?? null,
        dispatchPaused: selectedEntry?.dispatchPaused ?? false,
        revision: snapshot?.revision ?? null,
        fileLink: HostFileLink,
        feedback: scopedFeedback,
        pendingTarget: actionState.pendingTarget,
        onOpenSection: onNavigate,
        onOpenRepository: (repositoryKey, section = "overview", anchor) => {
          onRepositorySelect(repositoryKey);
          onNavigate(section, anchor);
        },
        onOpenRun,
        onOpenThread,
        onOpenProject,
        onAction: (action) => void submitAction(action, actionTarget(action, routeRunId)),
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
      onAction: (action) => void submitAction(action, actionTarget(action, routeRunId)),
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
      onCancel: onShowRepositories,
    });
  } else if (route.section === "repositories" || !repositoryProjection || repositoryProjection.repositories.length === 0 || !selectedEntry) {
    content = h(RepositoryLandingView, {
      repositories: repositoryProjection?.repositories ?? [],
      // Same combined handler as ctx.onOpenRepository: select, then leave the
      // landing so the card click lands on the repository's overview tab.
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
      action: h("button", { type: "button", className: "text-sm font-medium text-primary hover:underline", onClick: () => onNavigate("overview") }, "Back to overview"),
    });
  } else if (!ctx) {
    content = h(ErrorNotice, { message: "The selected repository configuration is unavailable.", onRetry });
  } else if (route.section === "overview") {
    const stillLoading = (data.snapshot.status === "idle" || data.snapshot.status === "loading")
      || data.settings.status === "loading" || data.settings.status === "idle";
    content = stillLoading
      ? h(LoadingNotice, { label: "Loading repository state" })
      : h(OverviewView, {
          snapshot,
          snapshotError: resourceError(data.snapshot),
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
      : data.snapshot.status === "error"
        ? h(ErrorNotice, { message: data.snapshot.error, onRetry })
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
      : data.snapshot.status === "error"
        ? h(ErrorNotice, { message: data.snapshot.error, onRetry })
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
        : data.runs.status === "error"
          ? h(ErrorNotice, { message: data.runs.error, onRetry })
          : h(LoadingNotice, { label: "Loading run history" });
  } else {
    content = settings
      ? h(SettingsView, { projection: settings, health, ctx })
      : data.settings.status === "error"
        ? h(ErrorNotice, { message: data.settings.error, onRetry })
        : h(LoadingNotice, { label: "Loading settings" });
  }

  const dispatch = settings?.dispatch ?? null;
  const sectionForShell: FactorySection = scopeSection;
  // Mirrors the landing branch above: "All" owns the switcher's active state
  // whenever the landing is the rendered content (the repositories route, or
  // any route with no repository list/selection to scope to).
  const repositoriesActive = data.repositories.status === "ready"
    && route.section !== "add-repository"
    && (route.section === "repositories"
      || repositoryProjection === null
      || repositoryProjection.repositories.length === 0
      || !selectedEntry);

  // On landing-scoped routes a selection must navigate to the repo's overview:
  // otherwise the click reloads data but repaints the same landing, which reads
  // as a dead control. On repo-scoped tabs selection keeps the current tab.
  const selectionNavigates = route.section === "repositories"
    || route.section === "not-found"
    || route.section === "add-repository";

  return h(FactoryShell, {
    section: sectionForShell,
    onNavigate,
    repositories: repositoryProjection?.repositories ?? [],
    selectedRepositoryKey: selectedRepositoryKey(repositoryProjection ?? { repositories: [], selectedRepositoryKey: null }),
    repositoriesActive,
    repositorySelectionLoading: repositoriesPending || data.repositories.status === "loading",
    onSelectRepository: (repositoryKey) => {
      onRepositorySelect(repositoryKey);
      if (selectionNavigates) onNavigate("overview");
    },
    onShowRepositories,
    onAddRepository,
    dispatch,
    branch: health?.host.branch ?? snapshot?.repository.factoryBranch ?? null,
    commit: snapshot?.revision.gitCommit ?? null,
    activeRun,
    badges: { work: needsYouCount, questions: openQuestionCount, runsActive: activeRun !== null },
    refreshedAt,
    onRefresh: reload,
    onPause: () => void submitAction({ kind: "pause" }, "dispatch"),
    onResume: () => void submitAction({ kind: "resume" }, "dispatch"),
    runNow: dispatch
      ? {
          disabled: runNowDisabledReason !== null,
          reason: runNowDisabledReason,
          confirmTitle: `Run the foreman on ${selectedConfiguration?.repositoryKey ?? "this repository"}?`,
          confirmBody: `Starts a foreman run on ${selectedConfiguration?.repositoryKey ?? "the repository"} now, ignoring the night window and minimum gap. ${providerLine}`,
          onConfirm: () => void submitAction({ kind: "run-now" }, "dispatch"),
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
