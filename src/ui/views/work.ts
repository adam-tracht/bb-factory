import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProtocolSnapshot, ProviderStatus, QueueEntry } from "../../contracts.js";
import type { ViewContext } from "../context.js";
import {
  ProviderModelPicker,
  pickerRoutingFor,
  seedPickerValue,
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
  sectionStorageKey,
  timeAgo,
  usePhoneViewport,
  useRevealOnFocus,
  type Tone,
} from "../primitives.js";

const h = createElement;

const QUEUE_PATH = "plans/factory/queue.md";
// The queue projection is parsed from queue.md against questions.md and the
// repo policy, so all three digests identify a refresh that can regroup or
// remount a focused row.
const QUESTIONS_PATH = "plans/factory/questions.md";
const REPO_PATH = "plans/factory/repo.md";
const LIST_CLAMP = 6;
const NOTE_LINE_CLAMP = 6;
const NOTE_CHAR_CLAMP = 320;
const ROUTINE_SCOPE_APPROVAL = "routine implementation per plan; no merges, deploys, migrations, dependency changes, secrets, data deletion, or customer-facing changes";
const APPROVAL_GATED_ACTIONS = "merges, deploys, migrations, adding or upgrading dependencies, touching secrets, deleting data, customer-facing changes";

export type WorkGroup = "needs-you" | "ready" | "blocked" | "running" | "draft" | "done";

/** Muted line shown inside an expanded group that has no entries. */
export const EMPTY_GROUP_LINE: Record<WorkGroup, string> = {
  "needs-you": "Nothing needs you right now",
  ready: "Nothing ready right now",
  blocked: "Nothing blocked right now",
  running: "Nothing running right now",
  draft: "No drafts right now",
  done: "Nothing done yet",
};

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
export function groupOf(entry: QueueEntry): WorkGroup {
  if (entry.status.kind === "done") return "done";
  if (entry.status.kind === "in-progress") return "running";
  if (entry.status.kind === "draft") return "draft";
  if (needsYou(entry)) return "needs-you";
  if (entry.eligible) return "ready";
  return "blocked";
}

export const WORK_GROUPS: ReadonlyArray<{ key: WorkGroup; title: string; defaultOpen: boolean }> = [
  { key: "needs-you", title: "Needs you", defaultOpen: true },
  { key: "ready", title: "Ready", defaultOpen: true },
  { key: "blocked", title: "Blocked", defaultOpen: true },
  { key: "running", title: "Running", defaultOpen: true },
  { key: "draft", title: "Drafts", defaultOpen: true },
  { key: "done", title: "Done", defaultOpen: false },
];

export function bucketWorkEntries(entries: readonly QueueEntry[]): Record<WorkGroup, QueueEntry[]> {
  const buckets: Record<WorkGroup, QueueEntry[]> = {
    "needs-you": [],
    ready: [],
    blocked: [],
    running: [],
    draft: [],
    done: [],
  };
  for (const entry of entries) buckets[groupOf(entry)].push(entry);
  return buckets;
}

// Supported provenance ids are prefix-shaped: run_/thr_/wfr_ plus letters or
// digits (contract ids need no digit: thr_live, run_abc are real). Words like
// "run_detail" share the prefix but are protocol terms, so they are excluded
// literally rather than guessed away by shape.
const DONE_ID_PATTERN = /\b(?:run|thr|wfr)_[A-Za-z0-9_-]+\b/g;
const DONE_ID_EXCLUSIONS: ReadonlySet<string> = new Set(["run_detail"]);
const DONE_DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/;
const DONE_VIA_PATTERN = /\b(run|thread)\b/;
const DONE_SESSION_PATTERN = /\borchestrated session\b/;

// Date.parse rolls impossible fields forward (2026-02-30 lands in March), so
// matched components are range-checked and round-tripped before the
// timestamp is trusted; bad dates stay in the leftover text untouched.
function validDoneDate(match: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/.exec(match);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) return false;
  return m[4] === undefined
    || (Number(m[4]) <= 23 && Number(m[5]) <= 59 && (m[6] === undefined || Number(m[6]) <= 59));
}

/**
 * Done provenance: one format for the free-text done detail. A run, thread,
 * or workflow id comes back in `id` and renders as a mono chip; an ISO date
 * or timestamp inside the detail supplies the relative time and nothing else
 * does. Unparsed leftover words stay on the line after a colon.
 */
