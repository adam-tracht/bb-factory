import { createElement, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import {
  ActionFeedbackNotice,
  PendingInteractionControls,
  QueueApprovalControl,
  QuestionAnswerControl,
  RunActionControls,
  type ActionFeedback,
} from "./action-entry.js";
import type {
  DispatchStatus,
  FactorySettings,
  HealthProjection,
  HostPreflight,
  OperationalRunDetail,
  OperationalRunSummary,
  PendingInteraction,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  ProviderStatus,
  QueueEntry,
  Question,
  RepositoryConfiguration,
  RepositorySelectionProjection,
  SettingsProjection,
} from "../contracts.js";

const h = createElement;

export type FactorySection = "overview" | "queue" | "questions" | "runs" | "settings";

export type FactoryRoute =
  | { section: FactorySection; runId: string | null }
  | { section: "not-found"; raw: string };

export function parseFactoryRoute(subPath: string): FactoryRoute {
  const raw = subPath.trim().replace(/^\/+|\/+$/g, "");
  const segments = raw
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const section = segments[0] ?? "overview";

  if (section === "overview") return { section, runId: null };
  if (section === "queue" || section === "questions" || section === "settings") {
    return { section, runId: null };
  }
  if (section === "runs") return { section, runId: segments[1] ?? null };
  return { section: "not-found", raw };
}

export function sectionPath(section: FactorySection): string {
  return section === "overview" ? "" : section;
}

export function formatEligibilityReason(reason: QueueEntry["eligibilityReasons"][number]): string {
  switch (reason) {
    case "not-ready":
      return "The queue item is not marked ready.";
    case "unmet-dependency":
      return "A required dependency is not complete.";
    case "blocking-question":
      return "A blocking question is still open.";
    case "missing-authorization":
      return "No explicit queue approval was recorded.";
    case "high-risk-approval-missing":
      return "This high-risk item is missing its required approval.";
    case "repository-policy":
      return "The repository protocol currently blocks this item.";
  }
}

export function queueStatusLabel(status: QueueEntry["status"]): string {
  switch (status.kind) {
    case "ready":
      return "Ready";
    case "in-progress":
      return `In progress: ${status.detail}`;
    case "done":
      return status.detail ? `Done: ${status.detail}` : "Done";
    case "blocked-by":
      return status.detail ? `Blocked: ${status.detail}` : `Blocked by ${status.questionId}`;
  }
}

export function runStatusLabel(status: OperationalRunSummary["status"]): string {
  switch (status) {
    case "failed-safe":
      return "Failed safe";
    case "cancel-requested":
      return "Cancellation requested";
    case "reconciliation-required":
      return "Reconciliation required";
    case "no-op":
      return "No-op";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function statusTone(status: string): "success" | "warning" | "danger" | "neutral" | "primary" {
  if (["success", "completed", "done", "available", "online", "eligible"].includes(status)) return "success";
  if (["warning", "blocked", "limited", "paused", "pending", "connecting", "reconnecting"].includes(status)) return "warning";
  if (["danger", "failed-safe", "reconciliation-required", "unavailable", "offline", "error"].includes(status)) return "danger";
  if (["primary", "started", "in-progress", "enabled"].includes(status)) return "primary";
  return "neutral";
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export const buttonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const quietButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const cardClass = "rounded-lg border border-border bg-card p-4";
const labelClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export type FileLinkTarget =
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "host"; hostId: string; path: string };

export interface FileLinkProps {
  target: FileLinkTarget;
  className?: string;
  children?: ReactNode;
}

export type FileLinkRenderer = ComponentType<FileLinkProps>;

function normalizeRepositoryRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

export function repositoryFileTarget(repository: RepositoryConfiguration, relativePath: string): FileLinkTarget | null {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  if (!normalized) return null;
  const separator = repository.checkoutPath.includes("\\") ? "\\" : "/";
  const checkoutPath = repository.checkoutPath.replace(/[\\/]+$/u, "");
  return {
    kind: "host",
    hostId: repository.connectedHostId,
    path: `${checkoutPath}${separator}${normalized.replaceAll("/", separator)}`,
  };
}

export function runFileTarget(run: OperationalRunSummary, repository: RepositoryConfiguration, relativePath: string): FileLinkTarget | null {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  if (!normalized) return null;
  return run.environmentId
    ? { kind: "workspace", environmentId: run.environmentId, path: normalized }
    : repositoryFileTarget(repository, normalized);
}

function FilePath({ path, target, fileLink: Renderer }: { path: string; target: FileLinkTarget | null; fileLink?: FileLinkRenderer }) {
  return target && Renderer
    ? h(Renderer, { target, className: "font-mono text-xs text-primary underline-offset-2 hover:underline" }, path)
    : h("span", { className: "font-mono text-xs" }, path);
}

type BadgeProps = { label: string; tone?: ReturnType<typeof statusTone> };

export function Badge({ label, tone = "neutral" }: BadgeProps) {
  const toneClass = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
    primary: "bg-primary/10 text-primary",
    neutral: "bg-muted text-muted-foreground",
  }[tone];
  return h("span", { className: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}` }, label);
}

export function ErrorNotice({ message, title = "Factory data is unavailable", onRetry }: { message: string; title?: string; onRetry?: () => void }) {
  return h(
    "div",
    { className: "rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive", role: "alert" },
    h("p", { className: "font-medium" }, title),
    h("p", { className: "mt-1 leading-5" }, message),
    onRetry
      ? h("button", { type: "button", className: `${buttonClass} mt-3 border-destructive/40 text-destructive`, onClick: onRetry }, "Retry")
      : null,
  );
}

export function LoadingNotice({ label = "Loading factory data" }: { label?: string }) {
  return h(
    "div",
    { className: "space-y-3 rounded-lg border border-border bg-card p-4", role: "status", "aria-live": "polite" },
    h("p", { className: "text-sm text-muted-foreground" }, label),
    h("div", { className: "h-2 w-2/3 animate-pulse rounded bg-muted" }),
    h("div", { className: "h-2 w-1/2 animate-pulse rounded bg-muted" }),
  );
}

export function EmptyNotice({ title, detail }: { title: string; detail: string }) {
  return h(
    "div",
    { className: "rounded-lg border border-dashed border-border bg-surface-recessed/30 px-4 py-7" },
    h("p", { className: "text-sm font-medium text-foreground" }, title),
    h("p", { className: "mt-1 max-w-xl text-sm leading-6 text-muted-foreground" }, detail),
  );
}

export function ConnectionBanner({ state, malformedSignal }: { state: "connected" | "connecting" | "reconnecting"; malformedSignal: boolean }) {
  if (state === "connected" && !malformedSignal) return null;
  const label = state === "connected" ? "Live update was malformed. Durable state was reloaded." : `BB connection is ${state}. Durable state will reload when it reconnects.`;
  return h(
    "div",
    { className: "mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning", role: "status" },
    label,
  );
}

export interface FactoryShellProps {
  activeSection: FactorySection;
  connectionState: "connected" | "connecting" | "reconnecting";
  malformedSignal: boolean;
  onNavigate: (section: FactorySection) => void;
  repositoryProjection?: RepositorySelectionProjection | null;
  repositorySelectionKey?: string | null;
  repositorySelectionLoading?: boolean;
  onRepositorySelect?: (repositoryKey: string) => void;
  children: ReactNode;
}

export interface RepositorySwitcherProps {
  projection: RepositorySelectionProjection;
  selectedRepositoryKey?: string | null;
  loading?: boolean;
  onSelect: (repositoryKey: string) => void;
}

export function RepositorySwitcher({ projection, selectedRepositoryKey, loading = false, onSelect }: RepositorySwitcherProps) {
  if (projection.repositories.length < 2) return null;
  const value = selectedRepositoryKey ?? projection.selectedRepositoryKey ?? "";
  return h(
    "section",
    { className: "mb-4 rounded-lg border border-border bg-card p-4", "aria-labelledby": "factory-repository-switcher-heading" },
    h("div", { className: "flex flex-wrap items-center justify-between gap-3" },
      h("div", null,
        h("p", { className: labelClass }, "Repository context"),
        h("h2", { id: "factory-repository-switcher-heading", className: "mt-1 text-sm font-semibold" }, "Active repository"),
        h("p", { className: "mt-1 text-sm text-muted-foreground" }, "Switches the read-only Factory context locally; host settings are unchanged."),
      ),
      h("label", { className: "flex min-w-56 flex-col gap-1 text-sm font-medium" },
        h("span", { className: labelClass }, "Configured repository"),
        h("select", {
          value,
          disabled: loading,
          className: "rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "aria-label": "Configured repository",
          onChange: (event: ChangeEvent<HTMLSelectElement>) => onSelect(event.currentTarget.value),
        }, projection.repositories.map((repository) => h("option", { key: repository.configuration.repositoryKey, value: repository.configuration.repositoryKey }, repository.configuration.repositoryKey))),
      ),
    ),
  );
}

export function FactoryShell({ activeSection, connectionState, malformedSignal, onNavigate, repositoryProjection, repositorySelectionKey, repositorySelectionLoading = false, onRepositorySelect, children }: FactoryShellProps) {
  const navItems: Array<{ section: FactorySection; label: string; detail: string }> = [
    { section: "overview", label: "Overview", detail: "Health and current state" },
    { section: "queue", label: "Queue", detail: "Repository-backed work" },
    { section: "questions", label: "Questions", detail: "Open decisions and BB prompts" },
    { section: "runs", label: "Runs", detail: "Execution history" },
    { section: "settings", label: "Settings", detail: "Validation and dispatch status" },
  ];
  return h(
    "main",
    { className: "min-h-full bg-background text-foreground", "aria-labelledby": "factory-title" },
    h(
      "div",
      { className: "mx-auto w-full max-w-6xl px-4 py-5 md:px-6" },
      h(
        "header",
        { className: "mb-5 flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between" },
        h(
          "div",
          null,
          h("p", { className: labelClass }, "Native BB control surface"),
          h("h1", { id: "factory-title", className: "mt-1 text-2xl font-semibold tracking-tight" }, "Factory"),
          h("p", { className: "mt-1 max-w-2xl text-sm leading-6 text-muted-foreground" }, "Read-only visibility into repository protocol state, foreman health, and BB execution records."),
        ),
        h(
          "nav",
          { className: "flex flex-wrap gap-1", "aria-label": "Factory sections" },
          navItems.map((item) =>
            h(
              "button",
              {
                key: item.section,
                type: "button",
                className: `${activeSection === item.section ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"} rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`,
                "aria-current": activeSection === item.section ? "page" : undefined,
                "aria-label": `${item.label}: ${item.detail}`,
                onClick: () => onNavigate(item.section),
              },
              item.label,
            ),
          ),
        ),
      ),
      h(ConnectionBanner, { state: connectionState, malformedSignal }),
      repositoryProjection && onRepositorySelect ? h(RepositorySwitcher, { projection: repositoryProjection, selectedRepositoryKey: repositorySelectionKey, loading: repositorySelectionLoading, onSelect: onRepositorySelect }) : null,
      children,
    ),
  );
}

