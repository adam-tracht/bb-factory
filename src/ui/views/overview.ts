import { createElement, useEffect, useState, type ReactNode } from "react";
import type {
  HealthProjection,
  OperationalRunListProjection,
  OperationalRunSummary,
  ProtocolSnapshot,
  ProviderStatus,
  SettingsProjection,
} from "../../contracts.js";
import { nextCronTimes } from "../../schedule/cron.js";
import { describeSchedule } from "../../schedule/describe.js";
import type { AttentionItem } from "../attention.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  CopyText,
  Disclosure,
  ErrorNotice,
  Field,
  FilePath,
  Section,
  StatusDot,
  formatDuration,
  formatTimestamp,
  isActiveRunStatus,
  repositoryFileTarget,
  runStatusLabel,
  runStatusTone,
  sectionStorageKey,
  shortSha,
  timeAgo,
  usePhoneViewport,
  type Tone,
} from "../primitives.js";

const h = createElement;

const SEVERITY_TONE: Record<AttentionItem["severity"], Tone> = {
  action: "warning",
  warning: "danger",
  info: "neutral",
};

const AVAILABILITY_TONE: Record<ProviderStatus["availability"], Tone> = {
  available: "success",
  limited: "warning",
  unavailable: "danger",
  unknown: "neutral",
};