export function doneProvenance(detail: string | undefined, now: number): { text: string; id: string | null } {
  if (!detail || detail.trim().length === 0) return { text: "Done", id: null };
  let rest = detail;
  const id = [...rest.matchAll(DONE_ID_PATTERN)]
    .map((match) => match[0])
    .find((token) => !DONE_ID_EXCLUSIONS.has(token)) ?? null;
  if (id) rest = rest.replace(new RegExp(`\\b${id}\\b`), " ");
  const dateMatch = DONE_DATE_PATTERN.exec(rest);
  const parsed = dateMatch && validDoneDate(dateMatch[1]) ? Date.parse(dateMatch[1]) : NaN;
  const relative = Number.isNaN(parsed) ? null : timeAgo(new Date(parsed).toISOString(), now);
  if (relative !== null && dateMatch) rest = rest.replace(dateMatch[0], " ");
  // "done (orchestrated session <date>)" is the queue's shorthand for a run:
  // the phrase is the via marker, consumed so it does not repeat as leftover.
  const viaSession = DONE_SESSION_PATTERN.test(rest);
  if (viaSession) rest = rest.replace(DONE_SESSION_PATTERN, " ");
  const viaWord = DONE_VIA_PATTERN.exec(rest)?.[1] ?? null;
  if (viaWord) rest = rest.replace(new RegExp(`\\b${viaWord}\\b`), " ");
  const via = id
    ? id.startsWith("thr_") ? "thread" : "run"
    : viaWord ?? (viaSession ? "run" : null);
  const leftover = rest
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean)
    .join(" ");
  let text = "Done";
  if (relative) text += ` ${relative}`;
  if (via) text += ` via ${via}`;
  if (leftover) text += `: ${leftover}`;
  return { text, id };
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
  const pickerRouting = pickerRoutingFor(ctx);
  return h("div", { className: "space-y-1.5" },
    h("div", { className: "space-y-1 text-xs text-muted-foreground" },
      h("p", null, `Risk: ${entry.risk}. Approval is required before this item can run.`),
      h("p", null, `Approval lists what the factory may do beyond routine work: ${APPROVAL_GATED_ACTIONS}. Anything unlisted stays off-limits.`)),
    h("textarea", {
      value: text,
      rows: 2,
      disabled: pending,
      placeholder: `What the factory may do for ${entry.id}. Example: "routine work only" or "deploys allowed; no dependency changes".`,
      className: "w-full box-border rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground",
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
  // defaultExpanded seeds mount state only; a deep link refocusing an
  // already-mounted collapsed row arrives as a false -> true prop change, so
  // open on the transition. The user can still collapse the row afterwards.
  const defaultExpandedRef = useRef(props.defaultExpanded);
  useEffect(() => {
    if (props.defaultExpanded && !defaultExpandedRef.current) setExpanded(true);
    defaultExpandedRef.current = props.defaultExpanded;
  }, [props.defaultExpanded]);
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

  // A ready-status entry that is not eligible is blocked in reality wherever
  // the row lands (the Blocked group, or Needs you awaiting approval): the
  // chip must say so, and the status detail line carries the first reason.
  // Question-gated ready rows already render the blocked-by display status.
  const blockedReady = displayStatus.kind === "ready" && !entry.eligible;

  const provenance = entry.status.kind === "done"
    ? doneProvenance(entry.status.detail, Date.now())
    : null;
  const statusDetail = provenance
    ? provenance.text
    : blockedReady && entry.eligibilityReasons.length > 0
      ? formatEligibilityReason(entry.eligibilityReasons[0])
      : "detail" in displayStatus
        ? displayStatus.detail
        : undefined;
  const idPrefix = ctx.idPrefix ?? "";
  const statusDetailId = `${idPrefix}work-${entry.id}-status-detail`;

  return h("div", { id: `${idPrefix}work-${entry.id}`, className: "min-w-0 py-2" },
    h("div", { className: "flex min-w-0 flex-wrap items-end gap-2 sm:flex-nowrap sm:items-center" },
      h("div", {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        "aria-describedby": statusDetail ? statusDetailId : undefined,
        className: "flex min-w-0 flex-1 box-border cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-1 py-1 hover:bg-state-hover sm:flex-nowrap sm:items-center",
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        },
      },
        blockedReady
          ? h(Badge, { label: "Blocked", tone: "warning" })
          : h(Badge, { label: queueStatusLabel(displayStatus), tone: STATUS_TONE[displayStatus.kind] }),
        h("code", { className: "shrink-0 font-mono text-xs text-muted-foreground" }, entry.id),
        h("span", {
          className: "order-last min-w-0 basis-full line-clamp-2 break-words text-sm text-foreground sm:order-none sm:basis-auto sm:line-clamp-1",
        }, entry.title),
        h("span", { className: "shrink-0 text-xs text-muted-foreground" }, `P${entry.priority}`),
        entry.risk !== "low"
          ? h(Badge, { label: entry.risk, tone: RISK_TONE[entry.risk], title: `${entry.risk} risk` })
          : null),
      cta
        ? h("div", { className: "flex basis-full justify-end sm:basis-auto" }, cta)
        : null),
    statusDetail
      ? h("p", { id: statusDetailId, className: "mt-0.5 px-1 text-xs text-muted-foreground" },
          statusDetail,
          provenance?.id ? " " : null,
          provenance?.id
            ? h("span", {
                className: "break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground",
              }, provenance.id)
            : null)
      : null,
    expanded ? h(WorkRowDetail, {
      entry,
      group,
      ctx,
      providers: props.providers,
      preferredProviderId: props.preferredProviderId,
    }) : null);
}

export function WorkGroupRows(props: {
  group: WorkGroup;
  entries: readonly QueueEntry[];
  ctx: ViewContext;
  focusItemId?: string | null;
  providers?: readonly ProviderStatus[];
  preferredProviderId?: string | null;
  showEmpty?: boolean;
}): ReactNode {
  if (props.entries.length === 0) {
    return props.showEmpty === false
      ? null
      : h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, EMPTY_GROUP_LINE[props.group]);
  }
  return props.entries.map((entry) =>
    h(WorkRow, {
      key: entry.id,
      entry,
      group: props.group,
      ctx: props.ctx,
      defaultExpanded: entry.id === props.focusItemId,
      providers: props.providers ?? [],
      preferredProviderId: props.preferredProviderId ?? null,
    }));
}

