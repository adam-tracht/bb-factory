import { createElement, Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  DispatchStatus,
  OperationalRunSummary,
  ProviderStatus,
  RepositoryKey,
  RepositorySelection,
} from "../contracts.js";
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CopyText,
  StatusDot,
  formatDuration,
  shortSha,
  timeAgo,
  type Tone,
} from "./primitives.js";
import type { FactorySection } from "./context.js";
import { repositoryLabel } from "../repository-label.js";
import { ProviderModelPicker, providerModelPickerBound, seedPickerValue, type PickerRouting, type PickerValue } from "./providerPicker.js";

const h = createElement;

export type { FactorySection };

const SECTION_TABS: Array<{ section: FactorySection; label: string }> = [
  { section: "overview", label: "Overview" },
  { section: "work", label: "Work" },
  { section: "questions", label: "Questions" },
  { section: "runs", label: "Runs" },
  { section: "settings", label: "Settings" },
];

const ALL_REPOSITORIES_VALUE = "__all__";

export interface ShellRunNow {
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly confirmTitle: string;
  readonly confirmBody: ReactNode;
  /** Live provider catalog for the picker's seed; empty or absent keeps the plain confirm. */
  readonly providers?: readonly ProviderStatus[];
  readonly preferredProviderId?: string | null;
  readonly pickerRouting?: PickerRouting;
  /** True when the bound picker has a usable seed; only then does the dialog offer a custom pick. */
  readonly canPickProvider?: boolean;
  /** Explains the automatic pick (configured preference/rotation) while the picker is bound. */
  readonly automaticHint?: ReactNode;
  /** Receives the picked execution triple, or null when the automatic default is confirmed. */
  readonly onConfirm: (selection: PickerValue | null) => void;
}