function ResourceNotice({ loaded, label, error, onRetry }: { loaded: boolean; label: string; error?: string | null; onRetry: () => void }) {
  if (loaded) return null;
  if (error) return h(ErrorNotice, { message: `${label}: ${error}`, onRetry });
  return h("div", { className: "space-y-2" }, h(LoadingNotice, { label: `Loading ${label}` }), h("button", { type: "button", className: quietButtonClass, onClick: onRetry }, "Retry"));
}

function HealthCard({ health, error, onRetry }: { health: HealthProjection | null; error?: string | null; onRetry: () => void }) {
  if (!health) return h(ResourceNotice, { loaded: false, label: "Live health", error, onRetry });
  const host = health.host;
  return h(
    "section",
    { className: cardClass, "aria-labelledby": "factory-health-heading" },
    h("div", { className: "flex items-start justify-between gap-3" }, h("h2", { id: "factory-health-heading", className: "text-sm font-semibold" }, "Repository health"), h(Badge, { label: host.ok ? "Healthy" : "Needs attention", tone: statusTone(host.ok ? "success" : "error") })),
    h("dl", { className: "mt-4 grid gap-3 sm:grid-cols-2" },
      h("div", null, h("dt", { className: labelClass }, "Host"), h("dd", { className: "mt-1 text-sm" }, host.hostId)),
      h("div", null, h("dt", { className: labelClass }, "Checkout"), h("dd", { className: "mt-1 text-sm" }, host.checkoutExists ? "Present" : "Missing")),
      h("div", null, h("dt", { className: labelClass }, "Branch"), h("dd", { className: "mt-1 font-mono text-sm" }, host.branch ?? "Unknown")),
      h("div", null, h("dt", { className: labelClass }, "Host status"), h("dd", { className: "mt-1 text-sm" }, h(Badge, { label: host.status, tone: statusTone(host.status) }))),
    ),
    host.reasons.length > 0 ? h("ul", { className: "mt-4 space-y-1 text-sm text-warning" }, host.reasons.map((reason) => h("li", { key: reason }, `• ${reason}`))) : null,
    h("div", { className: "mt-4 border-t border-border pt-3" }, h("p", { className: labelClass }, "Providers"), h("div", { className: "mt-2 space-y-2" }, health.providers.length > 0 ? health.providers.map((provider) => h(ProviderRow, { key: provider.providerId, provider })) : h("p", { className: "text-sm text-muted-foreground" }, "No provider status reported."))),
  );
}

