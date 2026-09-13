import { createElement, Fragment, useEffect, useState, type ReactNode } from "react";
import type {
  DispatchStatus,
  OperationalRunSummary,
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

const h = createElement;

export type { FactorySection };

const SECTION_TABS: Array<{ section: FactorySection; label: string }> = [
  { section: "overview", label: "Overview" },
  { section: "work", label: "Work" },
  { section: "questions", label: "Questions" },
  { section: "runs", label: "Runs" },
  { section: "settings", label: "Settings" },
];

export interface ShellRunNow {
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly confirmTitle: string;
  readonly confirmBody: ReactNode;
  readonly onConfirm: () => void;
}

export interface FactoryShellProps {
  readonly section: FactorySection;
  readonly onNavigate: (section: FactorySection) => void;
  readonly repositories: readonly RepositorySelection[];
  readonly selectedRepositoryKey: RepositoryKey | null;
  /** True while the repositories landing is the rendered content: the "All" control owns the active state. */
  readonly repositoriesActive: boolean;
  readonly repositorySelectionLoading: boolean;
  readonly onSelectRepository: (repositoryKey: RepositoryKey) => void;
  readonly onShowRepositories: () => void;
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
  "repositories" | "selectedRepositoryKey" | "repositoriesActive" | "repositorySelectionLoading" | "onSelectRepository" | "onShowRepositories" | "onAddRepository"
>) {
  const { repositories, selectedRepositoryKey, repositoriesActive, repositorySelectionLoading, onSelectRepository, onShowRepositories, onAddRepository } = props;
  const selectVariant = (wrapperClass: string) => h("div", {
    className: `flex min-w-0 items-center gap-1 transition-opacity ${wrapperClass} ${repositorySelectionLoading ? "opacity-60" : ""}`,
    "aria-busy": repositorySelectionLoading,
  },
    h(ActionButton, { label: "All", variant: repositoriesActive ? "secondary" : "ghost", size: "xs", onClick: onShowRepositories }),
    h("select", {
      "aria-label": "Configured repository",
      className: "max-w-[8rem] rounded-md border border-border bg-background px-2 py-1 text-sm sm:max-w-none",
      value: selectedRepositoryKey ?? "",
      onChange: (event: { target: { value: string } }) => {
        if (event.target.value) onSelectRepository(event.target.value);
      },
    },
      repositories.map((repo) =>
        h("option", { key: repo.configuration.repositoryKey, value: repo.configuration.repositoryKey },
          repo.configuration.repositoryKey))),
    h(ActionButton, { label: "+", variant: "ghost", size: "xs", onClick: onAddRepository, title: "Add repository" }));
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
        "aria-pressed": repositoriesActive,
        className: `rounded-md px-2 py-1 text-xs font-medium transition-colors ${
          repositoriesActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
        }`,
        onClick: onShowRepositories,
        title: "All repositories",
      }, "All"),
      repositories.map((repo) => {
        const key = repo.configuration.repositoryKey;
        const active = !repositoriesActive && key === selectedRepositoryKey;
        return h("button", {
          key,
          type: "button",
          "aria-pressed": active,
          className: `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`,
          title: repo.dispatchPaused ? `${key} (dispatch paused)` : key,
          onClick: () => onSelectRepository(key),
        },
          repo.dispatchPaused ? h(StatusDot, { tone: "warning" }) : null,
          key);
      }),
      h("button", {
        type: "button",
        className: "rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
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
  return h("div", {
    className: "absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-card p-3 shadow-lg",
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
        h("span", { className: "text-foreground" }, row.meaning)))));
}