export interface FactoryShellProps {
  readonly section: FactorySection;
  readonly onNavigate: (section: FactorySection) => void;
  readonly repositories: readonly RepositorySelection[];
  readonly selectedRepositoryKey: RepositoryKey | null;
  /** True whenever the rendered route is aggregate, including while its registry is loading or failed. */
  readonly aggregateScope: boolean;
  /** True while the repositories landing is the rendered content: the "All" control owns the active state. */
  readonly repositoriesActive: boolean;
  /** True while the add-repository wizard is the content: suppresses repo chrome and every pressed switcher state. */
  readonly wizardMode?: boolean;
  /** Sections rendered in the tab strip; defaults to all five. The aggregate scope passes the four repo-union tabs (no Settings). */
  readonly tabs?: readonly FactorySection[];
  readonly repositorySelectionLoading: boolean;
  readonly onSelectRepository: (repositoryKey: RepositoryKey) => void;
  readonly onShowRepositories: (section?: FactorySection) => void;
  readonly onAddRepository: () => void;
  readonly dispatch: DispatchStatus | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly activeRun: OperationalRunSummary | null;
  readonly badges: { work: number; questions: number; runsActive: boolean };
  readonly refreshedAt: number | null;
  readonly onRefresh: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly runNow: ShellRunNow | null;
  readonly actionPending: boolean;
  readonly connectionState: "connected" | "reconnecting" | "disconnected";
  readonly malformedSignal: boolean;
  readonly children: ReactNode;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function RefreshIcon() {
  return h("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: "h-3.5 w-3.5 shrink-0",
    "aria-hidden": "true",
    focusable: "false",
  },
    h("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
    h("path", { d: "M21 3v5h-5" }),
    h("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
    h("path", { d: "M8 16H3v5" }));
}

function dispatchChip(dispatch: DispatchStatus | null): { label: string; tone: Tone } | null {
  if (!dispatch) return null;
  if (dispatch.mode !== "enabled") return { label: "Dispatch paused", tone: "warning" };
  if (dispatch.repositoryPaused) return { label: "Repo paused", tone: "warning" };
  return { label: "Dispatch on", tone: "success" };
}

function RepositorySwitcher(props: Pick<FactoryShellProps,
  "section" | "repositories" | "selectedRepositoryKey" | "repositoriesActive" | "wizardMode" | "repositorySelectionLoading" | "onSelectRepository" | "onShowRepositories" | "onAddRepository"
>) {
  const { section, repositories, selectedRepositoryKey, repositoriesActive, wizardMode, repositorySelectionLoading, onSelectRepository, onShowRepositories, onAddRepository } = props;
  // The wizard is not repository-scoped: while it renders, neither "All" nor
  // any repository pill may show a pressed or selected state.
  const wizard = wizardMode === true;
  const allActive = repositoriesActive && !wizard;
  const selectVariant = (wrapperClass: string) => h("div", {
    className: `flex min-w-0 items-center gap-1 transition-opacity ${wrapperClass} ${repositorySelectionLoading ? "opacity-60" : ""}`,
    "aria-busy": repositorySelectionLoading,
  },
    h(ActionButton, { label: "All", variant: allActive ? "secondary" : "ghost", size: "xs", className: "min-h-8 sm:min-h-0", onClick: () => onShowRepositories(section) }),
    h("select", {
      "aria-label": "Configured repository",
      className: "min-h-8 max-w-[8rem] rounded-md border border-border bg-background px-2 py-1 text-sm sm:min-h-0 sm:max-w-none",
      value: wizard ? "" : repositoriesActive ? ALL_REPOSITORIES_VALUE : selectedRepositoryKey ?? "",
      onChange: (event: { target: { value: string } }) => {
        if (event.target.value === ALL_REPOSITORIES_VALUE) onShowRepositories(section);
        else if (event.target.value) onSelectRepository(event.target.value);
      },
    },
      wizard
        ? h("option", { value: "", disabled: true, hidden: true }, "")
        : null,
      repositoriesActive
        ? h("option", { value: ALL_REPOSITORIES_VALUE }, "All repositories")
        : null,
      repositories.map((repo) =>
        h("option", { key: repo.configuration.repositoryKey, value: repo.configuration.repositoryKey },
          repositoryLabel(repo.configuration.repositoryKey, repo.displayName)))),
    h("button", {
      type: "button",
      className: "inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground active:translate-y-px sm:min-h-6 sm:min-w-6",
      onClick: onAddRepository,
      title: "Add repository",
      "aria-label": "Add repository",
    }, "+"));
  if (repositories.length > 4) {
    return selectVariant("");
  }
  // The select is the picker below sm; the segmented control shows at sm and up.
  return h(Fragment, null,
    selectVariant("sm:hidden"),
    h("div", {
      className: `hidden items-center gap-1 rounded-lg bg-muted/60 p-1 transition-opacity sm:flex ${repositorySelectionLoading ? "opacity-60" : ""}`,
      role: "group",
      "aria-label": "Configured repository",
      "aria-busy": repositorySelectionLoading,
    },
      h("button", {
        type: "button",
        "aria-pressed": allActive,
        className: `rounded-md px-2 py-1 text-xs font-medium transition-colors ${
          allActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
        }`,
        onClick: () => onShowRepositories(section),
        title: "All repositories",
      }, "All"),
      repositories.map((repo) => {
        const key = repo.configuration.repositoryKey;
        const label = repositoryLabel(key, repo.displayName);
        const active = !repositoriesActive && !wizard && key === selectedRepositoryKey;
        return h("button", {
          key,
          type: "button",
          "aria-pressed": active,
          className: `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`,
          title: repo.dispatchPaused ? `${label} (dispatch paused)` : label,
          onClick: () => onSelectRepository(key),
        },
          repo.dispatchPaused ? h(StatusDot, { tone: "warning" }) : null,
          label);
      }),
      h("button", {
        type: "button",
        className: "min-h-8 min-w-8 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-6 sm:min-w-6",
        onClick: onAddRepository,
        title: "Add repository",
        "aria-label": "Add repository",
      }, "+")));
}

function ChipLegend({ onClose }: { onClose: () => void }) {
  const rows: Array<{ tone: Tone; label: string; meaning: string }> = [
    { tone: "success", label: "green", meaning: "done, healthy, enabled" },
    { tone: "warning", label: "amber", meaning: "needs you or paused" },
    { tone: "danger", label: "red", meaning: "failed or unavailable" },
    { tone: "primary", label: "blue", meaning: "running" },
    { tone: "neutral", label: "gray", meaning: "neutral or idle" },
  ];
  const extras: Array<{ sample: ReactNode; label: string }> = [
    {
      sample: h("span", { className: "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" }, "run_1a2b"),
      label: "Mono chips are ids (runs, threads, tasks); click a copy control where shown",
    },
    {
      sample: h("span", { className: "rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" }, "acp-devin"),
      label: "Provider chip: which agent provider ran it",
    },
    {
      sample: h("span", { className: "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" }, "host-a1"),
      label: "Host id: the machine the run executed on",
    },
    {
      sample: h("span", { className: "rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" }, "current"),
      label: "Current: the attempt or run in progress",
    },
  ];
  return h("div", {
    className: "absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-card p-3 shadow-lg",
    role: "dialog",
    "aria-label": "Chip legend",
  },
    h("div", { className: "mb-2 flex items-center justify-between" },
      h("p", { className: "text-xs font-semibold" }, "What the colors mean"),
      h("button", { type: "button", className: "text-xs text-muted-foreground hover:text-foreground", onClick: onClose }, "Close")),
    h("ul", { className: "space-y-1.5" },
      rows.map((row) => h("li", { key: row.label, className: "flex items-center gap-2 text-xs" },
        h(StatusDot, { tone: row.tone }),
        h("span", { className: "w-10 shrink-0 text-muted-foreground" }, row.label),
        h("span", { className: "text-foreground" }, row.meaning)))),
    h("div", { className: "my-2 border-t border-border" }),
    h("ul", { className: "space-y-1.5" },
      extras.map((row) => h("li", { key: row.label, className: "flex items-center gap-2 text-xs" },
        row.sample,
        h("span", { className: "text-foreground" }, row.label)))));
}

export function FactoryShell(props: FactoryShellProps) {
  const now = useNow(15000);
  const [legendOpen, setLegendOpen] = useState(false);
  const [runNowOpen, setRunNowOpen] = useState(false);
  const [runNowSelection, setRunNowSelection] = useState<PickerValue | null>(null);
  const [runNowCustom, setRunNowCustom] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const seenRefreshedAtRef = useRef<number | null>(props.refreshedAt);
  const tabStripRef = useRef<HTMLElement | null>(null);
  const chip = dispatchChip(props.dispatch);
  const run = props.activeRun;
  const runElapsed = run?.startedAt ? formatDuration(run.startedAt, null, now) : null;
  // The repositories landing and the add wizard are not scoped to one
  // repository, so none of the per-repo chrome (branch chip, dispatch state,
  // run controls) may render above them. The aggregate scope still shows the
  // tab strip: its four union tabs are repo-neutral.
  const repoChrome = !props.aggregateScope && !props.repositoriesActive && props.wizardMode !== true;
  const tabs = props.tabs ? SECTION_TABS.filter((tab) => props.tabs!.includes(tab.section)) : SECTION_TABS;
  const showTabs = tabs.length > 0 && (repoChrome || props.aggregateScope || props.repositoriesActive) && props.wizardMode !== true;
  const refreshedLabel = props.refreshedAt !== null
    ? `refreshed ${timeAgo(new Date(props.refreshedAt).toISOString(), now) ?? "just now"}`
    : null;
  const expectedBranch = props.branch === "factory";
  const branchChip = repoChrome && (props.branch || props.commit)
    ? h("span", { className: "inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground" },
        props.branch && !expectedBranch
          ? h("span", { className: "sm:hidden" }, `Branch: ${props.branch}`)
          : null,
        props.branch
          ? h("span", { className: "hidden sm:inline" }, props.branch)
          : null,
        props.commit
          ? h("span", { className: "hidden sm:inline-flex" },
              h(CopyText, { value: props.commit, label: `@${shortSha(props.commit)}`, mono: true }))
          : null)
    : null;
  const dispatchBadge = repoChrome && chip ? h(Badge, {
    label: chip.label,
    tone: chip.tone,
    title: props.dispatch?.reason ?? undefined,
  }) : null;
  const runBadge = repoChrome
    ? run
      ? h(Badge, {
          label: `Running ${runElapsed ? `${runElapsed} ` : ""}${run.providerId ? `· ${run.providerId}` : ""}`,
          tone: "primary",
          title: `Run ${run.runId}${run.queueItemIds.length > 0 ? ` on ${run.queueItemIds.join(", ")}` : ""}`,
        })
      : props.dispatch && chip?.tone === "success"
        ? h(Badge, { label: "Idle", tone: "neutral", title: "No run in progress" })
        : null
    : null;
  const statusGroup = h("div", { className: "flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap text-muted-foreground" },
    branchChip, dispatchBadge, runBadge);
  const pauseControl = repoChrome && props.dispatch
    ? h(ActionButton, {
        label: props.dispatch.mode === "enabled" ? "Pause" : "Resume",
        variant: "secondary",
        size: "xs",
        className: "min-h-8 min-w-8 sm:min-h-0 sm:min-w-0 sm:order-4",
        title: "Stops new runs. Running runs continue.",
        onClick: props.dispatch.mode === "enabled" ? props.onPause : props.onResume,
        disabled: props.actionPending,
      })
    : null;
  const runNowControl = repoChrome && props.runNow
    ? h(ActionButton, {
        label: "Run now",
        variant: "primary",
        size: "xs",
        className: "min-h-8 min-w-8 sm:min-h-0 sm:min-w-0 sm:order-4",
        title: props.runNow.disabled ? props.runNow.reason ?? "Unavailable" : "Start a run immediately",
        disabled: props.runNow.disabled || props.actionPending,
        onClick: () => {
          // Seed once per open so a canceled dialog never leaks a stale pick;
          // the override stays opt-in behind the "Choose provider" radio.
          const runNow = props.runNow;
          setRunNowSelection(runNow?.canPickProvider === true
            ? seedPickerValue(runNow.providers ?? [], runNow.preferredProviderId ?? null)
            : null);
          setRunNowCustom(false);
          setRunNowOpen(true);
        },
      })
    : null;
  const mobileDispatch = repoChrome && props.dispatch
    ? h(Badge, {
        label: props.dispatch.mode === "enabled" && !props.dispatch.repositoryPaused ? "Enabled" : "Paused",
        tone: props.dispatch.mode === "enabled" && !props.dispatch.repositoryPaused ? "success" : "warning",
      })
    : null;
  const mobileBranch = repoChrome && props.branch && !expectedBranch
    ? h("span", { className: "shrink-0 font-mono text-xs text-muted-foreground sm:hidden" }, `Branch: ${props.branch}`)
    : null;
  useEffect(() => {
    const active = tabStripRef.current?.querySelector('[aria-selected="true"]');
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [props.section, showTabs]);
  useEffect(() => {
    if (seenRefreshedAtRef.current === props.refreshedAt) return;
    seenRefreshedAtRef.current = props.refreshedAt;
    setJustRefreshed(true);
    const timer = setTimeout(() => setJustRefreshed(false), 1500);
    return () => clearTimeout(timer);
  }, [props.refreshedAt]);
  useEffect(() => {
    if (!repoChrome) setLegendOpen(false);
  }, [repoChrome]);
  useEffect(() => {
    if (!props.runNow) setRunNowOpen(false);
  }, [props.runNow]);

  const sharedControls = repoChrome ? h("div", {
    className: "order-2 ml-auto flex shrink-0 items-center justify-end gap-x-2 sm:order-5 sm:ml-0 sm:gap-x-3",
    "data-testid": "factory-shared-controls",
  },
    refreshedLabel !== null
      ? h("button", {
          type: "button",
          className: `inline-flex h-8 min-h-8 min-w-[4.5rem] items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs ${justRefreshed ? "text-foreground" : "text-muted-foreground"} transition-colors hover:bg-state-hover hover:text-foreground sm:h-6 sm:min-h-6 sm:min-w-0 sm:w-auto`,
          onClick: props.onRefresh,
          title: "Refresh now",
          "aria-label": refreshedLabel,
        },
        h("span", { className: justRefreshed ? "inline-block" : "hidden sm:inline", "aria-live": "polite" }, justRefreshed ? "Updated" : refreshedLabel),
        h(RefreshIcon))
      : null,
    h("div", { className: "relative" },
      h("button", {
        type: "button",
        className: "inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-full border border-border text-xs text-muted-foreground transition-colors hover:text-foreground sm:h-6 sm:w-6 sm:min-h-6 sm:min-w-6",
        onClick: () => setLegendOpen((open) => !open),
        "aria-label": "Chip legend",
        "aria-expanded": legendOpen,
      }, "?"),
      legendOpen ? h(ChipLegend, { onClose: () => setLegendOpen(false) }) : null)) : null;
  const mobileOperations = repoChrome ? h("div", {
    className: "order-3 flex basis-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 sm:contents",
    "data-testid": "factory-operations-bar",
  },
    h("div", { className: "order-1 flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:contents", "data-testid": "factory-controls-row" },
      h("div", { className: "flex min-w-0 flex-wrap items-center gap-2 sm:contents" },
        h("span", { className: "sm:hidden" }, mobileDispatch),
        pauseControl,
        h("span", { className: "sm:hidden" }, runBadge),
        mobileBranch),
      h("div", { className: "ml-auto flex shrink-0 items-center sm:contents" }, runNowControl))) : null;

  return h("main", { className: "flex h-full min-h-0 flex-1 flex-col bg-background text-foreground" },
    h("header", { className: "shrink-0 border-b border-border bg-background" },
      h("div", { className: "flex flex-wrap items-center gap-1 px-3 py-2 sm:flex-row sm:flex-nowrap sm:gap-x-3 sm:gap-y-1 sm:px-4" },
        h("div", { className: "order-1 flex min-w-0 flex-1 items-center gap-x-3 sm:flex-none" },
          h("span", { className: "hidden shrink-0 text-sm font-semibold sm:inline" }, "Factory"),
          h(RepositorySwitcher, props)),
        h("div", { className: "order-2 hidden flex-1 sm:block" }),
        repoChrome
          ? h("div", {
              className: "order-3 hidden min-h-8 w-full min-w-0 items-center sm:flex sm:min-h-0 sm:w-auto",
              "data-testid": "factory-status-row",
            }, statusGroup)
          : null,
        sharedControls,
        mobileOperations),
      showTabs
        ? h("div", { className: "relative min-w-0 overflow-hidden" },
            h("nav", {
              ref: tabStripRef,
              className: "flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain whitespace-nowrap px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              role: "tablist",
              "aria-label": "Factory sections",
            },
            tabs.map((tab) => {
              const active = props.section === tab.section;
              const badge = tab.section === "work" ? props.badges.work
                : tab.section === "questions" ? props.badges.questions
                : 0;
              const mobileWidth = tabs.length === 4 ? "basis-1/4" : "basis-1/5";
              return h("button", {
                key: tab.section,
                type: "button",
                role: "tab",
                "aria-selected": active,
                className: `relative flex ${mobileWidth} min-w-[4.5rem] shrink-0 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-sm transition-colors sm:min-w-0 sm:basis-auto sm:flex-none sm:px-3 ${
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`,
                onClick: () => props.onNavigate(tab.section),
              },
                tab.label,
                badge > 0
                  ? h("span", { className: "rounded bg-[#fef3c7] px-1.5 text-xs font-medium text-[#854d0e]" }, String(badge))
                  : null,
                tab.section === "runs" && props.badges.runsActive
                  ? h(StatusDot, { tone: "primary", pulse: true })
                  : null);
            })),
            h("span", {
              className: "pointer-events-none absolute inset-y-0 right-0 flex w-7 items-center justify-end bg-gradient-to-l from-background via-background/90 to-transparent pr-1 text-xs text-muted-foreground sm:hidden",
              "aria-hidden": true,
            }, "›"))
        : null),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto", "data-testid": "factory-scroll" },
      props.connectionState !== "connected"
        ? h("div", { className: "border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning" },
            props.connectionState === "reconnecting"
              ? "Connection lost. Durable state will reload when it reconnects."
              : "Disconnected. The plugin host is unreachable.")
        : null,
      props.malformedSignal
        ? h("div", { className: "border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning" },
            "A previous read returned malformed data. Showing the last good snapshot.")
        : null,
      h("div", { className: "mx-auto max-w-5xl px-4 py-4" }, props.children)),
    repoChrome && props.runNow
      ? h(ConfirmDialog, {
          open: runNowOpen,
          title: props.runNow.confirmTitle,
          body: providerModelPickerBound && runNowSelection !== null
            ? h("div", { className: "space-y-3" },
                props.runNow.confirmBody,
                h("div", {
                  role: "radiogroup",
                  "aria-label": "Provider selection",
                  className: "space-y-1.5",
                },
                  h("label", { className: "flex items-center gap-2 text-xs text-foreground" },
                    h("input", {
                      type: "radio",
                      name: "factory-run-now-provider",
                      checked: !runNowCustom,
                      disabled: props.actionPending,
                      onChange: () => setRunNowCustom(false),
                    }),
                    "Automatic"),
                  h("label", { className: "flex items-center gap-2 text-xs text-foreground" },
                    h("input", {
                      type: "radio",
                      name: "factory-run-now-provider",
                      checked: runNowCustom,
                      disabled: props.actionPending,
                      onChange: () => setRunNowCustom(true),
                    }),
                    "Choose provider and model")),
                runNowCustom && ProviderModelPicker !== undefined
                  ? h(ProviderModelPicker, {
                      value: runNowSelection,
                      onChange: (next: PickerValue) => setRunNowSelection(next),
                      routing: props.runNow.pickerRouting,
                      disabled: props.actionPending,
                    })
                  : props.runNow.automaticHint != null
                    ? h("p", { className: "text-xs" }, props.runNow.automaticHint)
                    : null)
            : props.runNow.confirmBody,
          confirmLabel: "Run now",
          busy: props.actionPending,
          onConfirm: () => {
            setRunNowOpen(false);
            props.runNow?.onConfirm(runNowCustom ? runNowSelection : null);
          },
          onCancel: () => setRunNowOpen(false),
        })
      : null);
}