function ProviderRow({ provider }: { provider: ProviderStatus }) {
  return h("div", { className: "flex flex-wrap items-center justify-between gap-2 text-sm" }, h("span", { className: "font-medium" }, provider.providerId), h("span", { className: "text-muted-foreground" }, `${provider.model} · ${provider.reasoningLevel}`), h(Badge, { label: provider.availability, tone: statusTone(provider.availability) }));
}

function HostPrerequisites({ host }: { host: HostPreflight }) {
  const tools = Object.entries(host.requiredTools);
  return h(
    "section",
    { className: cardClass, "aria-labelledby": "factory-prerequisites-heading" },
    h("h2", { id: "factory-prerequisites-heading", className: "text-sm font-semibold" }, "Host prerequisites"),
    h("div", { className: "mt-4 space-y-2" },
      h(Prerequisite, { label: "Checkout exists", ok: host.checkoutExists }),
      h(Prerequisite, { label: "Browser available", ok: host.browserAvailable, unknownLabel: "Not required or not reported" }),
      h(Prerequisite, { label: "dbt Studio available", ok: host.dbtStudioAvailable, unknownLabel: "Not required or not reported" }),
      ...tools.map(([tool, ok]) => h(Prerequisite, { key: tool, label: tool, ok })),
    ),
  );
}

function Prerequisite({ label, ok, unknownLabel = "Missing" }: { label: string; ok: boolean | null; unknownLabel?: string }) {
  const text = ok === null ? unknownLabel : ok ? "Ready" : "Missing";
  return h("div", { className: "flex items-center justify-between gap-3 text-sm" }, h("span", null, label), h(Badge, { label: text, tone: statusTone(ok === null ? "neutral" : ok ? "success" : "error") }));
}

function DispatchWindowCard({ settings, dispatch }: { settings: FactorySettings; dispatch: DispatchStatus }) {
  return h(
    "section",
    { className: cardClass, "aria-labelledby": "factory-window-heading" },
    h("div", { className: "flex items-start justify-between gap-3" }, h("h2", { id: "factory-window-heading", className: "text-sm font-semibold" }, "Spacing and night window"), h(Badge, { label: dispatch.mode, tone: statusTone(dispatch.mode) })),
    h("dl", { className: "mt-4 space-y-3 text-sm" },
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Schedule"), h("dd", { className: "text-right" }, settings.scheduleCron ?? "Not configured")),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Time zone"), h("dd", { className: "text-right" }, settings.timeZone)),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Window ends"), h("dd", { className: "text-right" }, `${settings.nightWindowEndHour}:00 server-local`)),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Minimum gap"), h("dd", { className: "text-right" }, formatDuration(settings.minimumStartGapSeconds))),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Accepting new runs"), h("dd", { className: "text-right" }, dispatch.acceptingNewRuns ? "Yes" : "No")),
    ),
    dispatch.reason ? h("p", { className: "mt-4 text-sm leading-5 text-warning" }, dispatch.reason) : null,
  );
}

function CurrentForemanCard({ snapshot, fileLink }: { snapshot: ProtocolSnapshot; fileLink?: FileLinkRenderer }) {
  const current = snapshot.currentRun;
  return h(
    "section",
    { className: cardClass, "aria-labelledby": "factory-current-heading" },
    h("div", { className: "flex items-start justify-between gap-3" }, h("h2", { id: "factory-current-heading", className: "text-sm font-semibold" }, "Current foreman"), h(Badge, { label: current.state, tone: statusTone(current.state) })),
    h("dl", { className: "mt-4 space-y-3 text-sm" },
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Last run"), h("dd", { className: "text-right" }, formatTimestamp(current.lastRunAt))),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Current report"), h("dd", { className: "text-right" }, h(FilePath, { path: current.currentPath, target: repositoryFileTarget(snapshot.repository, current.currentPath), fileLink }))),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Latest immutable run"), h("dd", { className: "text-right" }, current.latestRunPath ? h(FilePath, { path: current.latestRunPath, target: repositoryFileTarget(snapshot.repository, current.latestRunPath), fileLink }) : "Not recorded")),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Foreman protocol"), h("dd", { className: "text-right" }, h(FilePath, { path: snapshot.foremanTemplate.relativePath, target: repositoryFileTarget(snapshot.repository, snapshot.foremanTemplate.relativePath), fileLink }))),
      h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Foreman digest"), h("dd", { className: "break-all font-mono text-right text-xs" }, snapshot.foremanTemplate.contentSha256)),
    ),
  );
}

export interface OverviewViewProps {
  snapshot: ProtocolSnapshot;
  settings: SettingsProjection | null;
  settingsError?: string | null;
  health: HealthProjection | null;
  healthError?: string | null;
  dashboardLink?: ReactNode;
  fileLink?: FileLinkRenderer;
  onRetry: () => void;
  dispatchActions?: ReactNode;
  feedback?: ActionFeedback | null;
}