export function FactoryShell(props: FactoryShellProps) {
  const now = useNow(15000);
  const [legendOpen, setLegendOpen] = useState(false);
  const [runNowOpen, setRunNowOpen] = useState(false);
  const chip = dispatchChip(props.dispatch);
  const run = props.activeRun;
  const runElapsed = run?.startedAt ? formatDuration(run.startedAt, null, now) : null;
  // The repositories landing is not scoped to one repository, so none of the
  // per-repo chrome (branch chip, dispatch state, run controls, section tabs)
  // may render above it.
  const repoChrome = !props.repositoriesActive;
  const refreshedLabel = props.refreshedAt !== null
    ? `refreshed ${timeAgo(new Date(props.refreshedAt).toISOString(), now) ?? "just now"}`
    : null;
  const branchChip = repoChrome && (props.branch || props.commit)
    ? h("span", { className: "inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" },
        props.branch ?? "",
        props.commit ? h(CopyText, { value: props.commit, label: `@${shortSha(props.commit)}`, mono: true }) : null)
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
  // Below sm the status line wraps under the first row and the controls claim
  // its spot; at sm and up DOM order is restored so the row renders as before.
  const statusGroup = branchChip || dispatchBadge || runBadge
    ? h("div", { className: "order-1 flex basis-full items-center gap-x-3 text-muted-foreground sm:order-none sm:basis-auto" },
        branchChip, dispatchBadge, runBadge)
    : null;

  return h("main", { className: "flex h-full min-h-0 flex-1 flex-col bg-background text-foreground" },
    h("header", { className: "shrink-0 border-b border-border bg-background" },
      h("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2" },
        h("div", { className: "flex min-w-0 items-center gap-x-3" },
          h("span", { className: "shrink-0 text-sm font-semibold" }, "Factory"),
          h(RepositorySwitcher, props)),
        h("div", { className: "hidden flex-1 sm:block" }),
        statusGroup,
        h("div", { className: "ml-auto flex items-center gap-x-2 sm:ml-0 sm:gap-x-3" },
          repoChrome && props.dispatch
            ? h(ActionButton, {
                label: props.dispatch.mode === "enabled" ? "Pause" : "Resume",
                variant: "secondary",
                size: "xs",
                title: "Stops new runs. Running runs continue.",
                onClick: props.dispatch.mode === "enabled" ? props.onPause : props.onResume,
                disabled: props.actionPending,
              })
            : null,
          repoChrome && props.runNow
            ? h(ActionButton, {
                label: "Run now",
                variant: "primary",
                size: "xs",
                title: props.runNow.disabled ? props.runNow.reason ?? "Unavailable" : "Start a run immediately",
                disabled: props.runNow.disabled || props.actionPending,
                onClick: () => setRunNowOpen(true),
              })
            : null,
          refreshedLabel !== null
            ? h("button", {
                type: "button",
                className: "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
                onClick: props.onRefresh,
                title: "Refresh now",
                "aria-label": refreshedLabel,
              },
              h("span", { className: "hidden sm:inline" }, refreshedLabel),
              h(RefreshIcon))
            : null,
          h("div", { className: "relative" },
            h("button", {
              type: "button",
              className: "inline-flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs text-muted-foreground transition-colors hover:text-foreground",
              onClick: () => setLegendOpen((open) => !open),
              "aria-label": "Chip legend",
              "aria-expanded": legendOpen,
            }, "?"),
            legendOpen ? h(ChipLegend, { onClose: () => setLegendOpen(false) }) : null))),
      repoChrome
        ? h("nav", { className: "flex items-center gap-1 overflow-x-auto whitespace-nowrap px-3", role: "tablist", "aria-label": "Factory sections" },
        SECTION_TABS.map((tab) => {
          const active = props.section === tab.section;
          const badge = tab.section === "work" ? props.badges.work
            : tab.section === "questions" ? props.badges.questions
            : 0;
          return h("button", {
            key: tab.section,
            type: "button",
            role: "tab",
            "aria-selected": active,
            className: `relative flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`,
            onClick: () => props.onNavigate(tab.section),
          },
            tab.label,
            badge > 0
              ? h("span", { className: "rounded bg-warning/15 px-1.5 text-xs font-medium text-warning" }, String(badge))
              : null,
            tab.section === "runs" && props.badges.runsActive
              ? h(StatusDot, { tone: "primary", pulse: true })
              : null);
        })) : null),
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
          body: props.runNow.confirmBody,
          confirmLabel: "Run now",
          busy: props.actionPending,
          onConfirm: () => {
            setRunNowOpen(false);
            props.runNow?.onConfirm();
          },
          onCancel: () => setRunNowOpen(false),
        })
      : null);
}
