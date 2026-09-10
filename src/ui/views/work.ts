import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProtocolSnapshot, QueueEntry } from "../../contracts.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  EmptyNotice,
  FeedbackNotice,
  FilePath,
  Section,
  formatEligibilityReason,
  linkifyPaths,
  queueStatusLabel,
  repositoryFileTarget,
  type Tone,
} from "../primitives.js";

const h = createElement;

const QUEUE_PATH = "plans/factory/queue.md";
const LIST_CLAMP = 6;
const NOTE_LINE_CLAMP = 6;
const NOTE_CHAR_CLAMP = 320;

type WorkGroup = "needs-you" | "ready" | "blocked" | "running" | "done";

const STATUS_TONE: Record<QueueEntry["status"]["kind"], Tone> = {
  ready: "success",
  "in-progress": "primary",
  done: "neutral",
  "blocked-by": "warning",
  unknown: "danger",
};

const RISK_TONE = { medium: "warning", high: "danger" } as const;

/** The protocol flags these reasons when a human approved line is required. */
function approvalMissing(entry: QueueEntry): boolean {
  return entry.eligibilityReasons.some(
    (reason) => reason === "missing-authorization" || reason === "high-risk-approval-missing",
  );
}

/** Every question id gating this item, from whichever field the parser filled. */
function gatingQuestionIds(entry: QueueEntry): string[] {
  const ids = new Set<string>([...entry.blockingQuestionIds, ...entry.blockedBy]);
  if (entry.status.kind === "blocked-by") ids.add(entry.status.questionId);
  return [...ids];
}

/** Needs-you membership follows the spec literally: auth reasons or blockingQuestionIds. */
function needsYou(entry: QueueEntry): boolean {
  return approvalMissing(entry) || entry.blockingQuestionIds.length > 0;
}

/**
 * Partition: every entry lands in exactly one group. Terminal and active
 * statuses win first so done or running items never surface needs-you noise.
 */
function groupOf(entry: QueueEntry): WorkGroup {
  if (entry.status.kind === "done") return "done";
  if (entry.status.kind === "in-progress") return "running";
  if (needsYou(entry)) return "needs-you";
  if (entry.eligible) return "ready";
  return "blocked";
}

