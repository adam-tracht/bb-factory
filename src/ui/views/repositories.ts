import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import {
  EMPTY_REPOSITORY_REVISION,
  type DispatchStatus,
  type FactoryActionResult,
  type RegistryOptionsProjection,
  type RepositoryProbe,
  type RepositorySelection,
  type SettingsMutationResult,
} from "../../contracts.js";
import type { ViewContext } from "../context.js";
import { repositoryLabel } from "../../repository-label.js";
import {
  ActionButton,
  Badge,
  Card,
  ConfirmDialog,
  EmptyNotice,
  ErrorNotice,
  LoadingNotice,
  StatusDot,
  type Tone,
} from "../primitives.js";

const h = createElement;

const inputClass =
  "w-full box-border rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelClass = "text-xs font-medium text-muted-foreground";

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

type SummaryLoader = (repositoryKey: string) => Promise<{
  attention: number;
  dispatch: DispatchStatus | null;
  error: string | null;
}>;

type SummaryState =
  | { status: "loading" }
  | { status: "ready"; attention: number }
  | { status: "error"; error: string };

function RepositoryRow(props: {
  repository: RepositorySelection;
  onSelect: () => void;
  loadSummary?: SummaryLoader;
}) {
  const { repository, onSelect, loadSummary } = props;
  const repositoryKey = repository.configuration.repositoryKey;
  const label = repositoryLabel(repositoryKey, repository.displayName);
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });

  useEffect(() => {
    if (!loadSummary) return;
    let cancelled = false;
    setSummary({ status: "loading" });
    void loadSummary(repositoryKey).then(
      (result) => {
        if (cancelled) return;
        setSummary(result.error
          ? { status: "error", error: result.error }
          : { status: "ready", attention: result.attention });
      },
      (error: unknown) => {
        if (!cancelled) {
          setSummary({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repositoryKey, loadSummary]);

  const attentionBadge = !loadSummary
    ? null
    : summary.status === "loading"
      ? h(Badge, { label: "…", tone: "neutral" })
      : summary.status === "error"
        ? h(Badge, { label: "!", tone: "danger", title: summary.error })
        : h(Badge, {
            label: `${summary.attention} need${summary.attention === 1 ? "s" : ""} attention`,
            tone: summary.attention > 0 ? "warning" : "neutral",
            title: `${summary.attention} item${summary.attention === 1 ? "" : "s"} need${summary.attention === 1 ? "s" : ""} attention`,
          });

  return h("button", {
    type: "button",
    className: "flex w-full box-border items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-state-hover",
    onClick: onSelect,
  },
    h("div", { className: "min-w-0 flex-1" },
      h("div", { className: "flex items-center gap-2" },
        h("span", { className: "truncate text-sm font-semibold text-foreground" }, label),
        repository.selected ? h(Badge, { label: "current", tone: "primary" }) : null),
      h("div", { className: "mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground" },
        h("span", { className: "font-mono" }, repository.configuration.connectedHostId),
        h("span", null, repository.configuration.factoryBranch))),
    h("div", { className: "flex shrink-0 items-center gap-2" },
      !repository.available
        ? h(Badge, {
            label: "unavailable",
            tone: "danger",
            title: repository.reasons.join("; ") || "Repository is unavailable",
          })
        : null,
      repository.dispatchPaused ? h(Badge, { label: "paused", tone: "warning" }) : null,
      attentionBadge));
}

export function RepositoryLandingView(props: {
  repositories: readonly RepositorySelection[];
  onSelect: (repositoryKey: string) => void;
  onAddRepository: () => void;
  loadSummary?: (repositoryKey: string) => Promise<{
    attention: number;
    dispatch: DispatchStatus | null;
    error: string | null;
  }>;
}): ReactNode {
  return h("div", { className: "space-y-4" },
    h("div", { className: "flex items-center justify-between gap-3" },
      h("h1", { className: "text-xl font-semibold" }, "Repositories"),
      h(ActionButton, { label: "Add repository", variant: "primary", onClick: props.onAddRepository })),
    props.repositories.length === 0
      ? h(EmptyNotice, {
          title: "No repositories configured",
          detail: "Add a repository registry entry to start dispatching factory runs.",
          action: h(ActionButton, { label: "Add repository", variant: "secondary", onClick: props.onAddRepository }),
        })
      : h("div", { className: "space-y-2" },
          props.repositories.map((repository) =>
            h(RepositoryRow, {
              key: repository.configuration.repositoryKey,
              repository,
              onSelect: () => props.onSelect(repository.configuration.repositoryKey),
              loadSummary: props.loadSummary,
            }))));
}

/* --------------------------------------------------------------------------
 * Guided add-repository quickstart: pick a folder, review derived values,
 * then a confirmed orchestration provisions the checkout, resolves the
 * project, writes the registry entry paused, and scaffolds plans/factory.
 * ------------------------------------------------------------------------ */

const REPOSITORY_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const FACTORY_BRANCH = "factory";

/** "worktree" provisions `<root>-factory`; "direct" registers the picked root; "existing" registers the worktree already holding the factory branch. */
export type CheckoutMode = "worktree" | "direct" | "existing";

export interface RegistrationPlan {
  readonly hostId: string;
  readonly root: string;
  readonly repositoryKey: string;
  readonly displayName: string;
  readonly mainRef: string;
  readonly mode: CheckoutMode;
  /** "existing" mode target: the worktree already holding the factory branch. */
  readonly existingCheckoutPath: string | null;
  readonly scaffoldPlanned: boolean;
  readonly projectName: string;
}

export type RegistrationStepId = "checkout" | "project" | "register" | "protocol";
export type RegistrationStepStatus = "pending" | "running" | "done" | "skipped" | "attention" | "failed";

export interface RegistrationStep {
  readonly id: RegistrationStepId;
  readonly label: string;
  readonly status: RegistrationStepStatus;
  readonly detail: string | null;
}

export interface RegistrationSession {
  plan: RegistrationPlan;
  steps: RegistrationStep[];
  result: {
    checkoutPath: string | null;
    branch: string | null;
    projectId: string | null;
    projectCreated: boolean | null;
    registered: boolean;
    scaffolded: "written" | "skipped" | null;
  };
  /** Set when the checkout step needs the operator to pick the fallback. */
  offer: { blockingWorktreePath: string | null } | null;
}

export type RegistrationContext = Pick<ViewContext, "runAction" | "resolveRepositoryProject" | "addRepository">;

const REGISTRATION_STEP_DEFS: ReadonlyArray<{ id: RegistrationStepId; label: string }> = [
  { id: "checkout", label: "Prepare the factory checkout" },
  { id: "project", label: "Resolve the BB project" },
  { id: "register", label: "Register the repository paused" },
  { id: "protocol", label: "Initialize plans/factory" },
];

export function createRegistrationSession(plan: RegistrationPlan): RegistrationSession {
  return {
    plan,
    steps: REGISTRATION_STEP_DEFS.map((step) => ({ ...step, status: "pending", detail: null })),
    result: {
      checkoutPath: null,
      branch: null,
      projectId: null,
      projectCreated: null,
      registered: false,
      scaffolded: null,
    },
    offer: null,
  };
}

/**
 * Re-aims a branch-in-use session at the existing factory checkout. The next
 * run re-executes only the checkout step; every later step stays pending.
 */
export function acceptExistingCheckoutOffer(session: RegistrationSession): void {
  if (session.offer === null) return;
  session.plan = {
    ...session.plan,
    mode: "existing",
    existingCheckoutPath: session.offer.blockingWorktreePath,
  };
  session.offer = null;
  session.steps = session.steps.map((step) =>
    step.id === "checkout" ? { ...step, status: "pending", detail: null } : step);
}

/**
 * Runs the registration steps in order, mutating `session` and calling
 * `report` after every visible transition. Resumable by construction: a retry
 * skips steps whose results are already recorded, and each RPC is safe to
 * re-run (provision re-probes worktrees, scaffold writes are create-only, a
 * duplicate registration reports conflict). Fresh intent keys per pass keep a
 * recorded ambiguous failure from replaying forever.
 */
export async function runRegistration(
  ctx: RegistrationContext,
  session: RegistrationSession,
  report: () => void,
  keygen: () => string = () => crypto.randomUUID(),
): Promise<"done" | "failed" | "attention"> {
  const { plan } = session;
  const keys = {
    provision: `bbf:v1:${plan.repositoryKey}:provision-checkout:${keygen()}`,
    scaffold: `bbf:v1:${plan.repositoryKey}:scaffold-protocol:${keygen()}`,
  };
  const setStep = (id: RegistrationStepId, status: RegistrationStepStatus, detail: string | null = null) => {
    session.steps = session.steps.map((step) => (step.id === id ? { ...step, status, detail } : step));
    report();
  };
  const failStep = (id: RegistrationStepId, error: unknown): "failed" => {
    setStep(id, "failed", errorText(error));
    return "failed";
  };

  if (session.result.checkoutPath === null) {
    setStep("checkout", "running");
    const target = plan.mode === "existing" && plan.existingCheckoutPath !== null
      ? plan.existingCheckoutPath
      : plan.root;
    let response: FactoryActionResult;
    try {
      response = await ctx.runAction({
        repositoryKey: plan.repositoryKey,
        action: {
          kind: "provision-checkout",
          mode: plan.mode === "worktree" ? "worktree" : "direct",
          hostId: plan.hostId,
          repositoryRoot: target,
        },
        idempotencyKey: keys.provision,
        expectedRevision: EMPTY_REPOSITORY_REVISION,
      });
    } catch (error) {
      return failStep("checkout", error);
    }
    if (!response.ok) return failStep("checkout", response.error.message);
    const outcome = response.result;
    if (outcome.action !== "provision-checkout") {
      return failStep("checkout", "The provision action returned an unexpected result shape.");
    }
    if (outcome.outcome === "branch-in-use") {
      session.offer = { blockingWorktreePath: outcome.blockingWorktreePath };
      setStep("checkout", "attention", outcome.message);
      return "attention";
    }
    session.result.checkoutPath = outcome.checkoutPath;
    session.result.branch = outcome.branch;
    setStep("checkout", "done", outcome.message);
  }

  if (session.result.projectId === null) {
    setStep("project", "running");
    let resolved: Awaited<ReturnType<RegistrationContext["resolveRepositoryProject"]>>;
    try {
      resolved = await ctx.resolveRepositoryProject({
        hostId: plan.hostId,
        path: plan.root,
        name: plan.projectName,
      });
    } catch (error) {
      return failStep("project", error);
    }
    session.result.projectId = resolved.projectId;
    session.result.projectCreated = resolved.created;
    setStep("project", "done", resolved.created
      ? `Created project '${resolved.label ?? resolved.projectId}'.`
      : `Using existing project '${resolved.label ?? resolved.projectId}'.`);
  }

  if (!session.result.registered) {
    setStep("register", "running");
    const checkoutPath = session.result.checkoutPath;
    const projectId = session.result.projectId;
    if (checkoutPath === null || projectId === null) {
      return failStep("register", "Registration cannot continue before the checkout and project steps complete.");
    }
    let registration: SettingsMutationResult;
    try {
      registration = await ctx.addRepository({
        configuration: {
          repositoryKey: plan.repositoryKey,
          repositoryRoot: plan.root,
          connectedHostId: plan.hostId,
          checkoutPath,
          mainRef: plan.mainRef,
        },
        projectId,
        dispatchPaused: true,
        ...(plan.displayName ? { displayName: plan.displayName } : {}),
      });
    } catch (error) {
      return failStep("register", error);
    }
    if (!registration.ok) {
      // A duplicate key means a previous pass already registered: resume.
      if (registration.error.category !== "conflict") {
        return failStep("register", registration.error.message);
      }
      session.result.registered = true;
      setStep("register", "done", `Repository '${repositoryLabel(plan.repositoryKey, plan.displayName || undefined)}' is already registered; resuming.`);
    } else {
      session.result.registered = true;
      setStep("register", "done", registration.message);
    }
  }

  if (session.result.scaffolded === null) {
    if (!plan.scaffoldPlanned) {
      session.result.scaffolded = "skipped";
      setStep("protocol", "skipped", "The checkout already has plans/factory files.");
    } else if (session.result.branch !== FACTORY_BRANCH) {
      // The scaffolder refuses a non-factory checkout; leave it for later.
      session.result.scaffolded = "skipped";
      setStep("protocol", "skipped",
        `The checkout is on '${session.result.branch ?? "no branch"}', not '${FACTORY_BRANCH}'. Switch the checkout and scaffold from Settings later.`);
    } else {
      setStep("protocol", "running");
      let response: FactoryActionResult;
      try {
        response = await ctx.runAction({
          repositoryKey: plan.repositoryKey,
          action: { kind: "scaffold-protocol" },
          idempotencyKey: keys.scaffold,
          expectedRevision: EMPTY_REPOSITORY_REVISION,
        });
      } catch (error) {
        return failStep("protocol", error);
      }
      if (!response.ok) return failStep("protocol", response.error.message);
      const outcome = response.result;
      if (outcome.action !== "scaffold-protocol") {
        return failStep("protocol", "The scaffold action returned an unexpected result shape.");
      }
      session.result.scaffolded = "written";
      setStep("protocol", "done", outcome.message);
    }
  }

  return "done";
}

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/u, "") === right.replace(/[\\/]+$/u, "");
}

function folderName(path: string): string {
  const segments = path.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? path;
}

/** Mode default: an existing factory checkout wins over a fresh worktree. */
function defaultCheckoutMode(probe: RepositoryProbe): CheckoutMode {
  const holder = probe.factoryBranchState.checkedOutPath;
  if (probe.factoryBranchState.exists && holder !== null) {
    if (samePath(holder, probe.path)) return "direct";
    if (!samePath(holder, probe.checkoutSuggestion)) return "existing";
  }
  return "worktree";
}

type OptionsState =
  | { status: "loading" }
  | { status: "ready"; options: RegistryOptionsProjection }
  | { status: "error"; error: string };

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string };

/** Local label/control/error row: Field renders dt/dd, form rows need aria-labels. */
function FormRow(props: {
  label: string;
  children?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
}) {
  return h("div", { className: "min-w-0" },
    h("span", { className: labelClass }, props.label),
    h("div", { className: "mt-1" }, props.children),
    props.error
      ? h("p", { className: "mt-1 text-xs text-destructive" }, props.error)
      : props.hint
        ? h("p", { className: "mt-1 text-xs text-muted-foreground" }, props.hint)
        : null);
}

const STEP_TONE: Record<RegistrationStepStatus, Tone> = {
  pending: "neutral",
  running: "primary",
  done: "success",
  skipped: "neutral",
  attention: "warning",
  failed: "danger",
};

const STEP_STATUS_LABEL: Record<RegistrationStepStatus, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  skipped: "skipped",
  attention: "needs you",
  failed: "failed",
};

