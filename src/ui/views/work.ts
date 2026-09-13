import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProtocolSnapshot, ProviderStatus, QueueEntry } from "../../contracts.js";
import type { ViewContext } from "../context.js";
import {
  ProviderModelPicker,
  seedPickerValue,
  type PickerRouting,
  type PickerValue,
} from "../providerPicker.js";
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
const ROUTINE_SCOPE_APPROVAL = "routine implementation per plan; no merges, deploys, migrations, dependency changes, secrets, data deletion, or customer-facing changes";
const APPROVAL_GATED_ACTIONS = "merges, deploys, migrations, adding or upgrading dependencies, touching secrets, deleting data, customer-facing changes";

type WorkGroup = "needs-you" | "ready" | "blocked" | "running" | "draft" | "done";

const STATUS_TONE: Record<QueueEntry["status"]["kind"], Tone> = {
  ready: "success",
  "in-progress": "primary",
  done: "neutral",
  "blocked-by": "warning",
  draft: "neutral",
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

/**
 * Needs-you membership: auth reasons, open question gates, or a stale gate.
 * A stale-question-gate means the entry's `blocked-by` question resolved or
 * vanished while the status still names it; a human must re-triage the entry.
 */
function needsYou(entry: QueueEntry): boolean {
  return approvalMissing(entry) || entry.blockingQuestionIds.length > 0
    || entry.eligibilityReasons.includes("stale-question-gate");
}

/**
 * Partition: every entry lands in exactly one group. Terminal and active
 * statuses win first so done or running items never surface needs-you noise.
 */
function groupOf(entry: QueueEntry): WorkGroup {
  if (entry.status.kind === "done") return "done";
  if (entry.status.kind === "in-progress") return "running";
  if (entry.status.kind === "draft") return "draft";
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
function ApproveComposer(props: {
  entry: QueueEntry;
  ctx: ViewContext;
  providers: readonly ProviderStatus[];
  preferredProviderId: string | null;
}) {
  const { entry, ctx } = props;
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [selection, setSelection] = useState<PickerValue | null>(null);
  const pending = ctx.pendingTarget === `queued:${entry.id}`;
  const trimmed = text.trim();
  const draftSeed = seedPickerValue(props.providers, props.preferredProviderId);
  const canDraft = ProviderModelPicker !== undefined && draftSeed !== null;
  const pickerRouting: PickerRouting = ctx.environmentId
    ? { kind: "environment", environmentId: ctx.environmentId }
    : { kind: "host", hostId: ctx.repository.connectedHostId };
  return h("div", { className: "space-y-1.5" },
    h("div", { className: "space-y-1 text-xs text-muted-foreground" },
      h("p", null, `Risk: ${entry.risk}. Approval is required before this item can run.`),
      h("p", null, `Approval lists what the factory may do beyond routine work: ${APPROVAL_GATED_ACTIONS}. Anything unlisted stays off-limits.`)),
    h("textarea", {
      value: text,
      rows: 2,
      disabled: pending,
      placeholder: `What the factory may do for ${entry.id}. Example: "routine work only" or "deploys allowed; no dependency changes".`,
      className: "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground",
      onChange: (event: { target: { value: string } }) => setText(event.target.value),
    }),
    h("div", { className: "flex flex-wrap items-center gap-2" },
      h(ActionButton, {
        label: "Draft with agent",
        variant: "ghost",
        disabled: pending || !canDraft,
        title: canDraft
          ? "Start a chat that recommends an approval scope"
          : "The provider catalog is unavailable, so no agent can be picked.",
        onClick: () => {
          setSelection(draftSeed);
          setDraftOpen(true);
        },
      }),
      h(ActionButton, {
        label: "Routine scope only",
        variant: "ghost",
        disabled: pending,
        onClick: () => {
          setText(ROUTINE_SCOPE_APPROVAL);
          setConfirming(true);
        },
      }),
      h(ActionButton, {
        label: "Approve",
        variant: "primary",
        size: "xs",
        disabled: trimmed.length === 0 || pending,
        busy: pending,
        onClick: () => setConfirming(true),
      })),
    h(ConfirmDialog, {
      open: draftOpen,
      title: `Draft approval with an agent for ${entry.id}`,
      body: h(
        "div",
        { className: "space-y-3" },
        h(
          "p",
          null,
          "Starts a chat in this repository's environment that recommends an approved: line. Advisory only: it cannot edit the repository.",
        ),
        ProviderModelPicker !== undefined && selection !== null
          ? h(ProviderModelPicker, {
              value: selection,
              onChange: (next: PickerValue) => setSelection(next),
              routing: pickerRouting,
              disabled: pending,
            })
          : null,
      ),
      confirmLabel: "Start chat",
      busy: pending,
      onConfirm: () => {
        const picked = selection;
        setDraftOpen(false);
        if (picked) {
          ctx.onAction({
            kind: "recommend-approval",
            queueItemId: entry.id,
            providerId: picked.providerId,
            model: picked.model,
            reasoningLevel: picked.reasoningLevel,
            ...(picked.serviceTier === undefined ? {} : { serviceTier: picked.serviceTier }),
          });
        }
      },
      onCancel: () => setDraftOpen(false),
    }),
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
function WorkRowDetail(props: {
  entry: QueueEntry;
  group: WorkGroup;
  ctx: ViewContext;
  providers: readonly ProviderStatus[];
  preferredProviderId: string | null;
}) {
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
      : approvalMissing(entry) && entry.blockingQuestionIds.length === 0
        ? h("div", null,
            h(DetailLabel, { text: "Approval" }),
            h("div", { className: "mt-1" }, h(ApproveComposer, {
              entry,
              ctx,
              providers: props.providers,
              preferredProviderId: props.preferredProviderId,
            })))
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
function WorkRow(props: {
  entry: QueueEntry;
  group: WorkGroup;
  ctx: ViewContext;
  defaultExpanded: boolean;
  providers: readonly ProviderStatus[];
  preferredProviderId: string | null;
}) {
  const { entry, group, ctx } = props;
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  const pending = ctx.pendingTarget === `queued:${entry.id}`;
  const openQids = entry.blockingQuestionIds;
  const approvalNeeded = approvalMissing(entry);

  // A ready item gated by open questions is question-blocked in reality:
  // render the blocked-by warning treatment, not a misleading "Ready" badge.
  const displayStatus = entry.status.kind === "ready" && openQids.length > 0
    ? { kind: "blocked-by" as const, questionId: openQids[0] }
    : entry.status;

  // Open questions gate first: the action layer rejects approval while any
  // blocking question is unanswered, so Approve is offered only once clear.
  // A stale gate still needs human re-triage, so it keeps a Review CTA that
  // jumps to the referenced question rather than stranding the row in Blocked.
  const staleGateId = entry.status.kind === "blocked-by"
    && entry.eligibilityReasons.includes("stale-question-gate")
    ? entry.status.questionId
    : null;
  const cta = openQids.length > 0
    ? h(ActionButton, {
        label: `Answer ${openQids[0]}`,
        variant: "ghost",
        size: "xs",
        onClick: () => ctx.onOpenSection("questions", `question-${openQids[0]}`),
      })
    : staleGateId
      ? h(ActionButton, {
          label: `Review ${staleGateId}`,
          variant: "ghost",
          size: "xs",
          onClick: () => ctx.onOpenSection("questions", `question-${staleGateId}`),
        })
    : approvalNeeded
      ? h(ActionButton, {
          label: "Approve",
          variant: "primary",
          size: "xs",
          disabled: pending,
          onClick: () => setExpanded(true),
        })
      : null;

  const statusDetail = "detail" in displayStatus ? displayStatus.detail : undefined;
  const statusDetailId = `work-${entry.id}-status-detail`;

  return h("div", { id: `work-${entry.id}`, className: "py-2" },
    h("div", { className: "flex items-end gap-2 sm:items-center" },
      h("div", {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        "aria-describedby": statusDetail ? statusDetailId : undefined,
        className: "flex min-w-0 flex-1 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-1 py-1 hover:bg-state-hover sm:flex-nowrap sm:items-center",
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        },
      },
        h(Badge, { label: queueStatusLabel(displayStatus), tone: STATUS_TONE[displayStatus.kind] }),
        h("code", { className: "shrink-0 font-mono text-xs text-muted-foreground" }, entry.id),
        h("span", {
          className: "order-last min-w-0 basis-full truncate text-sm text-foreground sm:order-none sm:basis-auto",
        }, entry.title),
        h("span", { className: "shrink-0 text-xs text-muted-foreground" }, `P${entry.priority}`),
        entry.risk !== "low"
          ? h(Badge, { label: entry.risk, tone: RISK_TONE[entry.risk], title: `${entry.risk} risk` })
          : null),
      cta),
    statusDetail
      ? h("p", { id: statusDetailId, className: "mt-0.5 px-1 text-xs text-muted-foreground" }, statusDetail)
      : null,
    expanded ? h(WorkRowDetail, {
      entry,
      group,
      ctx,
      providers: props.providers,
      preferredProviderId: props.preferredProviderId,
    }) : null);
}

export function WorkView(props: {
  snapshot: ProtocolSnapshot;
  ctx: ViewContext;
  focusItemId?: string | null;
  providers?: readonly ProviderStatus[];
  preferredProviderId?: string | null;
}): ReactNode {
  const { snapshot, ctx, focusItemId } = props;
  const providers = props.providers ?? [];
  const preferredProviderId = props.preferredProviderId ?? null;

  const groups = useMemo(() => {
    const buckets: Record<WorkGroup, QueueEntry[]> = {
      "needs-you": [],
      ready: [],
      blocked: [],
      running: [],
      draft: [],
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
    { key: "draft", title: "Drafts", defaultOpen: focusedEntry !== null && groupOf(focusedEntry) === "draft" },
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
                providers,
                preferredProviderId,
              })),
          })));
}
