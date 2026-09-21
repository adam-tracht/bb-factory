import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CanonicalFileRecordLink,
  DispatchAttempt,
  OperationalRunDetail,
  OperationalRunListProjection,
  OperationalRunSummary,
} from "../../contracts.js";
import type { ViewContext } from "../context.js";
import { repositoryLabel } from "../../repository-label.js";
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CopyText,
  EmptyNotice,
  FeedbackNotice,
  FilePath,
  Section,
  StatusDot,
  TypedConfirmDialog,
  formatDuration,
  formatTimestamp,
  isActiveRunStatus,
  repositoryFileTarget,
  runFileTarget,
  runStatusLabel,
  runStatusTone,
  sectionStorageKey,
  timeAgo,
  usePhoneViewport,
  type FileLinkTarget,
} from "../primitives.js";

const h = createElement;

/**
 * Local ticking clock for live elapsed timers. The shell keeps its own copy;
 * primitives does not export one.
 */
export function useRunsNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * FilePath always renders the path as its label. For actions that need a
 * human label ("Open runs folder") this renders the injected file link
 * directly and falls back to a plain path when no link host is present.
 */
function LabelledFileLink(props: {
  ctx: ViewContext;
  target: FileLinkTarget | null;
  path: string;
  label: string;
}) {
  if (props.target && props.ctx.fileLink) {
    return h(props.ctx.fileLink, {
      target: props.target,
      className: "inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-state-hover",
    }, props.label);
  }
  return h(FilePath, { path: props.path });
}

function QueueItemChips({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) {
    return h("span", { className: "text-xs text-muted-foreground" }, "No tasks");
  }
  return h("span", { className: "flex min-w-0 flex-wrap gap-1" },
    ids.map((id) => h("span", {
      key: id,
      className: "max-w-full box-border break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground",
      style: { overflowWrap: "anywhere" },
    }, id)));
}

function ActiveRunRow({ run, now, ctx }: { run: OperationalRunSummary; now: number; ctx: ViewContext }) {
  const threadId = run.workerThreadId;
  const elapsed = formatDuration(run.startedAt ?? run.requestedAt, null, now);
  return h("div", { className: "flex flex-wrap items-center gap-2 px-1 py-1.5" },
    h(StatusDot, { tone: "primary", pulse: true }),
    h("button", {
      type: "button",
      className: "flex min-w-0 flex-1 box-border flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-state-hover",
      onClick: () => ctx.onOpenRun(run.runId),
    },
      h(Badge, { label: runStatusLabel(run.status), tone: runStatusTone(run.status) }),
      elapsed ? h("span", { className: "text-sm font-medium tabular-nums" }, elapsed) : null,
      run.providerId ? h("span", { className: "text-xs text-muted-foreground" }, run.providerId) : null,
      h(QueueItemChips, { ids: run.queueItemIds })),
    threadId
      ? h(ActionButton, {
          label: "Thread",
          variant: "ghost",
          size: "xs",
          title: `Open worker thread ${threadId}`,
          onClick: () => ctx.onOpenThread(threadId),
        })
      : null);
}

function HistoryRunRow({ run, now, ctx }: { run: OperationalRunSummary; now: number; ctx: ViewContext }) {
  const when = timeAgo(run.startedAt ?? run.requestedAt, now);
  const duration = formatDuration(run.startedAt, run.finishedAt, now);
  return h("button", {
    type: "button",
    className: "flex w-full min-w-0 box-border items-center gap-3 px-1 py-2 text-left transition-colors hover:bg-state-hover",
    onClick: () => ctx.onOpenRun(run.runId),
  },
    h("div", { className: "flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3" },
      h("div", { className: "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" },
        h("span", { className: "w-14 shrink-0 text-xs text-muted-foreground" }, when ?? ""),
        h(Badge, { label: runStatusLabel(run.status), tone: runStatusTone(run.status) }),
        run.providerId ? h("span", { className: "text-xs text-muted-foreground" }, run.providerId) : null,
        duration ? h("span", { className: "text-xs tabular-nums text-muted-foreground" }, duration) : null),
      h(QueueItemChips, { ids: run.queueItemIds })),
    h("span", { className: "shrink-0 self-center text-muted-foreground", "aria-hidden": true }, "›"));
}

export type RunGroup = "active" | "history";

export const RUN_GROUPS: ReadonlyArray<{ key: RunGroup; title: string; defaultOpen: boolean }> = [
  { key: "active", title: "Active", defaultOpen: true },
  { key: "history", title: "History", defaultOpen: true },
];