export function AddRepositoryView(props: {
  ctx: ViewContext;
  onDone: (repositoryKey: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { ctx, onDone, onCancel } = props;
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [stage, setStage] = useState<"pick" | "review" | "submit">("pick");
  const [hostId, setHostId] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickNote, setPickNote] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<ProbeState>({ status: "idle" });
  const [probe, setProbe] = useState<RepositoryProbe | null>(null);
  const [repositoryKey, setRepositoryKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mainRef, setMainRef] = useState("origin/main");
  const [mode, setMode] = useState<CheckoutMode>("worktree");
  const [errors, setErrors] = useState<{ repositoryKey?: string; displayName?: string; mainRef?: string }>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [draftGoal, setDraftGoal] = useState("");
  const [draftPlanPath, setDraftPlanPath] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const sessionRef = useRef<RegistrationSession | null>(null);
  const [, setTick] = useState(0);
  const report = () => setTick((tick) => tick + 1);

  useEffect(() => {
    let cancelled = false;
    setOptionsState({ status: "loading" });
    void ctx.loadRegistryOptions().then(
      (options) => {
        if (!cancelled) setOptionsState({ status: "ready", options });
      },
      (error: unknown) => {
        if (!cancelled) {
          setOptionsState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctx, reloadToken]);

  const runProbe = (probeHostId: string, path: string) => {
    setProbeState({ status: "loading" });
    void ctx.probeRepository({ hostId: probeHostId, path }).then(
      (result) => {
        if (!result.isGitRepo) {
          setProbeState({ status: "idle" });
          setPickNote({ tone: "error", text: `'${result.path}' is not a Git repository. Choose the repository root folder.` });
          return;
        }
        setProbe(result);
        setProbeState({ status: "idle" });
        setRepositoryKey(result.suggestedKey);
        setDisplayName(folderName(result.path));
        setMainRef(result.mainRef);
        setMode(defaultCheckoutMode(result));
        setErrors({});
        setStage("review");
      },
      (error: unknown) => setProbeState({ status: "error", error: errorText(error) }),
    );
  };

  const chooseFolder = () => {
    setPicking(true);
    setPickNote(null);
    void ctx.pickRepositoryFolder(effectiveHostId ? { hostId: effectiveHostId } : {}).then(
      (picked) => {
        setPicking(false);
        if (picked.path === null) {
          setPickNote({ tone: "info", text: "Folder pick canceled." });
          return;
        }
        setHostId(picked.hostId);
        setPickedPath(picked.path);
        runProbe(picked.hostId, picked.path);
      },
      (error: unknown) => {
        setPicking(false);
        setPickNote({ tone: "error", text: errorText(error) });
      },
    );
  };

  const runSession = (current: RegistrationSession) => {
    setRunning(true);
    setFatalError(null);
    void runRegistration(ctx, current, report).then(
      (outcome) => {
        setRunning(false);
        report();
        // A registration that lands on 'factory' ends on the draft card; anything else finishes here.
        if (outcome === "done" && current.result.branch !== FACTORY_BRANCH) {
          onDone(current.plan.repositoryKey);
        }
      },
      (error: unknown) => {
        setRunning(false);
        setFatalError(errorText(error));
        report();
      },
    );
  };

  const startDrafting = (current: RegistrationSession) => {
    const goal = draftGoal.trim();
    if (goal === "" || drafting) return;
    setDrafting(true);
    setDraftError(null);
    const planPath = draftPlanPath.trim();
    // No provider triple: the drafting thread uses the project's stored defaults.
    void ctx.runAction({
      repositoryKey: current.plan.repositoryKey,
      action: {
        kind: "draft-tasks",
        goal,
        ...(planPath !== "" ? { planPath } : {}),
      },
      idempotencyKey: `bbf:v1:${current.plan.repositoryKey}:draft-tasks:${crypto.randomUUID()}`,
    }).then(
      (result) => {
        setDrafting(false);
        if (result.ok && result.result.action === "draft-tasks") {
          ctx.onOpenThread(result.result.threadId);
          return;
        }
        setDraftError(result.ok ? "The draft request returned an unexpected result." : result.error.message);
      },
      (error: unknown) => {
        setDrafting(false);
        setDraftError(errorText(error));
      },
    );
  };

  const startSubmit = () => {
    if (!probe) return;
    const plan: RegistrationPlan = {
      hostId: probe.hostId,
      root: probe.path,
      repositoryKey: repositoryKey.trim(),
      displayName: displayName.trim(),
      mainRef: mainRef.trim(),
      mode,
      existingCheckoutPath: mode === "existing" ? probe.factoryBranchState.checkedOutPath : null,
      scaffoldPlanned: !probe.hasProtocol,
      projectName: folderName(probe.path),
    };
    const next = createRegistrationSession(plan);
    sessionRef.current = next;
    setStage("submit");
    runSession(next);
  };

  const submit = () => {
    const found: { repositoryKey?: string; displayName?: string; mainRef?: string } = {};
    if (!REPOSITORY_KEY_RE.test(repositoryKey.trim())) {
      found.repositoryKey = "Lowercase letters, digits, dots, dashes, or underscores; start with a letter or digit.";
    }
    if (displayName.trim().length > 64) found.displayName = "Use 64 characters or fewer.";
    if (!mainRef.trim()) found.mainRef = "Enter the main ref.";
    setErrors(found);
    if (Object.keys(found).length === 0) setConfirmOpen(true);
  };

  const header = h("div", { className: "flex items-center gap-3" },
    h(ActionButton, { label: "Back", variant: "ghost", size: "sm", disabled: drafting, onClick: onCancel }),
    h("h1", { className: "text-xl font-semibold" }, "Add repository"));

  if (optionsState.status === "loading") {
    return h("div", { className: "space-y-4" }, header, h(LoadingNotice, { label: "Loading connected hosts" }));
  }
  if (optionsState.status === "error") {
    return h("div", { className: "space-y-4" },
      header,
      h(ErrorNotice, {
        message: optionsState.error,
        onRetry: () => setReloadToken((token) => token + 1),
      }));
  }

  const options = optionsState.options;
  const usableHosts = options.hosts.filter((host) => host.status !== "disconnected");
  const effectiveHostId = hostId || (usableHosts.length === 1 ? usableHosts[0]!.hostId : "");
  const session = sessionRef.current;

  /* ---- stage 3: the confirmed orchestration ---- */
  if (stage === "submit" && session !== null) {
    const failed = session.steps.some((step) => step.status === "failed");
    const offer = session.offer;
    const allTerminal = session.steps.every((step) => step.status === "done" || step.status === "skipped");
    const showDraftCard = allTerminal && !failed && offer === null && session.result.branch === FACTORY_BRANCH;
    return h("div", { className: "space-y-4" },
      header,
      h(Card, {
        title: `Registering '${repositoryLabel(session.plan.repositoryKey, session.plan.displayName || undefined)}'`,
        children: [
          h("ol", { key: "steps", className: "space-y-2" },
            session.steps.map((step) =>
              h("li", { key: step.id, className: "flex items-start gap-2 text-sm" },
                h("span", { className: "mt-1.5" }, h(StatusDot, { tone: STEP_TONE[step.status], pulse: step.status === "running" })),
                h("div", { className: "min-w-0" },
                  h("span", { className: "font-medium text-foreground" }, step.label),
                  h("span", { className: "ml-2 text-xs text-muted-foreground" }, STEP_STATUS_LABEL[step.status]),
                  step.detail
                    ? h("p", {
                        className: `mt-0.5 text-xs ${step.status === "failed" ? "text-destructive" : "text-muted-foreground"}`,
                      }, step.detail)
                    : null)))),
          offer !== null
            ? h("div", {
                key: "offer",
                className: "mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5",
              },
                h("p", { className: "text-xs text-warning" },
                  offer.blockingWorktreePath !== null
                    ? `The '${FACTORY_BRANCH}' branch is already checked out at '${offer.blockingWorktreePath}'.`
                    : `The '${FACTORY_BRANCH}' branch is checked out in another worktree.`),
                h("div", { className: "mt-2 flex items-center gap-2" },
                  offer.blockingWorktreePath !== null
                    ? h(ActionButton, {
                        label: "Use the existing factory checkout",
                        variant: "primary",
                        size: "sm",
                        onClick: () => {
                          acceptExistingCheckoutOffer(session);
                          report();
                          runSession(session);
                        },
                      })
                    : null))
            : null,
          fatalError !== null
            ? h("p", { key: "fatal", className: "mt-3 text-sm text-destructive" }, fatalError)
            : null,
          h("div", { key: "actions", className: "mt-4 flex items-center gap-2" },
            failed && offer === null
              ? h(ActionButton, { label: "Retry", variant: "primary", onClick: () => runSession(session), busy: running })
              : null,
            failed || offer !== null
              ? h(ActionButton, {
                  label: "Back to review",
                  variant: "secondary",
                  onClick: () => setStage("review"),
                  disabled: running,
                })
              : null),
        ],
      }),
      showDraftCard
        ? h(Card, {
            title: "Draft tasks",
            children: [
              h("p", {
                key: "copy",
                className: "text-sm text-muted-foreground",
              }, `An agent chat on the new checkout can draft the first queue entries from a goal. It writes only 'status: draft' entries and commits them on '${FACTORY_BRANCH}'; approving drafts for a run stays a human step.`),
              h("div", { key: "fields", className: "mt-3 space-y-3" },
                h(FormRow, { label: "Goal" },
                  h("textarea", {
                    "aria-label": "Goal for drafted tasks",
                    className: `${inputClass} min-h-20`,
                    value: draftGoal,
                    onChange: (event: { target: { value: string } }) => setDraftGoal(event.target.value),
                  })),
                h(FormRow, { label: "Plan file (optional)" },
                  h("input", {
                    type: "text",
                    "aria-label": "Plan file (optional)",
                    className: `${inputClass} font-mono`,
                    value: draftPlanPath,
                    onChange: (event: { target: { value: string } }) => setDraftPlanPath(event.target.value),
                  }))),
              draftError !== null
                ? h("p", { key: "draft-error", className: "mt-3 text-sm text-destructive" }, draftError)
                : null,
              h("div", { key: "actions", className: "mt-4 flex items-center gap-2" },
                h(ActionButton, {
                  label: "Start drafting",
                  variant: "primary",
                  onClick: () => startDrafting(session),
                  busy: drafting,
                  disabled: draftGoal.trim() === "",
                }),
                h(ActionButton, {
                  label: "Finish",
                  variant: "secondary",
                  disabled: drafting,
                  onClick: () => onDone(session.plan.repositoryKey),
                })),
            ],
          })
        : null);
  }

  /* ---- stage 1: pick the folder on a resolved host ---- */
  if (stage === "pick" || probe === null) {
    const hostControl = usableHosts.length > 1
      ? h("select", {
          "aria-label": "Host for the folder pick",
          className: inputClass,
          value: hostId,
          onChange: (event: { target: { value: string } }) => setHostId(event.target.value),
        },
          h("option", { value: "" }, "Select a host"),
          usableHosts.map((host) =>
            h("option", { key: host.hostId, value: host.hostId }, host.label ?? host.hostId)))
      : usableHosts.length === 1
        ? h("p", { className: "text-sm text-muted-foreground" },
            `Choose the folder on this machine (${usableHosts[0]!.label ?? usableHosts[0]!.hostId}).`)
        : null;

    return h("div", { className: "space-y-4" },
      header,
      usableHosts.length === 0
        ? h(EmptyNotice, {
            title: "No connected BB host",
            detail: "Connect a host in bb, then reopen this page.",
          })
        : h(Card, {
            title: "Connect a repository",
            children: [
              h("p", {
                key: "intro",
                className: "text-sm text-muted-foreground",
              }, "Pick the repository folder. The factory derives the key, checkout, project, and protocol state for you; registration ends paused."),
              hostControl
                ? h("div", { key: "host" }, hostControl)
                : null,
              pickedPath !== null
                ? h("p", { key: "picked", className: "font-mono text-xs text-muted-foreground" }, pickedPath)
                : null,
              probeState.status === "loading"
                ? h(LoadingNotice, { key: "probing", label: "Probing the picked folder" })
                : null,
              probeState.status === "error"
                ? h(ErrorNotice, {
                    key: "probe-error",
                    message: probeState.error,
                    onRetry: pickedPath !== null && hostId !== ""
                      ? () => runProbe(hostId, pickedPath)
                      : undefined,
                  })
                : null,
              pickNote !== null
                ? h("p", {
                    key: "pick-note",
                    className: `text-sm ${pickNote.tone === "error" ? "text-destructive" : "text-muted-foreground"}`,
                  }, pickNote.text)
                : null,
              h("div", { key: "pick", className: "mt-1" },
                h(ActionButton, {
                  label: "Choose repository folder",
                  variant: "primary",
                  onClick: chooseFolder,
                  busy: picking,
                  disabled: effectiveHostId === "",
                })),
            ],
          }));
  }

  /* ---- stage 2: review derived values ---- */
  const holder = probe.factoryBranchState.checkedOutPath;
  const factoryAtRoot = probe.factoryBranchState.exists && holder !== null && samePath(holder, probe.path);
  const factoryAtSuggestion = probe.factoryBranchState.exists && holder !== null && samePath(holder, probe.checkoutSuggestion);
  const factoryElsewhere = probe.factoryBranchState.exists && holder !== null && !factoryAtRoot && !factoryAtSuggestion;

  const modeOptions: Array<{ value: CheckoutMode; label: string; path: string; note: string | null; disabled: boolean }> = [
    {
      value: "worktree",
      label: "Dedicated factory worktree",
      path: probe.checkoutSuggestion,
      note: factoryElsewhere
        ? `Unavailable: '${FACTORY_BRANCH}' is checked out at '${holder}'.`
        : factoryAtSuggestion
          ? "Already provisioned on 'factory'."
          : `Runs 'git worktree add' and creates the '${FACTORY_BRANCH}' branch when missing.`,
      disabled: factoryElsewhere,
    },
    ...(factoryElsewhere && holder !== null
      ? [{
          value: "existing" as const,
          label: "Use the existing factory checkout",
          path: holder,
          note: `'${FACTORY_BRANCH}' is already checked out here.`,
          disabled: false,
        }]
      : []),
    {
      value: "direct",
      label: "Use this checkout directly",
      path: probe.path,
      note: probe.currentBranch === FACTORY_BRANCH
        ? `Already on '${FACTORY_BRANCH}'.`
        : `Currently on '${probe.currentBranch ?? "no branch"}'; runs need '${FACTORY_BRANCH}'.`,
      disabled: false,
    },
  ];

  const visibleLabel = repositoryLabel(repositoryKey.trim(), displayName.trim() || undefined);
  const confirmLines: string[] = [
    mode === "worktree"
      ? `Creates the worktree '${probe.checkoutSuggestion}' on '${FACTORY_BRANCH}' (the branch is created from '${mainRef.trim()}' when missing).`
      : mode === "existing" && probe.factoryBranchState.checkedOutPath !== null
        ? `Registers the existing factory checkout at '${probe.factoryBranchState.checkedOutPath}'.`
        : `Registers '${probe.path}' directly${probe.currentBranch === FACTORY_BRANCH ? "" : ` (it is on '${probe.currentBranch ?? "no branch"}', not '${FACTORY_BRANCH}')`}.`,
    probe.projectMatch !== null
      ? `Uses the existing project '${probe.projectMatch.label ?? probe.projectMatch.projectId}'.`
      : `Creates a BB project named '${folderName(probe.path)}'.`,
    `Registers '${visibleLabel}' with dispatch paused.`,
    probe.hasProtocol
      ? "Keeps the existing plans/factory protocol files."
      : `Writes the plans/factory protocol files and commits them on '${FACTORY_BRANCH}'.`,
  ];

  return h("div", { className: "space-y-4" },
    header,
    h(Card, {
      title: "Review the registration",
      children: [
        h("div", { key: "path", className: "mb-3 flex items-center justify-between gap-3" },
          h("code", { className: "truncate font-mono text-xs text-muted-foreground", title: probe.path }, probe.path),
          h(ActionButton, {
            label: "Different folder",
            variant: "ghost",
            size: "sm",
            onClick: () => {
              setStage("pick");
              setProbe(null);
              setProbeState({ status: "idle" });
            },
          })),
        h("div", { key: "fields", className: "grid gap-4 sm:grid-cols-2" },
          h(FormRow, {
            label: "Repository key",
            error: errors.repositoryKey,
            hint: "Lowercase letters, digits, dots, dashes, underscores.",
          },
            h("input", {
              type: "text",
              "aria-label": "Repository key",
              className: `${inputClass} font-mono`,
              value: repositoryKey,
              onChange: (event: { target: { value: string } }) => {
                setRepositoryKey(event.target.value);
                setErrors((current) => ({ ...current, repositoryKey: undefined }));
              },
            })),
          h(FormRow, {
            label: "Display name",
            error: errors.displayName,
            hint: "Optional friendly name shown in the Factory UI, up to 64 characters.",
          },
            h("input", {
              type: "text",
              "aria-label": "Display name",
              maxLength: 64,
              className: inputClass,
              value: displayName,
              onChange: (event: { target: { value: string } }) => {
                setDisplayName(event.target.value);
                setErrors((current) => ({ ...current, displayName: undefined }));
              },
            })),
          h(FormRow, { label: "Main ref", error: errors.mainRef },
            h("input", {
              type: "text",
              "aria-label": "Main ref",
              className: `${inputClass} font-mono`,
              value: mainRef,
              onChange: (event: { target: { value: string } }) => {
                setMainRef(event.target.value);
                setErrors((current) => ({ ...current, mainRef: undefined }));
              },
            }))),
        h("fieldset", { key: "mode", className: "mt-4 space-y-2", "aria-label": "Checkout" },
          h("legend", { className: labelClass }, "Checkout"),
          modeOptions.map((option) =>
            h("label", {
              key: option.value,
              className: `flex items-start gap-2 rounded-md border p-2.5 ${mode === option.value ? "border-primary" : "border-border"} ${option.disabled ? "opacity-60" : "cursor-pointer"}`,
            },
              h("input", {
                type: "radio",
                name: "factory-checkout-mode",
                className: "mt-0.5",
                checked: mode === option.value,
                disabled: option.disabled,
                "aria-label": option.label,
                onChange: () => setMode(option.value),
              }),
              h("span", { className: "min-w-0" },
                h("span", { className: "block text-sm font-medium" }, option.label),
                h("span", { className: "block truncate font-mono text-xs text-muted-foreground" }, option.path),
                option.note !== null
                  ? h("span", { className: "block text-xs text-muted-foreground" }, option.note)
                  : null)))),
        h("div", { key: "notes", className: "mt-4 space-y-1" },
          h("p", { className: "text-xs text-muted-foreground" },
            probe.hasProtocol
              ? "plans/factory protocol files found; they stay untouched."
              : `No plans/factory yet; it will be initialized on '${FACTORY_BRANCH}'.`),
          h("p", { className: "text-xs text-muted-foreground" },
            probe.projectMatch !== null
              ? `Project: ${probe.projectMatch.label ?? probe.projectMatch.projectId}.`
              : `No project matches this path; one will be created.`),
          h("p", { className: "text-xs text-muted-foreground" },
            "Registration ends paused; no runs are scheduled until you enable dispatch.")),
        h("div", { key: "submit", className: "mt-4 flex items-center gap-2" },
          h(ActionButton, { label: "Register repository", variant: "primary", onClick: submit })),
        h(ConfirmDialog, {
          key: "confirm",
          open: confirmOpen,
          title: `Register '${visibleLabel}'?`,
          body: h("ul", { className: "list-disc space-y-1 pl-4" },
            confirmLines.map((line) => h("li", { key: line }, line))),
          confirmLabel: "Register repository",
          busy: running,
          onConfirm: () => {
            setConfirmOpen(false);
            startSubmit();
          },
          onCancel: () => setConfirmOpen(false),
        }),
      ],
    }));
}