export function OverviewView({ snapshot, settings, settingsError, health, healthError, dashboardLink, fileLink, onRetry, dispatchActions, feedback }: OverviewViewProps) {
  const repository = snapshot.repository;
  const dashboard = snapshot.dashboard;
  const dashboardTarget = repositoryFileTarget(repository, dashboard.canonicalPath);
  const resolvedDashboardLink = dashboardLink ?? (fileLink && dashboardTarget ? h(fileLink, { target: dashboardTarget, className: `${buttonClass} shrink-0` }, `Open ${dashboard.canonicalPath}`) : null);
  return h(
    "div",
    { className: "space-y-4" },
    h("section", { className: "rounded-lg border border-border bg-card p-4" }, h("p", { className: labelClass }, "Repository"), h("h2", { className: "mt-1 text-xl font-semibold" }, repository.repositoryKey), h("p", { className: "mt-1 break-all font-mono text-xs text-muted-foreground" }, repository.repositoryRoot), h("div", { className: "mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" }, h(Badge, { label: `branch ${repository.factoryBranch}`, tone: "primary" }), h(Badge, { label: `compare ${repository.mainRef}`, tone: "neutral" }), h(Badge, { label: `revision ${snapshot.revision.gitCommit ?? "uncommitted"}`, tone: "neutral" }))),
    feedback ? h(ActionFeedbackNotice, { feedback }) : null,
    h("div", { className: "grid gap-4 lg:grid-cols-2" }, h(CurrentForemanCard, { snapshot, fileLink }), settings ? h("div", null, h(DispatchWindowCard, { settings: settings.settings, dispatch: settings.dispatch }), dispatchActions ?? null) : h(ResourceNotice, { loaded: false, label: "Spacing and window status", error: settingsError, onRetry })),
    h("div", { className: "grid gap-4 lg:grid-cols-2" }, h(HealthCard, { health, error: healthError, onRetry }), health ? h(HostPrerequisites, { host: health.host }) : h(ResourceNotice, { loaded: false, label: "Host prerequisites", error: healthError, onRetry })),
    h(
      "section",
      { className: cardClass, "aria-labelledby": "factory-dashboard-heading" },
      h("div", { className: "flex flex-wrap items-start justify-between gap-3" }, h("div", null, h("h2", { id: "factory-dashboard-heading", className: "text-sm font-semibold" }, "Canonical dashboard"), h("p", { className: "mt-1 text-sm text-muted-foreground" }, `${dashboard.factoryAhead} commit${dashboard.factoryAhead === 1 ? "" : "s"} ahead of ${dashboard.mainRef}; ${dashboard.mainBehind} behind.`)), resolvedDashboardLink),
      h("div", { className: "mt-4 flex flex-wrap items-center gap-2" }, h(Badge, { label: dashboard.safeFastForward ? "Fast-forward report: safe" : "Fast-forward report: review required", tone: dashboard.safeFastForward ? "success" : "warning" }), h("span", { className: "text-xs text-muted-foreground" }, "Phase 1 does not perform integration.")),
      dashboard.taskCommits.length > 0 ? h("ul", { className: "mt-4 space-y-2 border-t border-border pt-3" }, dashboard.taskCommits.map((commit) => h("li", { key: commit.sha, className: "flex gap-3 text-sm" }, h("code", { className: "shrink-0 text-xs text-muted-foreground" }, commit.sha), h("span", null, commit.subject)))) : h("p", { className: "mt-4 border-t border-border pt-3 text-sm text-muted-foreground" }, "No unmerged task commits are recorded."),
    ),
  );
}

function queueBadge(entry: QueueEntry): { label: string; tone: ReturnType<typeof statusTone> } {
  switch (entry.status.kind) {
    case "done":
      return { label: queueStatusLabel(entry.status), tone: "success" };
    case "in-progress":
      return { label: queueStatusLabel(entry.status), tone: "primary" };
    case "blocked-by":
      return { label: queueStatusLabel(entry.status), tone: "warning" };
    case "ready":
      if (entry.eligibilityReasons.includes("not-ready")) return { label: "Not ready", tone: "warning" };
      return entry.eligible ? { label: "Eligible", tone: "success" } : { label: "Blocked", tone: "warning" };
  }
}

function QueueEntryCard({ entry, repository, fileLink, onApprove, actionPending }: { entry: QueueEntry; repository: RepositoryConfiguration; fileLink?: FileLinkRenderer; onApprove?: (queueItemId: string, approvedText: string) => void; actionPending?: boolean }) {
  const reasons = entry.eligibilityReasons.length > 0 ? entry.eligibilityReasons.map(formatEligibilityReason) : entry.eligible ? ["All recorded eligibility checks pass."] : ["Eligibility was not reported by the protocol adapter."];
  const badge = queueBadge(entry);
  return h(
    "article",
    { className: cardClass },
    h("div", { className: "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" }, h("div", null, h("h2", { className: "text-base font-semibold" }, entry.title), h("p", { className: "mt-1 font-mono text-xs text-muted-foreground" }, entry.id)), h("div", { className: "flex flex-wrap gap-2" }, h(Badge, { label: badge.label, tone: badge.tone }))),
    h("div", { className: "mt-4 grid gap-4 md:grid-cols-2" },
      h("div", null, h("p", { className: labelClass }, "Why this item is eligible or blocked"), h("ul", { className: "mt-2 space-y-1 text-sm leading-5" }, reasons.map((reason) => h("li", { key: reason, className: entry.eligible ? "text-success" : "text-warning" }, `• ${reason}`)))),
      h("div", null, h("p", { className: labelClass }, "Protocol details"), h("dl", { className: "mt-2 space-y-1 text-sm" }, h("div", { className: "flex gap-2" }, h("dt", { className: "text-muted-foreground" }, "Risk"), h("dd", null, entry.risk)), h("div", { className: "flex gap-2" }, h("dt", { className: "text-muted-foreground" }, "Priority"), h("dd", null, String(entry.priority))), h("div", { className: "flex gap-2" }, h("dt", { className: "text-muted-foreground" }, "Plan"), h("dd", { className: "break-all" }, h(FilePath, { path: entry.planPath, target: repositoryFileTarget(repository, entry.planPath), fileLink }))), h("div", { className: "flex gap-2" }, h("dt", { className: "text-muted-foreground" }, "Approval"), h("dd", { className: "space-y-1" }, entry.approved.kind === "explicit" ? [h(Badge, { key: "approved", label: "Explicit approval", tone: "success" }), h("p", { key: "approval-source", className: "text-xs text-muted-foreground" }, `Source: ${entry.approved.source}`), h("p", { key: "approval-text", className: "whitespace-pre-wrap text-sm" }, `Text: ${entry.approved.text}`)] : [h(Badge, { key: "not-approved", label: "No approval", tone: "warning" }), h("p", { key: "approval-source", className: "text-xs text-muted-foreground" }, `Source: ${entry.approved.source}`)])))),
    ),
    entry.dependsOn.length > 0 ? h("p", { className: "mt-4 text-sm text-muted-foreground" }, h("span", { className: "font-medium text-foreground" }, "Depends on: "), entry.dependsOn.join(", ")) : null,
    entry.blockingQuestionIds.length > 0 ? h("p", { className: "mt-2 text-sm text-warning" }, h("span", { className: "font-medium" }, "Blocking questions: "), entry.blockingQuestionIds.join(", ")) : null,
    entry.notes ? h("p", { className: "mt-4 border-t border-border pt-3 text-sm leading-6 text-muted-foreground" }, entry.notes) : null,
    onApprove ? h(QueueApprovalControl, { entry, feedback: actionPending ? pendingActionFeedback : null, onApprove }) : null,
  );
}