export function bucketRuns(runs: readonly OperationalRunSummary[]): Record<RunGroup, OperationalRunSummary[]> {
  const buckets: Record<RunGroup, OperationalRunSummary[]> = { active: [], history: [] };
  for (const run of runs) (isActiveRunStatus(run.status) ? buckets.active : buckets.history).push(run);
  return buckets;
}

export function RunGroupRows(props: {
  group: RunGroup;
  runs: readonly OperationalRunSummary[];
  now: number;
  ctx: ViewContext;
}): ReactNode {
  return props.runs.map((run) => props.group === "active"
    ? h(ActiveRunRow, { key: run.runId, run, now: props.now, ctx: props.ctx })
    : h(HistoryRunRow, { key: run.runId, run, now: props.now, ctx: props.ctx }));
}

export function RunGroupSection(props: {
  group: RunGroup;
  title?: string;
  runs: readonly OperationalRunSummary[];
  now: number;
  ctx: ViewContext;
  defaultOpen?: boolean;
  storageKey?: string;
}): ReactNode {
  const phone = usePhoneViewport();
  return h(Section, {
    title: props.title ?? RUN_GROUPS.find((section) => section.key === props.group)?.title ?? props.group,
    count: props.runs.length,
    collapsible: true,
    defaultOpen: props.defaultOpen ?? (props.group === "active" || !phone),
    storageKey: props.storageKey ?? sectionStorageKey(props.ctx.repository.repositoryKey, "runs", props.group),
    children: h(RunGroupRows, props),
  });
}

export function RunsView(props: { runs: OperationalRunListProjection; ctx: ViewContext }): ReactNode {
  const { runs, ctx } = props;
  const now = useRunsNow();
  const { active, history } = useMemo(() => bucketRuns(runs.runs), [runs.runs]);

  if (runs.runs.length === 0) {
    return h("div", { className: "space-y-4" },
      h(FeedbackNotice, { feedback: ctx.feedback }),
      h(EmptyNotice, {
        title: `No BB-tracked runs yet for ${repositoryLabel(ctx.repository.repositoryKey, ctx.displayName)}`,
        detail: "Runs recorded directly by the protocol live in plans/factory/runs/.",
        // The target uses the normalized path without a trailing slash; the
        // normalizer rejects empty segments.
        action: h(LabelledFileLink, {
          ctx,
          target: repositoryFileTarget(ctx.repository, ctx.environmentId, "plans/factory/runs"),
          path: "plans/factory/runs/",
          label: "Open runs folder",
        }),
      }));
  }

  return h("div", { className: "space-y-4" },
    h(FeedbackNotice, { feedback: ctx.feedback }),
    active.length > 0
      ? h(RunGroupSection, { group: "active", runs: active, now, ctx })
      : null,
    history.length > 0
      ? h(RunGroupSection, { group: "history", runs: history, now, ctx })
      : null,
    runs.nextCursor
      ? h("p", { className: "px-1 text-xs text-muted-foreground" }, "More runs exist beyond this page.")
      : null);
}

function Timeline({ run, active }: { run: OperationalRunSummary; active: boolean }) {
  const cells: Array<{ label: string; value: string }> = [
    { label: "Requested", value: formatTimestamp(run.requestedAt) ?? "pending" },
    { label: "Started", value: run.startedAt ? formatTimestamp(run.startedAt) ?? "pending" : "pending" },
    {
      label: "Finished",
      value: run.finishedAt
        ? formatTimestamp(run.finishedAt) ?? "running"
        : run.startedAt === null
          ? "pending"
          : active ? "running" : "not recorded",
    },
  ];
  return h("div", { className: "flex flex-wrap gap-x-6 gap-y-2" },
    cells.map((cell) => h("div", { key: cell.label },
      h("p", { className: "text-xs text-muted-foreground" }, cell.label),
      h("p", { className: "text-sm" }, cell.value))));
}

function CanonicalRecordRow({ run, record, ctx }: { run: OperationalRunSummary; record: CanonicalFileRecordLink; ctx: ViewContext }) {
  return h("div", { className: "flex items-baseline gap-2 px-1 py-1.5" },
    h("span", { className: "shrink-0 text-xs text-muted-foreground" }, record.recordType),
    h(FilePath, {
      path: record.relativePath,
      target: runFileTarget(run, ctx.repository, ctx.environmentId, record.relativePath),
      fileLink: ctx.fileLink,
      className: "min-w-0",
    }));
}