/** Mono list clamped to LIST_CLAMP rows with a show-all toggle. */
function ClampedList(props: { items: readonly string[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? props.items : props.items.slice(0, LIST_CLAMP);
  return h("div", null,
    h("ul", { className: "space-y-0.5" },
      visible.map((item, index) =>
        h("li", { key: index, className: "font-mono text-xs text-muted-foreground" }, item))),
    props.items.length > LIST_CLAMP
      ? h("button", {
          type: "button",
          className: "mt-1 text-xs text-primary hover:underline",
          onClick: () => setShowAll((value) => !value),
        }, showAll ? "Show less" : `Show all ${props.items.length}`)
      : null);
}

/** Notes clamped to six rendered lines with a show-all toggle. */
function NotesBlock(props: { notes: string }) {
  const [showAll, setShowAll] = useState(false);
  const long = props.notes.split("\n").length > NOTE_LINE_CLAMP || props.notes.length > NOTE_CHAR_CLAMP;
  return h("div", null,
    h("p", {
      className: `whitespace-pre-wrap break-words text-xs text-muted-foreground ${long && !showAll ? "line-clamp-6" : ""}`,
    }, props.notes),
    long
      ? h("button", {
          type: "button",
          className: "mt-0.5 text-xs text-primary hover:underline",
          onClick: () => setShowAll((value) => !value),
        }, showAll ? "Show less" : "Show all")
      : null);
}

/** depends_on token: in-repo ids open the work anchor, repo:ID hops repositories. */
function DependencyButton(props: { token: string; ctx: ViewContext }) {
  const { token, ctx } = props;
  return h("button", {
    type: "button",
    className: "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground hover:bg-state-hover",
    onClick: () => {
      const colon = token.indexOf(":");
      if (colon > 0) {
        ctx.onOpenRepository(token.slice(0, colon), "work", `work-${token.slice(colon + 1)}`);
      } else {
        ctx.onOpenSection("work", `work-${token}`);
      }
    },
  }, token);
}

/** Textarea plus confirm dialog that writes queue.approved to queue.md. */
function ApproveComposer(props: { entry: QueueEntry; ctx: ViewContext }) {
  const { entry, ctx } = props;
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const pending = ctx.pendingTarget === `queued:${entry.id}`;
  const trimmed = text.trim();
  return h("div", { className: "space-y-1.5" },
    h("textarea", {
      value: text,
      rows: 2,
      disabled: pending,
      placeholder: `Approved text recorded as queue.approved for ${entry.id}`,
      className: "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground",
      onChange: (event: { target: { value: string } }) => setText(event.target.value),
    }),
    h("div", null,
      h(ActionButton, {
        label: "Approve",
        variant: "primary",
        size: "xs",
        disabled: trimmed.length === 0 || pending,
        busy: pending,
        onClick: () => setConfirming(true),
      })),
    h(ConfirmDialog, {
      open: confirming,
      title: `Approve ${entry.id}`,
      body: `Writes queue.approved: '${trimmed}' to plans/factory/queue.md for ${entry.id}.`,
      confirmLabel: "Approve",
      busy: pending,
      onConfirm: () => {
        setConfirming(false);
        ctx.onAction({ kind: "approve-queue", queueItemId: entry.id, approvedText: trimmed });
      },
      onCancel: () => setConfirming(false),
    }));
}

function DetailLabel(props: { text: string }) {
  return h("p", { className: "text-xs font-medium text-muted-foreground" }, props.text);
}

/** Expanded row body: plan links, dependencies, question gates, approval, lists, notes. */
function WorkRowDetail(props: { entry: QueueEntry; group: WorkGroup; ctx: ViewContext }) {
  const { entry, group, ctx } = props;
  const status = entry.status;
  const qids = gatingQuestionIds(entry);
  const reasons = status.kind === "done" ? [] : entry.eligibilityReasons;

  return h("div", { className: "ml-1 mt-1 space-y-2 border-l-2 border-border pb-1 pl-3" },
    reasons.length > 0
      ? h("p", {
          className: group === "blocked"
            ? "text-sm font-medium text-warning"
            : "text-xs text-muted-foreground",
        }, reasons.map(formatEligibilityReason).join(" · "))
      : null,
    status.kind === "unknown"
      ? h("div", { className: "space-y-1" },
          h("p", { className: "text-xs text-warning" },
            "The protocol parser did not recognize this status; the item cannot be dispatched until it is fixed."),
          h("p", { className: "whitespace-pre-wrap font-mono text-xs text-muted-foreground" },
            `Raw status: ${status.raw}`),
          h("div", { className: "flex items-center gap-1.5 text-xs text-muted-foreground" },
            "Open",
            h(FilePath, {
              path: QUEUE_PATH,
              target: repositoryFileTarget(ctx.repository, ctx.environmentId, QUEUE_PATH),
              fileLink: ctx.fileLink,
            })))
      : null,
    h("div", { className: "text-xs" },
      h("span", { className: "text-muted-foreground" }, "Plan: "),
      h("span", { className: "break-words text-muted-foreground" },
        linkifyPaths(entry.planPath, (token, index) =>
          h(FilePath, {
            key: `plan-${index}`,
            path: token,
            target: repositoryFileTarget(ctx.repository, ctx.environmentId, token),
            fileLink: ctx.fileLink,
          })))),
    entry.dependsOn.length > 0
      ? h("div", { className: "flex flex-wrap items-center gap-1.5 text-xs" },
          h("span", { className: "text-muted-foreground" }, "Depends on:"),
          entry.dependsOn.map((token) => h(DependencyButton, { key: token, token, ctx })))
      : null,
    qids.length > 0
      ? h("div", { className: "flex flex-wrap items-center gap-1.5 text-xs" },
          h("span", { className: "text-muted-foreground" }, "Blocked by:"),
          qids.map((qid) =>
            h("button", {
              key: qid,
              type: "button",
              className: "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground hover:bg-state-hover",
              onClick: () => ctx.onOpenSection("questions", `question-${qid}`),
            }, qid)))
      : null,
    entry.approved.kind === "explicit"
      ? h("div", null,
          h(DetailLabel, { text: "Approved" }),
          h("blockquote", {
            className: "mt-0.5 border-l-2 border-success/50 pl-2 text-xs text-muted-foreground",
          }, entry.approved.text))
      : approvalMissing(entry)
        ? h("div", null,
            h(DetailLabel, { text: "Approval" }),
            h("div", { className: "mt-1" }, h(ApproveComposer, { entry, ctx })))
        : null,
    entry.acceptance.length > 0
      ? h("div", null, h(DetailLabel, { text: "Acceptance" }), h(ClampedList, { items: entry.acceptance }))
      : null,
    entry.validate.length > 0
      ? h("div", null, h(DetailLabel, { text: "Validate" }), h(ClampedList, { items: entry.validate }))
      : null,
    entry.notes
      ? h("div", null, h(DetailLabel, { text: "Notes" }), h(NotesBlock, { notes: entry.notes }))
      : null);
}

/** One queue row: collapsed summary line plus toggleable detail. */
function WorkRow(props: { entry: QueueEntry; group: WorkGroup; ctx: ViewContext; defaultExpanded: boolean }) {
  const { entry, group, ctx } = props;
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  const pending = ctx.pendingTarget === `queued:${entry.id}`;
  const qids = gatingQuestionIds(entry);
  const approvalNeeded = approvalMissing(entry);

  const cta = approvalNeeded
    ? h(ActionButton, {
        label: "Approve",
        variant: "primary",
        size: "xs",
        disabled: pending,
        onClick: () => setExpanded(true),
      })
    : qids.length > 0
      ? h(ActionButton, {
          label: `Answer ${qids[0]}`,
          variant: "ghost",
          size: "xs",
          onClick: () => ctx.onOpenSection("questions", `question-${qids[0]}`),
        })
      : null;

  return h("div", { id: `work-${entry.id}`, className: "py-2" },
    h("div", { className: "flex items-center gap-2" },
      h("div", {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        className: "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-state-hover",
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        },
      },
        h(Badge, { label: queueStatusLabel(entry.status), tone: STATUS_TONE[entry.status.kind] }),
        h("code", { className: "shrink-0 font-mono text-xs text-muted-foreground" }, entry.id),
        h("span", { className: "min-w-0 truncate text-sm text-foreground" }, entry.title),
        h("span", { className: "shrink-0 text-xs text-muted-foreground" }, `P${entry.priority}`),
        entry.risk !== "low" ? h(Badge, { label: `${entry.risk} risk`, tone: RISK_TONE[entry.risk] }) : null),
      cta),
    expanded ? h(WorkRowDetail, { entry, group, ctx }) : null);
}

export function WorkView(props: {
  snapshot: ProtocolSnapshot;
  ctx: ViewContext;
  focusItemId?: string | null;
}): ReactNode {
  const { snapshot, ctx, focusItemId } = props;

  const groups = useMemo(() => {
    const buckets: Record<WorkGroup, QueueEntry[]> = {
      "needs-you": [],
      ready: [],
      blocked: [],
      running: [],
      done: [],
    };
    for (const entry of snapshot.queue) buckets[groupOf(entry)].push(entry);
    return buckets;
  }, [snapshot.queue]);

  const focusedEntry = focusItemId
    ? snapshot.queue.find((entry) => entry.id === focusItemId) ?? null
    : null;

  useEffect(() => {
    if (!focusItemId || typeof document === "undefined") return;
    document.getElementById(`work-${focusItemId}`)?.scrollIntoView?.({ block: "start" });
  }, [focusItemId]);

  const sections: Array<{ key: WorkGroup; title: string; defaultOpen: boolean }> = [
    { key: "needs-you", title: "Needs you", defaultOpen: true },
    { key: "ready", title: "Ready", defaultOpen: true },
    { key: "blocked", title: "Blocked", defaultOpen: true },
    { key: "running", title: "Running", defaultOpen: true },
    { key: "done", title: "Done", defaultOpen: focusedEntry !== null && groupOf(focusedEntry) === "done" },
  ];

  return h("div", { className: "space-y-4" },
    h(FeedbackNotice, { feedback: ctx.feedback }),
    snapshot.queue.length === 0
      ? h(EmptyNotice, {
          title: "The queue is empty",
          detail: "Items appear here when plans/factory/queue.md defines them.",
          action: h(FilePath, {
            path: QUEUE_PATH,
            target: repositoryFileTarget(ctx.repository, ctx.environmentId, QUEUE_PATH),
            fileLink: ctx.fileLink,
          }),
        })
      : sections.map((section) =>
          h(Section, {
            key: section.key,
            title: section.title,
            count: groups[section.key].length,
            collapsible: true,
            defaultOpen: section.defaultOpen,
            children: groups[section.key].map((entry) =>
              h(WorkRow, {
                key: entry.id,
                entry,
                group: section.key,
                ctx,
                defaultExpanded: entry.id === focusItemId,
              })),
          })));
}