const pendingActionFeedback: ActionFeedback = { pending: true, message: null, error: null };

export interface QueueViewProps {
  snapshot: ProtocolSnapshot;
  fileLink?: FileLinkRenderer;
  onApprove?: (queueItemId: string, approvedText: string) => void;
  pendingTarget?: string | null;
  feedback?: ActionFeedback | null;
}

export function QueueView({ snapshot, fileLink, onApprove, pendingTarget, feedback }: QueueViewProps) {
  const eligibleCount = snapshot.queue.filter((entry) => entry.eligible).length;
  return h(
    "div",
    { className: "space-y-4" },
    h("div", null, h("p", { className: labelClass }, "Repository-backed queue"), h("h2", { className: "mt-1 text-xl font-semibold" }, "Queue"), h("p", { className: "mt-1 text-sm text-muted-foreground" }, `${snapshot.queue.length} item${snapshot.queue.length === 1 ? "" : "s"}; ${eligibleCount} currently eligible. The repository remains the source of truth.`)),
    feedback ? h(ActionFeedbackNotice, { feedback }) : null,
    snapshot.queue.length > 0 ? h("div", { className: "space-y-3" }, snapshot.queue.map((entry) => h(QueueEntryCard, { key: entry.id, entry, repository: snapshot.repository, fileLink, onApprove, actionPending: pendingTarget !== null && pendingTarget !== undefined }))) : h(EmptyNotice, { title: "No queue entries", detail: "The selected repository has no parsed queue items." }),
  );
}

type MarkdownRenderer = ComponentType<{ content: string; className?: string }>;

function MarkdownBlock({ content, renderer: Renderer }: { content: string; renderer?: MarkdownRenderer }) {
  return Renderer ? h(Renderer, { content, className: "text-sm leading-6" }) : h("p", { className: "whitespace-pre-wrap text-sm leading-6" }, content);
}

function RepositoryQuestionCard({ question, snapshot, markdownRenderer, onAnswer, actionPending }: { question: Question; snapshot: ProtocolSnapshot; markdownRenderer?: MarkdownRenderer; onAnswer?: (questionId: string, answer: string) => void; actionPending?: boolean }) {
  const relatedQueueItems = snapshot.queue.filter((entry) => entry.blockingQuestionIds.includes(question.id));
  return h(
    "article",
    { className: cardClass },
    h("div", { className: "flex flex-wrap items-start justify-between gap-3" }, h("div", null, h("h2", { className: "text-base font-semibold" }, question.question), h("p", { className: "mt-1 font-mono text-xs text-muted-foreground" }, `${question.id} · ${question.date}`)), h(Badge, { label: question.classification, tone: question.classification === "blocking" ? "warning" : "neutral" })),
    h("div", { className: "mt-4 space-y-4" }, h("div", null, h("p", { className: labelClass }, "Context"), h("div", { className: "mt-1" }, h(MarkdownBlock, { content: question.context, renderer: markdownRenderer }))), question.assumed ? h("div", null, h("p", { className: labelClass }, "Current assumption"), h("p", { className: "mt-1 whitespace-pre-wrap text-sm leading-6" }, question.assumed)) : null, question.recommended ? h("div", null, h("p", { className: labelClass }, "Recommendation"), h("p", { className: "mt-1 whitespace-pre-wrap text-sm leading-6" }, question.recommended)) : null),
    h("div", { className: "mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3" }, h(Badge, { label: question.answer ? "Answered" : "Open", tone: question.answer ? "success" : "warning" }), relatedQueueItems.length > 0 ? h("span", { className: "text-xs text-muted-foreground" }, `Blocks ${relatedQueueItems.map((entry) => entry.id).join(", ")}`) : h("span", { className: "text-xs text-muted-foreground" }, "No queue item currently points to this question.")),
    question.answer ? h("div", { className: "mt-3 rounded-md bg-surface-recessed/40 p-3" }, h("p", { className: labelClass }, "Recorded answer"), h("div", { className: "mt-1" }, h(MarkdownBlock, { content: question.answer, renderer: markdownRenderer }))) : null,
    !question.answer && onAnswer ? h(QuestionAnswerControl, { questionId: question.id, feedback: actionPending ? pendingActionFeedback : null, onAnswer }) : null,
  );
}

function PendingInteractionCard({ interaction, onOpenThread, onResolve, actionPending }: { interaction: PendingInteraction; onOpenThread: (threadId: string) => void; onResolve?: InteractionResolveHandler; actionPending?: boolean }) {
  return h(
    "article",
    { className: "rounded-lg border border-warning/30 bg-warning/5 p-4" },
    h("div", { className: "flex flex-wrap items-start justify-between gap-3" }, h("div", null, h("h3", { className: "text-sm font-semibold" }, interaction.title), h("p", { className: "mt-1 font-mono text-xs text-muted-foreground" }, interaction.interactionId)), h(Badge, { label: "BB pending", tone: "warning" })),
    interaction.prompt ? h("div", { className: "mt-3" }, h(MarkdownBlock, { content: interaction.prompt })) : h("p", { className: "mt-3 text-sm text-muted-foreground" }, "BB did not provide a prompt."),
    h("div", { className: "mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground" }, h("span", null, `Created ${formatTimestamp(interaction.createdAt)}`), interaction.expiresAt ? h("span", null, `Expires ${formatTimestamp(interaction.expiresAt)}`) : null, h("button", { type: "button", className: quietButtonClass, onClick: () => onOpenThread(interaction.threadId) }, `Open thread ${interaction.threadId}`)),
    onResolve
      ? h(PendingInteractionControls, { interaction, feedback: actionPending ? pendingActionFeedback : null, onResolve })
      : h("p", { className: "mt-3 text-xs text-muted-foreground" }, "Read-only. Answering this interaction is not available here."),
  );
}