function AttemptRow({ attempt, ctx }: { attempt: DispatchAttempt; ctx: ViewContext }) {
  const threadId = attempt.workerThreadId;
  return h("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2" },
    h(Badge, { label: runStatusLabel(attempt.status), tone: runStatusTone(attempt.status) }),
    h("span", { className: "text-xs text-muted-foreground" }, `${attempt.providerId} · ${attempt.model} · ${attempt.reasoningLevel}`),
    h("span", { className: "text-xs tabular-nums text-muted-foreground" },
      `${formatTimestamp(attempt.startedAt) ?? "pending"} → ${formatTimestamp(attempt.finishedAt) ?? "running"}`),
    h("span", { className: "ml-auto flex min-w-0 items-center gap-2" },
      threadId
        ? h(ActionButton, {
            label: "Thread",
            variant: "ghost",
            size: "xs",
            title: `Open worker thread ${threadId}`,
            onClick: () => ctx.onOpenThread(threadId),
          })
        : null,
      h(CopyText, { value: attempt.attemptId, mono: true })));
}

export function RunDetailView(props: { detail: OperationalRunDetail; ctx: ViewContext }): ReactNode {
  const { detail, ctx } = props;
  const run = detail.summary;
  const now = useRunsNow();
  const [confirm, setConfirm] = useState<"retry" | "stop" | null>(null);
  const threadId = run.workerThreadId;
  const phone = usePhoneViewport();

  const latestAttempt = detail.attempts.length > 0 ? detail.attempts[detail.attempts.length - 1] : null;
  const active = isActiveRunStatus(run.status);
  const leaseQuarantined = detail.lease?.status === "reconciliation-required";
  const canRetry = latestAttempt !== null && run.status === "failed-safe" && !leaseQuarantined;
  const canResolveQuarantine = run.status === "failed-safe" && leaseQuarantined;
  const canStop = (active && run.status !== "reconciliation-required") || canResolveQuarantine;
  const retryRecovery = detail.attempts.filter((attempt) => attempt.runId === run.runId).length > 1;
  const pending = ctx.pendingTarget === `run:${run.runId}`;
  const duration = formatDuration(run.startedAt, run.finishedAt, now);
  const when = timeAgo(run.startedAt ?? run.requestedAt, now);
  const sectionKey = (name: string) =>
    sectionStorageKey(ctx.repository.repositoryKey, "runs", name);

  const technicalRows = ([
    ["Run id", run.runId],
    ["Attempt id", latestAttempt?.attemptId],
    ["Thread", run.workerThreadId],
    ["Project", run.projectId],
    ["Environment", run.environmentId],
    ["Host", ctx.repository.connectedHostId],
    ["Commit", run.repositoryRevision.gitCommit],
    ["Protocol digest", run.repositoryRevision.protocolDigest],
    ["Idempotency key", detail.intent.idempotencyKey],
  ] as Array<[string, string | null | undefined]>)
    .filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

  return h("div", { className: "space-y-4" },
    h(FeedbackNotice, { feedback: ctx.feedback }),
    h(Section, {
      title: "Summary",
      children: h("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-2 py-1" },
      h("button", {
        type: "button",
        className: "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground sm:min-h-0 sm:py-0.5",
        "aria-label": "Back to runs",
        onClick: () => ctx.onOpenSection("runs"),
      }, h("span", { "aria-hidden": "true" }, "‹"), "Runs"),
      h(Badge, { label: runStatusLabel(run.status), tone: runStatusTone(run.status) }),
      h("div", {
        // Phone: the metadata drops to a wrapped second line so the header's
        // controls stay on one line; sm+ dissolves the group so the spans sit
        // inline between the badge and the thread button as before.
        className: "order-last flex basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:contents",
      },
        when ? h("span", { className: "text-xs text-muted-foreground" }, when) : null,
        run.providerId ? h("span", { className: "text-xs text-muted-foreground" }, run.providerId) : null,
        h("span", { className: "text-xs text-muted-foreground" }, `${detail.intent.trigger} trigger`),
        duration ? h("span", { className: "text-xs tabular-nums text-muted-foreground" }, duration) : null),
      threadId
        ? h(ActionButton, {
            label: "Open thread",
            variant: "secondary",
            className: "ml-auto",
            title: `Open worker thread ${threadId}`,
            onClick: () => ctx.onOpenThread(threadId),
          })
        : null),
    }),
    run.status === "reconciliation-required"
      ? h("p", { role: "status", className: "rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground" }, retryRecovery
        ? "Retry recovery is being reconciled. A corrected correlated outcome may settle during the bounded window. Otherwise this run fails safe and frees global capacity; its repository lease remains quarantined until worker termination is confirmed."
        : "Terminal evidence is being reconciled. A corrected correlated outcome may settle during the bounded window. Otherwise this run fails safe and frees global capacity; its repository lease remains quarantined until worker termination is confirmed.")
      : run.status === "failed-safe"
        ? h("p", { role: "status", className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-foreground" }, leaseQuarantined
          ? "This run is terminal and failed safe. Global capacity is free, but repository ownership remains quarantined until worker termination is confirmed. Retry is unavailable while the lease is quarantined."
          : "This run is terminal and failed safe. Global capacity is free and the repository lease is released. Retry is the supported next action.")
        : null,
    h(Section, {
      title: "Timeline",
      collapsible: true,
      defaultOpen: !phone,
      storageKey: sectionKey("timeline"),
      children: h("div", { className: "px-1 py-1" }, h(Timeline, { run, active })),
    }),
    h(Section, {
      title: "Worked on",
      count: run.queueItemIds.length,
      collapsible: true,
      defaultOpen: !phone,
      storageKey: sectionKey("worked-on"),
      children: run.queueItemIds.length > 0
        ? run.queueItemIds.map((id) => h("button", {
            key: id,
            type: "button",
            className: "flex w-full box-border items-center justify-between gap-2 px-1 py-2 text-left transition-colors hover:bg-state-hover",
            onClick: () => ctx.onOpenSection("work", `work-${id}`),
          },
            h("span", { className: "font-mono text-xs" }, id),
            h("span", { className: "text-muted-foreground", "aria-hidden": true }, "›")))
        : h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, "No queue items were attached to this run."),
    }),
    h(Section, {
      title: "Canonical records",
      count: run.canonicalRecords.length,
      collapsible: true,
      defaultOpen: !phone,
      storageKey: sectionKey("canonical-records"),
      children: run.canonicalRecords.length > 0
        ? run.canonicalRecords.map((record) =>
            h(CanonicalRecordRow, { key: `${record.recordType}:${record.recordId}`, run, record, ctx }))
        : h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, "No canonical record links were recorded."),
    }),
    h(Section, {
      title: "Attempts",
      count: detail.attempts.length,
      collapsible: true,
      defaultOpen: false,
      storageKey: sectionKey("attempts"),
      children: detail.attempts.length > 0
        ? detail.attempts.map((attempt) => h(AttemptRow, { key: attempt.attemptId, attempt, ctx }))
        : h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, "No dispatch attempts recorded."),
    }),
    canRetry || canStop
      ? h("div", { className: "flex items-center gap-2" },
          canRetry
            ? h(ActionButton, {
                label: "Retry",
                variant: "secondary",
                disabled: pending,
                onClick: () => setConfirm("retry"),
              })
            : null,
          canStop
            ? h(ActionButton, {
                label: canResolveQuarantine ? "Resolve ownership" : "Stop run",
                variant: "danger",
                disabled: pending,
                onClick: () => setConfirm("stop"),
              })
            : null)
      : null,
    h(Section, {
      title: "Technical details",
      collapsible: true,
      defaultOpen: false,
      storageKey: sectionKey("technical-details"),
      children: h("dl", { className: "space-y-1.5 px-1 py-1" },
        technicalRows.map(([label, value]) => h("div", {
          key: label,
          className: "flex items-center justify-between gap-3",
        },
          h("dt", { className: "shrink-0 text-xs text-muted-foreground" }, label),
          h("dd", { className: "min-w-0" }, h(CopyText, { value, mono: true }))))),
    }),
    h(ConfirmDialog, {
      open: confirm === "retry",
      title: "Retry run",
      body: `Dispatches a new attempt for failed-safe run ${run.runId}. The previous attempt is terminal and the repository lease is released.`,
      confirmLabel: "Retry",
      busy: pending,
      onConfirm: () => {
        setConfirm(null);
        if (latestAttempt) ctx.onAction({ kind: "retry", attemptId: latestAttempt.attemptId });
      },
      onCancel: () => setConfirm(null),
    }),
    h(TypedConfirmDialog, {
      open: confirm === "stop",
      title: canResolveQuarantine ? "Resolve quarantined ownership" : "Stop run",
      body: canResolveQuarantine
        ? `Requests the reviewed ownership repair path for ${run.runId}. Global capacity is already free; the repository lease remains quarantined until a worker is confirmed stopped or the explicit sentinel timeout path is eligible.`
        : `Kills the running agent for ${run.runId}. Uncommitted work in the worktree may be lost.`,
      confirmPhrase: canResolveQuarantine ? "resolve" : "stop",
      confirmLabel: canResolveQuarantine ? "Resolve ownership" : "Stop run",
      busy: pending,
      onConfirm: () => {
        setConfirm(null);
        ctx.onAction({ kind: "stop" });
      },
      onCancel: () => setConfirm(null),
    }));
}