export function WorkGroupSection(props: {
  group: WorkGroup;
  title?: string;
  entries: readonly QueueEntry[];
  ctx: ViewContext;
  focusItemId?: string | null;
  providers?: readonly ProviderStatus[];
  preferredProviderId?: string | null;
  defaultOpen?: boolean;
  storageKey?: string;
  showEmpty?: boolean;
}): ReactNode {
  const phone = usePhoneViewport();
  const focusItemId = props.focusItemId ?? null;
  const focusedGroup = props.entries.some((entry) => entry.id === focusItemId);
  const focusElementId = focusItemId ? `${props.ctx.idPrefix ?? ""}work-${focusItemId}` : null;
  const workSourceDigest = [QUEUE_PATH, QUESTIONS_PATH, REPO_PATH]
    .map((path) => props.ctx.revision?.fileDigests[path] ?? "")
    .join("|");
  useRevealOnFocus(focusElementId ? `${focusElementId}@${workSourceDigest}` : null, () => {
    const element = focusElementId ? document.getElementById(focusElementId) : null;
    if (!element) return false;
    element.scrollIntoView?.({ block: "start" });
    return true;
  });
  return h(Section, {
    title: props.title ?? WORK_GROUPS.find((section) => section.key === props.group)?.title ?? props.group,
    count: props.entries.length,
    collapsible: true,
    defaultOpen: props.defaultOpen ?? (props.group === "needs-you" || (props.group !== "done" && !phone)),
    forceOpen: focusedGroup ? focusElementId : false,
    storageKey: props.storageKey ?? sectionStorageKey(props.ctx.repository.repositoryKey, "work", props.group),
    children: h(WorkGroupRows, props),
  });
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
  const groups = useMemo(() => bucketWorkEntries(snapshot.queue), [snapshot.queue]);
  const focusedSection = WORK_GROUPS.find((section) => groups[section.key].some((entry) => entry.id === focusItemId))?.key
    ?? WORK_GROUPS[0]!.key;

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
      : WORK_GROUPS.map((section) =>
          h(WorkGroupSection, {
            key: section.key,
            group: section.key,
            title: section.title,
            entries: groups[section.key],
            ctx,
            focusItemId: section.key === focusedSection ? focusItemId : null,
            providers,
            preferredProviderId,
          })),
  );
}