type InteractionResolveHandler = (interactionId: string, resolution: { kind: "approval"; decision: "allow_once" | "allow_for_session" | "deny" } | { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> }) => void;

export interface QuestionsViewProps {
  snapshot: ProtocolSnapshot;
  interactions: PendingInteractionsProjection | null;
  interactionsError?: string | null;
  markdownRenderer?: MarkdownRenderer;
  onOpenThread: (threadId: string) => void;
  onRetry: () => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  onResolveInteraction?: InteractionResolveHandler;
  pendingTarget?: string | null;
  feedback?: ActionFeedback | null;
}

export function QuestionsView({ snapshot, interactions, interactionsError, markdownRenderer, onOpenThread, onRetry, onAnswerQuestion, onResolveInteraction, pendingTarget, feedback }: QuestionsViewProps) {
  const pendingContent = interactions
    ? interactions.interactions.length > 0
      ? interactions.interactions.map((interaction) => h(PendingInteractionCard, { key: interaction.interactionId, interaction, onOpenThread, onResolve: onResolveInteraction, actionPending: pendingTarget !== null && pendingTarget !== undefined }))
      : h(EmptyNotice, { title: "No pending BB interactions", detail: "There are no approval or question prompts waiting in BB for this repository." })
    : interactionsError
      ? h(ErrorNotice, { message: `BB pending interactions: ${interactionsError}`, onRetry })
      : h(LoadingNotice, { label: "Loading BB pending interactions" });
  return h(
    "div",
    { className: "space-y-5" },
    h("div", null, h("p", { className: labelClass }, "Repository-backed decisions"), h("h2", { className: "mt-1 text-xl font-semibold" }, "Questions"), h("p", { className: "mt-1 text-sm text-muted-foreground" }, "Questions stay in the repository protocol. BB pending interactions can be resolved here with typed answers.")),
    feedback ? h(ActionFeedbackNotice, { feedback }) : null,
    h("section", { className: "space-y-3", "aria-labelledby": "repository-questions-heading" }, h("h3", { id: "repository-questions-heading", className: "text-sm font-semibold" }, "Repository questions"), snapshot.questions.length > 0 ? snapshot.questions.map((question) => h(RepositoryQuestionCard, { key: question.id, question, snapshot, markdownRenderer, onAnswer: onAnswerQuestion, actionPending: pendingTarget !== null && pendingTarget !== undefined })) : h(EmptyNotice, { title: "No repository questions", detail: "The selected repository has no parsed questions." })),
    h("section", { className: "space-y-3", "aria-labelledby": "pending-interactions-heading" }, h("div", { className: "flex items-center justify-between gap-3" }, h("h3", { id: "pending-interactions-heading", className: "text-sm font-semibold" }, "BB pending interactions"), h(Badge, { label: interactions ? String(interactions.interactions.length) : "…", tone: "neutral" })), pendingContent),
  );
}

function RunLinks({ run, onOpenThread, onOpenProject }: { run: OperationalRunSummary; onOpenThread: (threadId: string) => void; onOpenProject: (projectId: string) => void }) {
  return h(
    "div",
    { className: "flex flex-wrap items-center gap-2" },
    run.workerThreadId ? h("button", { type: "button", className: quietButtonClass, onClick: () => onOpenThread(run.workerThreadId!) }, `Thread ${run.workerThreadId}`) : h("span", { className: "text-xs text-muted-foreground" }, "Thread pending"),
    run.projectId ? h("button", { type: "button", className: quietButtonClass, onClick: () => onOpenProject(run.projectId!) }, `Project ${run.projectId}`) : null,
    h("span", { className: "text-xs text-muted-foreground" }, `Environment ${run.environmentId ?? "pending"}`),
    h("span", { className: "text-xs text-muted-foreground" }, `Provider ${run.providerId ?? "pending"}`),
  );
}

function RunSummaryCard({ run, onOpen, onOpenThread, onOpenProject }: { run: OperationalRunSummary; onOpen: () => void; onOpenThread: (threadId: string) => void; onOpenProject: (projectId: string) => void }) {
  return h(
    "article",
    { className: cardClass },
    h("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" }, h("div", null, h("h3", { className: "font-mono text-sm font-semibold" }, run.runId), h("p", { className: "mt-1 text-xs text-muted-foreground" }, `Requested ${formatTimestamp(run.requestedAt)}`)), h("div", { className: "flex items-center gap-2" }, h(Badge, { label: runStatusLabel(run.status), tone: statusTone(run.status) }), h("button", { type: "button", className: buttonClass, onClick: onOpen }, "View details"))),
    h("div", { className: "mt-3" }, h(RunLinks, { run, onOpenThread, onOpenProject })),
    h("div", { className: "mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" }, h("span", null, `Queue items: ${run.queueItemIds.length > 0 ? run.queueItemIds.join(", ") : "none"}`), h("span", null, `Revision: ${run.repositoryRevision.gitCommit ?? "uncommitted"}`), h("span", null, `Canonical records: ${run.canonicalRecords.length}`)),
  );
}