/** Ticking clock for the elapsed indicator; same cadence idea as the shell strip. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Seconds to "1 hr 30 min" style for the minimum start gap. */
function humanizeSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} sec`);
  return parts.join(" ");
}

interface AttentionAction {
  readonly label: string;
  readonly onClick: () => void;
  /** Set when the action mutates; the button disables while any action is in flight. */
  readonly pendingTarget?: string;
}

function attentionAction(item: AttentionItem, ctx: ViewContext): AttentionAction | null {
  switch (item.id) {
    case "blocking-questions":
    case "assumption-questions":
    case "pending-interactions":
      return { label: "Answer", onClick: () => ctx.onOpenSection("questions") };
    case "approvals":
    case "gated-items":
    case "waiting-dependencies":
    case "unknown-status":
      return { label: "Review", onClick: () => ctx.onOpenSection("work") };
    case "failed-run":
      return { label: "Review run", onClick: () => ctx.onOpenSection("runs") };
    case "host-degraded":
    case "provider-degraded":
    case "no-provider":
    case "concurrency-reached":
      return { label: "Open settings", onClick: () => ctx.onOpenSection("settings") };
    case "dispatch-paused":
      return { label: "Resume", pendingTarget: "dispatch", onClick: () => ctx.onAction({ kind: "resume" }) };
    case "repository-paused":
      return {
        label: "Resume",
        pendingTarget: "repository",
        onClick: () => {
          void ctx.updateRepository({ repositoryKey: ctx.repository.repositoryKey, dispatchPaused: false });
        },
      };
    default:
      // Unknown ids (for example snapshot-error) fall back to their section.
      switch (item.section) {
        case "questions":
          return { label: "Answer", onClick: () => ctx.onOpenSection("questions") };
        case "runs":
          return { label: "Review run", onClick: () => ctx.onOpenSection("runs") };
        case "settings":
          return { label: "Open settings", onClick: () => ctx.onOpenSection("settings") };
        default:
          return { label: "Review", onClick: () => ctx.onOpenSection("work") };
      }
  }
}

function NeedsAttention(props: { attention: readonly AttentionItem[]; settings: SettingsProjection | null; ctx: ViewContext }) {
  const { attention, settings, ctx } = props;
  if (attention.length === 0) {
    const pausedNote = !settings
      ? null
      : settings.dispatch.mode !== "enabled"
        ? "Dispatch is paused; no new runs will start."
        : settings.dispatch.repositoryPaused || ctx.dispatchPaused
          ? "Dispatch is paused for this repository."
          : null;
    return h("div", { className: "flex flex-wrap items-center gap-2 px-1" },
      h(StatusDot, { tone: "success" }),
      h("span", { className: "text-sm font-medium text-success" }, "Nothing needs you."),
      pausedNote ? h("span", { className: "text-xs text-muted-foreground" }, pausedNote) : null);
  }
  return h(Section, {
    title: "Needs attention",
    count: attention.length,
    collapsible: true,
    defaultOpen: true,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "needs-attention"),
    children: attention.map((item) => {
      const action = attentionAction(item, ctx);
      const mutating = action?.pendingTarget !== undefined;
      return h("div", { key: item.id, className: "flex min-w-0 flex-wrap items-start gap-3 py-2 sm:flex-nowrap sm:items-center", "data-attention-id": item.id },
        h("span", { className: "mt-1.5 shrink-0 sm:mt-0" },
          h(StatusDot, { tone: SEVERITY_TONE[item.severity] })),
        h("div", { className: "min-w-0 flex-1" },
          h(Disclosure, {
            summary: h("span", null,
              h("span", { className: "text-sm font-normal text-foreground" }, item.title),
              h("span", {
                className: "mt-0.5 line-clamp-2 break-words text-xs font-normal text-muted-foreground sm:line-clamp-1",
                title: item.detail,
              }, item.detail)),
            children: h("p", { className: "break-words text-xs text-muted-foreground" }, item.detail),
          })),
        action
          ? h("div", { className: "flex basis-full justify-end sm:basis-auto" },
              h(ActionButton, {
                label: action.label,
                variant: "ghost",
                size: "xs",
                onClick: action.onClick,
                disabled: mutating && ctx.pendingTarget !== null,
                busy: mutating && ctx.pendingTarget === action.pendingTarget,
              }))
          : null);
    }),
  });
}

function CurrentRunCard(props: { run: OperationalRunSummary; ctx: ViewContext }) {
  const { run, ctx } = props;
  const now = useNow(30000);
  const phone = usePhoneViewport();
  const elapsed = formatDuration(run.startedAt ?? run.requestedAt, null, now);
  const threadId = run.workerThreadId;
  return h(Section, {
    title: "Current run",
    collapsible: true,
    defaultOpen: !phone,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "current-run"),
    children: h("div", { className: "px-1 py-1" }, [
      h("div", { key: "status", className: "flex flex-wrap items-center gap-2" },
        h(StatusDot, { tone: "primary", pulse: true }),
        h("span", { className: "text-sm font-medium" },
          run.status === "started" ? `Running${elapsed ? ` ${elapsed}` : ""}` : runStatusLabel(run.status)),
        run.providerId ? h("span", { className: "text-xs text-muted-foreground" }, `on ${run.providerId}`) : null,
        threadId
          ? h(ActionButton, { label: "Open thread", variant: "ghost", size: "xs", onClick: () => ctx.onOpenThread(threadId) })
          : null),
      run.queueItemIds.length > 0
        ? h("div", { key: "items", className: "mt-2 flex flex-wrap gap-1" },
            run.queueItemIds.map((id) =>
              h("span", {
                key: id,
                className: "max-w-full box-border break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground",
                style: { overflowWrap: "anywhere" },
              }, id)))
        : null,
      h("p", { key: "note", className: "mt-3 text-xs text-muted-foreground" }, "Pause stops new runs; this one continues."),
    ]),
  });
}

function LastRunLine(props: { runs: OperationalRunListProjection | null; ctx: ViewContext }) {
  const { runs, ctx } = props;
  const phone = usePhoneViewport();
  if (!runs) return null;
  const finished = runs.runs
    .filter((run) => run.finishedAt !== null)
    .sort((left, right) => new Date(right.finishedAt ?? 0).getTime() - new Date(left.finishedAt ?? 0).getTime());
  const last = finished[0];
  const duration = last ? formatDuration(last.startedAt ?? last.requestedAt, last.finishedAt) : null;
  const content = !last
    ? h("p", { className: "px-1 py-2 text-xs text-muted-foreground" }, "No finished runs on record.")
    : h("div", { className: "flex flex-wrap items-center gap-2 px-1 py-2 text-sm" },
        h("span", { className: "text-foreground" }, timeAgo(last.finishedAt) ?? formatTimestamp(last.finishedAt) ?? ""),
        h(Badge, { label: runStatusLabel(last.status), tone: runStatusTone(last.status) }),
        last.providerId ? h("span", { className: "text-xs text-muted-foreground" }, last.providerId) : null,
        duration ? h("span", { className: "text-xs text-muted-foreground" }, duration) : null,
        h(ActionButton, { label: "View", variant: "ghost", size: "xs", onClick: () => ctx.onOpenRun(last.runId) }));
  return h(Section, {
    title: "Last run",
    collapsible: true,
    defaultOpen: !phone,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "last-run"),
    children: content,
  });
}

function DispatchCard(props: { settings: SettingsProjection | null; health: HealthProjection | null; ctx: ViewContext }) {
  const { settings, health, ctx } = props;
  const phone = usePhoneViewport();
  const healthRow = h("div", { key: "health", className: "mt-3 border-t border-border pt-2" }, h(HealthLine, { health, settings }));
  if (!settings) {
    return h(Section, {
      title: "Dispatch",
      collapsible: true,
      defaultOpen: !phone,
      storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "dispatch"),
      children: h("div", { className: "px-1 py-1" },
        h("p", { className: "text-sm text-muted-foreground" }, "Dispatch settings are unavailable."),
        healthRow),
    });
  }
  const dispatch = settings.dispatch;
  const repoPaused = ctx.dispatchPaused || dispatch.repositoryPaused;
  const mode: { label: string; tone: Tone } = dispatch.mode !== "enabled"
    ? { label: "Paused", tone: "warning" }
    : repoPaused
      ? { label: "Repo paused", tone: "warning" }
      : { label: "Enabled", tone: "success" };
  const cron = settings.settings.scheduleCron ?? null;
  const timeZone = settings.settings.timeZone;
  const nextTimes = cron ? nextCronTimes(cron, timeZone, 3) : [];
  const preference = settings.settings.providerPreference;
  const preferred = preference && preference !== "alternate"
    ? health?.providers.find((provider) => provider.providerId === preference) ?? null
    : null;

  return h(Section, {
    title: "Dispatch",
    collapsible: true,
    defaultOpen: !phone,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "dispatch"),
    actions: h("div", { className: "flex items-center gap-2" },
      h(Badge, { label: mode.label, tone: mode.tone }),
      h(ActionButton, { label: "Edit", variant: "ghost", size: "xs", onClick: () => ctx.onOpenSection("settings") })),
    children: h("div", { className: "px-1 py-1" }, [
    h("dl", { key: "fields", className: "grid gap-3 sm:grid-cols-2" },
      h(Field, { label: "Schedule" },
        h("dd", { className: "mt-0.5 text-sm" },
          cron ? describeSchedule(cron) ?? h("code", { className: "font-mono text-xs" }, cron) : "No schedule set",
          cron && timeZone !== "server-local"
            ? h("span", { className: "text-xs text-muted-foreground" }, ` (${timeZone})`)
            : null)),
      cron
        ? h(Field, { label: "Next runs" },
            nextTimes.length > 0
              ? h("dd", { className: "mt-0.5 text-sm" },
                  h("ul", { className: "space-y-0.5" },
                    nextTimes.map((time) => h("li", { key: time.toISOString() }, formatTimestamp(time.toISOString())))))
              : h("dd", { className: "mt-0.5 text-sm text-muted-foreground" }, "No upcoming times within 14 days"))
        : null,
      h(Field, { label: "Minimum start gap" },
        h("dd", { className: "mt-0.5 text-sm" }, humanizeSeconds(settings.settings.minimumStartGapSeconds))),
      h(Field, { label: "Provider preference" },
        h("dd", { className: "mt-0.5 flex items-center gap-2 text-sm" },
          h("span", null, preference ?? "Not set"),
          preference && preference !== "alternate"
            ? preferred
              ? h(Badge, {
                  label: preferred.availability,
                  tone: AVAILABILITY_TONE[preferred.availability],
                  ...(preferred.lastError ? { title: preferred.lastError } : {}),
                })
              : h("span", { className: "text-xs text-muted-foreground" }, "not reported")
            : null))),
    h("p", { key: "status", className: "mt-3 border-t border-border pt-2 text-xs text-muted-foreground" },
      `${dispatch.acceptingNewRuns ? "Accepting new runs" : "Not accepting new runs"}; ${dispatch.activeRunCount} of ${settings.settings.concurrencyLimit} slot${settings.settings.concurrencyLimit === 1 ? "" : "s"} in use.`,
      dispatch.reason ? ` ${dispatch.reason}` : null),
    healthRow,
    ]),
  });
}

/** Health is derived, never hardcoded: host preflight plus the pinned provider. */
function HealthLine(props: { health: HealthProjection | null; settings: SettingsProjection | null }) {
  const { health, settings } = props;
  const preference = settings?.settings.providerPreference;
  const pinned = preference && preference !== "alternate" ? preference : null;
  const provider = pinned ? health?.providers.find((candidate) => candidate.providerId === pinned) ?? null : null;
  const providerOk = !pinned || provider?.availability === "available";

  let tone: Tone = "neutral";
  let text = "Health status unavailable.";
  if (health) {
    if (health.host.ok && providerOk) {
      tone = "success";
      text = "Healthy";
    } else {
      tone = "warning";
      const providerReason = provider && provider.availability !== "available"
        ? `${provider.providerId} ${provider.availability}${provider.lastError ? `: ${provider.lastError}` : ""}`
        : null;
      const reason = health.host.reasons[0]
        ?? providerReason
        ?? (!health.host.ok ? `Host ${health.host.hostId} is ${health.host.status}` : "Preferred provider is not available");
      text = `Degraded: ${reason}`;
    }
  }
  return h("div", { className: "flex items-center gap-2 px-1 text-sm" },
    h(StatusDot, { tone }),
    h("span", { className: "text-xs text-muted-foreground" }, "Health"),
    h("span", { className: tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-muted-foreground" }, text));
}

function RepositoryCard(props: { snapshot: ProtocolSnapshot; health: HealthProjection | null; ctx: ViewContext }) {
  const { snapshot, health, ctx } = props;
  const phone = usePhoneViewport();
  const repository = ctx.repository;
  const dashboard = snapshot.dashboard;
  const branch = health?.host.branch ?? snapshot.repository.factoryBranch;
  const commit = snapshot.revision.gitCommit;
  return h(Section, {
    title: "Repository",
    collapsible: true,
    defaultOpen: !phone,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "repository"),
    children: h("div", { className: "px-1 py-1" }, [
    h("div", { key: "status", className: "flex flex-wrap items-center gap-2 text-sm" },
      h(Badge, { label: branch, tone: "neutral", title: "Checked-out branch" }),
      h("span", { className: "text-muted-foreground" },
        `${dashboard.factoryAhead} ahead, ${dashboard.mainBehind} behind ${dashboard.mainRef}`),
      h(Badge, {
        label: dashboard.safeFastForward ? "fast-forward safe" : "not fast-forward safe",
        tone: dashboard.safeFastForward ? "success" : "warning",
      }),
      commit
        ? h(CopyText, { value: commit, label: `@${shortSha(commit) ?? commit}`, mono: true })
        : h("span", { className: "text-xs text-muted-foreground" }, "uncommitted")),
    h("dl", { key: "paths", className: "mt-3 grid gap-3 sm:grid-cols-2" },
      h(Field, { label: "Repository root" },
        h("dd", { className: "mt-0.5" }, h(CopyText, { value: repository.repositoryRoot, mono: true }))),
      h(Field, { label: "Checkout" },
        h("dd", { className: "mt-0.5" }, h(CopyText, { value: repository.checkoutPath, mono: true })))),
    dashboard.taskCommits.length > 0
      ? h("div", { key: "commits", className: "mt-3 border-t border-border pt-2" },
          h(Disclosure, {
            summary: `${dashboard.taskCommits.length} task commit${dashboard.taskCommits.length === 1 ? "" : "s"}`,
            children: h("ul", { className: "space-y-1" },
              dashboard.taskCommits.map((entry) =>
                h("li", { key: entry.sha, className: "flex items-baseline gap-2 text-xs" },
                  h("code", { className: "shrink-0 font-mono text-muted-foreground" }, shortSha(entry.sha) ?? entry.sha),
                  h("span", { className: "min-w-0 break-words" }, entry.subject)))),
          }))
      : null,
    h("div", { key: "links", className: "mt-3 border-t border-border pt-2" },
      h(ProtocolLinks, { snapshot, ctx })),
    ]),
  });
}

function ProtocolLinks(props: { snapshot: ProtocolSnapshot; ctx: ViewContext }) {
  const { snapshot, ctx } = props;
  const entries: Array<{ label: string; path: string | null }> = [
    { label: "Current state", path: snapshot.currentRun.currentPath },
    { label: "Foreman", path: snapshot.foremanTemplate.relativePath },
    { label: "Latest run report", path: snapshot.currentRun.latestRunPath },
    { label: "Dashboard", path: snapshot.dashboard.canonicalPath },
  ];
  return h("div", { className: "flex flex-wrap gap-x-5 gap-y-1 px-1" },
    entries.map((entry) =>
      h("span", { key: entry.label, className: "inline-flex items-baseline gap-1.5 text-xs" },
        h("span", { className: "text-muted-foreground" }, `${entry.label}:`),
        entry.path
          ? h(FilePath, {
              path: entry.path,
              target: repositoryFileTarget(ctx.repository, ctx.environmentId, entry.path),
              fileLink: ctx.fileLink,
            })
          : h("span", { className: "text-muted-foreground" }, "none"))));
}

function TechnicalDetails(props: { snapshot: ProtocolSnapshot; settings: SettingsProjection | null; ctx: ViewContext }) {
  const { snapshot, settings, ctx } = props;
  const row = (label: string, value: ReactNode) =>
    h("div", { className: "flex items-center justify-between gap-3 py-0.5" },
      h("dt", { className: "text-xs text-muted-foreground" }, label),
      h("dd", { className: "min-w-0 text-right text-xs" }, value));
  return h(Section, {
    title: "Technical details",
    collapsible: true,
    defaultOpen: false,
    storageKey: sectionStorageKey(ctx.repository.repositoryKey, "overview", "technical-details"),
    children: h("dl", { className: "mx-1 rounded-md border border-border px-3 py-2" },
      row("Foreman digest", h(CopyText, {
        value: snapshot.foremanTemplate.contentSha256,
        label: shortSha(snapshot.foremanTemplate.contentSha256) ?? undefined,
        mono: true,
      })),
      row("Protocol digest", h(CopyText, {
        value: snapshot.revision.protocolDigest,
        label: shortSha(snapshot.revision.protocolDigest) ?? undefined,
        mono: true,
      })),
      row("Captured", formatTimestamp(snapshot.capturedAt) ?? snapshot.capturedAt),
      settings?.settings.scheduleCron
        ? row("Schedule cron", h("code", { className: "font-mono" }, settings.settings.scheduleCron))
        : null),
  });
}

export function OverviewView(props: {
  snapshot: ProtocolSnapshot | null;
  snapshotError: string | null;
  settings: SettingsProjection | null;
  health: HealthProjection | null;
  runs: OperationalRunListProjection | null;
  attention: readonly AttentionItem[];
  activeRun: OperationalRunSummary | null;
  ctx: ViewContext;
}): ReactNode {
  const { snapshot, snapshotError, settings, health, runs, attention, activeRun, ctx } = props;
  return h("div", { className: "space-y-4" },
    h(NeedsAttention, { attention, settings, ctx }),
    snapshotError && !snapshot
      ? h(ErrorNotice, {
          message: `Repository protocol files failed to load (${snapshotError}). Dispatch, health, and run state below still reflect live BB state.`,
        })
      : null,
    activeRun && isActiveRunStatus(activeRun.status) ? h(CurrentRunCard, { run: activeRun, ctx }) : null,
    h(LastRunLine, { runs, ctx }),
    h(DispatchCard, { settings, health, ctx }),
    snapshot ? h(RepositoryCard, { snapshot, health, ctx }) : null,
    snapshot ? h(TechnicalDetails, { snapshot, settings, ctx }) : null);
}