export interface RunsViewProps {
  runs: OperationalRunSummary[];
  nextCursor: string | null;
  onOpenRun: (runId: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenProject: (projectId: string) => void;
}

export function RunsView({ runs, nextCursor, onOpenRun, onOpenThread, onOpenProject }: RunsViewProps) {
  return h(
    "div",
    { className: "space-y-4" },
    h("div", null, h("p", { className: labelClass }, "Operational state"), h("h2", { className: "mt-1 text-xl font-semibold" }, "Runs"), h("p", { className: "mt-1 text-sm text-muted-foreground" }, "Each run is linked to its stable BB thread, project, environment, provider, repository revision, and canonical records.")),
    runs.length > 0 ? h("div", { className: "space-y-3" }, runs.map((run) => h(RunSummaryCard, { key: run.runId, run, onOpen: () => onOpenRun(run.runId), onOpenThread, onOpenProject })), nextCursor ? h("p", { className: "text-xs text-muted-foreground" }, `More runs are available after cursor ${nextCursor}.`) : null) : h(EmptyNotice, { title: "No runs recorded", detail: "The operational state reader has no runs for this repository." }),
  );
}

function CanonicalRecords({ run, repository, fileLink }: { run: OperationalRunSummary; repository: RepositoryConfiguration; fileLink?: FileLinkRenderer }) {
  return h("section", { className: cardClass, "aria-labelledby": "canonical-records-heading" }, h("h3", { id: "canonical-records-heading", className: "text-sm font-semibold" }, "Canonical records"), run.canonicalRecords.length > 0 ? h("ul", { className: "mt-3 space-y-2" }, run.canonicalRecords.map((record) => h("li", { key: `${record.recordType}:${record.recordId}`, className: "flex flex-col gap-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between" }, h(FilePath, { path: record.relativePath, target: runFileTarget(run, repository, record.relativePath), fileLink }), h("span", { className: "text-xs text-muted-foreground" }, `${record.recordType} · ${record.recordId} · ${record.repositoryRevision.gitCommit ?? "uncommitted"}`)))) : h("p", { className: "mt-2 text-sm text-muted-foreground" }, "No canonical record links were returned."));
}

function Attempts({ detail }: { detail: OperationalRunDetail }) {
  return h("section", { className: cardClass, "aria-labelledby": "run-attempts-heading" }, h("h3", { id: "run-attempts-heading", className: "text-sm font-semibold" }, "Dispatch attempts"), detail.attempts.length > 0 ? h("div", { className: "mt-3 space-y-3" }, detail.attempts.map((attempt) => h("div", { key: attempt.attemptId, className: "rounded-md bg-surface-recessed/40 p-3" }, h("div", { className: "flex flex-wrap items-center justify-between gap-2" }, h("code", { className: "text-xs" }, attempt.attemptId), h(Badge, { label: runStatusLabel(attempt.status), tone: statusTone(attempt.status) })), h("p", { className: "mt-2 text-sm text-muted-foreground" }, `${attempt.providerId} · ${attempt.model} · ${attempt.reasoningLevel}`), h("p", { className: "mt-1 text-xs text-muted-foreground" }, `${formatTimestamp(attempt.startedAt)} to ${formatTimestamp(attempt.finishedAt)}`)))) : h("p", { className: "mt-2 text-sm text-muted-foreground" }, "No dispatch attempts recorded."));
}

export interface RunDetailViewProps {
  detail: OperationalRunDetail | null;
  repository: RepositoryConfiguration;
  fileLink?: FileLinkRenderer;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenProject: (projectId: string) => void;
  onStop?: () => void;
  onRetry?: (attemptId: string) => void;
  pendingTarget?: string | null;
  feedback?: ActionFeedback | null;
}

export function RunDetailView({ detail, repository, fileLink, onBack, onOpenThread, onOpenProject, onStop, onRetry, pendingTarget, feedback }: RunDetailViewProps) {
  if (!detail) {
    return h(
      "div",
      { className: "space-y-4" },
      h("button", { type: "button", className: quietButtonClass, onClick: onBack }, "Back to runs"),
      h(EmptyNotice, { title: "Run not found", detail: "No durable run record matched this route." }),
    );
  }

  const run = detail.summary;
  const summary = h(
    "section",
    { className: cardClass },
    h(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3" },
      h("div", null, h("p", { className: labelClass }, "Run detail"), h("h2", { className: "mt-1 break-all font-mono text-lg font-semibold" }, run.runId)),
      h(Badge, { label: runStatusLabel(run.status), tone: statusTone(run.status) }),
    ),
    h("div", { className: "mt-4" }, h(RunLinks, { run, onOpenThread, onOpenProject })),
    h(
      "dl",
      { className: "mt-4 grid gap-3 sm:grid-cols-2" },
      h("div", null, h("dt", { className: labelClass }, "Requested"), h("dd", { className: "mt-1 text-sm" }, formatTimestamp(run.requestedAt))),
      h("div", null, h("dt", { className: labelClass }, "Started"), h("dd", { className: "mt-1 text-sm" }, formatTimestamp(run.startedAt))),
      h("div", null, h("dt", { className: labelClass }, "Finished"), h("dd", { className: "mt-1 text-sm" }, formatTimestamp(run.finishedAt))),
      h("div", null, h("dt", { className: labelClass }, "Revision"), h("dd", { className: "mt-1 break-all font-mono text-xs" }, run.repositoryRevision.gitCommit ?? "uncommitted")),
    ),
    h("p", { className: "mt-4 text-sm text-muted-foreground" }, `Queue items: ${run.queueItemIds.length > 0 ? run.queueItemIds.join(", ") : "none"}`),
  );
  const intent = h(
    "section",
    { className: cardClass, "aria-labelledby": "run-intent-heading" },
    h("h3", { id: "run-intent-heading", className: "text-sm font-semibold" }, "Run intent"),
    h(
      "dl",
      { className: "mt-3 grid gap-3 sm:grid-cols-2" },
      h("div", null, h("dt", { className: labelClass }, "Trigger"), h("dd", { className: "mt-1 text-sm" }, detail.intent.trigger)),
      h("div", null, h("dt", { className: labelClass }, "Requested"), h("dd", { className: "mt-1 text-sm" }, formatTimestamp(detail.intent.requestedAt))),
      h(
        "div",
        { className: "sm:col-span-2" },
        h("dt", { className: labelClass }, "Authorization provenance"),
        h("dd", { className: "mt-1 space-y-1 text-sm" }, detail.intent.authorizationProvenance.map((item) => h("div", { key: item.queueItemId }, `${item.queueItemId}: ${item.source}${item.approvedText ? ` · ${item.approvedText}` : ""}`))),
      ),
    ),
  );

  const latestFailedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.status === "failed-safe");
  return h(
    "div",
    { className: "space-y-4" },
    h("button", { type: "button", className: quietButtonClass, onClick: onBack }, "Back to runs"),
    summary,
    feedback ? h(ActionFeedbackNotice, { feedback }) : null,
    onStop || onRetry ? h(RunActionControls, {
      status: run.status,
      latestFailedAttemptId: run.status === "failed-safe" && latestFailedAttempt ? latestFailedAttempt.attemptId : null,
      feedback: pendingTarget ? pendingActionFeedback : null,
      onStop: onStop ?? (() => {}),
      onRetry: onRetry ?? (() => {}),
    }) : null,
    h(CanonicalRecords, { run, repository, fileLink }),
    h(Attempts, { detail }),
    intent,
  );
}

function SettingValue({ label, value }: { label: string; value: string }) {
  return h("div", { className: "flex flex-col gap-1 rounded-md bg-surface-recessed/30 p-3" }, h("dt", { className: labelClass }, label), h("dd", { className: "break-all text-sm" }, value));
}

function ValidationCard({ validation }: { validation: SettingsProjection["validation"] }) {
  const errors = Object.entries(validation.fieldErrors);
  return h("section", { className: cardClass, "aria-labelledby": "settings-validation-heading" }, h("div", { className: "flex items-start justify-between gap-3" }, h("h3", { id: "settings-validation-heading", className: "text-sm font-semibold" }, "Validation"), h(Badge, { label: validation.valid ? "Valid" : "Invalid", tone: validation.valid ? "success" : "danger" })), errors.length > 0 ? h("ul", { className: "mt-3 space-y-2 text-sm text-destructive" }, errors.map(([field, messages]) => h("li", { key: field }, h("span", { className: "font-medium" }, `${field}: `), messages.join("; ")))) : h("p", { className: "mt-3 text-sm text-muted-foreground" }, "No validation errors reported."));
}

function DispatchStatusCard({ dispatch }: { dispatch: DispatchStatus }) {
  return h("section", { className: cardClass, "aria-labelledby": "settings-dispatch-heading" }, h("div", { className: "flex items-start justify-between gap-3" }, h("h3", { id: "settings-dispatch-heading", className: "text-sm font-semibold" }, "Dispatch status"), h(Badge, { label: dispatch.mode, tone: statusTone(dispatch.mode) })), h("dl", { className: "mt-3 space-y-3 text-sm" }, h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Accepting new runs"), h("dd", null, dispatch.acceptingNewRuns ? "Yes" : "No")), h("div", { className: "flex justify-between gap-4" }, h("dt", { className: "text-muted-foreground" }, "Active runs"), h("dd", null, String(dispatch.activeRunCount)))), dispatch.reason ? h("p", { className: "mt-3 text-sm leading-5 text-warning" }, dispatch.reason) : null);
}

export function SettingsView({ projection }: { projection: SettingsProjection }) {
  const settings = projection.settings;
  const values: Array<[string, string]> = [
    ["Repository key", settings.repositoryKey ?? "Not configured"],
    ["Repository root", settings.repositoryRoot ?? "Not configured"],
    ["Connected host", settings.connectedHostId ?? "Not configured"],
    ["Checkout path", settings.checkoutPath ?? "Not configured"],
    ["Schedule", settings.scheduleCron ?? "Not configured"],
    ["Time zone", settings.timeZone],
    ["Night-window end", `${settings.nightWindowEndHour}:00 server-local`],
    ["Runtime cap", formatDuration(settings.runtimeCapSeconds)],
    ["Provider preference", settings.providerPreference ?? "Not set"],
    ["Minimum start gap", formatDuration(settings.minimumStartGapSeconds)],
    ["Concurrency limit", String(settings.concurrencyLimit)],
    ["Dispatch mode", settings.dispatchMode],
  ];
  return h("div", { className: "space-y-4" }, h("div", null, h("p", { className: labelClass }, "Operational settings"), h("h2", { className: "mt-1 text-xl font-semibold" }, "Settings"), h("p", { className: "mt-1 text-sm text-muted-foreground" }, "Validation and effective status only. Secret values are never returned to this UI.")), h("div", { className: "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" }, h("section", { className: cardClass, "aria-labelledby": "settings-values-heading" }, h("h3", { id: "settings-values-heading", className: "text-sm font-semibold" }, "Effective values"), h("dl", { className: "mt-3 grid gap-2 sm:grid-cols-2" }, values.map(([label, value]) => h(SettingValue, { key: label, label, value })))), h("div", { className: "space-y-4" }, h(ValidationCard, { validation: projection.validation }), h(DispatchStatusCard, { dispatch: projection.dispatch }))));
}

export function RepositorySelectionView({ projection }: { projection: RepositorySelectionProjection }) {
  return h("div", { className: "space-y-4" }, h("section", { className: cardClass }, h("p", { className: labelClass }, "Repository selection"), h("h2", { className: "mt-1 text-xl font-semibold" }, "No repository is selected"), h("p", { className: "mt-2 text-sm leading-6 text-muted-foreground" }, "Configure a repository in the host settings before using the Factory read surfaces.")), projection.repositories.length > 0 ? h("section", { className: "space-y-3", "aria-labelledby": "available-repositories-heading" }, h("h3", { id: "available-repositories-heading", className: "text-sm font-semibold" }, "Configured repositories"), projection.repositories.map((repository) => h("article", { key: repository.configuration.repositoryKey, className: cardClass }, h("div", { className: "flex flex-wrap items-center justify-between gap-2" }, h("h4", { className: "font-mono text-sm font-semibold" }, repository.configuration.repositoryKey), h(Badge, { label: repository.available ? "Available" : "Unavailable", tone: statusTone(repository.available ? "available" : "unavailable") })), repository.reasons.length > 0 ? h("ul", { className: "mt-3 space-y-1 text-sm text-warning" }, repository.reasons.map((reason) => h("li", { key: reason }, `• ${reason}`))) : h("p", { className: "mt-3 text-sm text-muted-foreground" }, "No selection issues reported.")))) : h(EmptyNotice, { title: "No repositories configured", detail: "The repository discovery projection returned an empty list." }));
}

export function RouteNotFound({ raw, onBack }: { raw: string; onBack: () => void }) {
  return h("div", { className: "space-y-4" }, h(ErrorNotice, { title: "Unknown Factory route", message: `Unknown Factory view path: ${raw || "(empty)"}.`, onRetry: onBack }));
}
