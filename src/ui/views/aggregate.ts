import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  HealthProjection,
  OperationalRunListProjection,
  OperationalRunSummary,
  PendingInteraction,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  Question,
  RepositorySelection,
  SettingsProjection,
} from "../../contracts.js";
import { computeAttention, type AttentionItem } from "../attention.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  Disclosure,
  EmptyNotice,
  ErrorNotice,
  FeedbackNotice,
  LoadingNotice,
  Section,
  StatusDot,
  formatDuration,
  formatTimestamp,
  isActiveRunStatus,
  repositoryFileTarget,
  runStatusLabel,
  runStatusTone,
  sectionStorageKey,
  timeAgo,
  usePhoneViewport,
  useRevealOnFocus,
  type Tone,
} from "../primitives.js";
import {
  AnsweredQuestionRow,
  filterQuestions,
  PendingInteractionRow,
  QuestionFilterControls,
  questionGates,
  RepositoryQuestionCard,
  revealQuestion,
  type KindFilter,
  type StateFilter,
} from "./questions.js";
import { pickerRoutingFor } from "../providerPicker.js";
import { bucketRuns, RunGroupSection, RUN_GROUPS, useRunsNow } from "./runs.js";
import { bucketWorkEntries, WorkGroupSection, WORK_GROUPS } from "./work.js";
import { nextCronTimes } from "../../schedule/cron.js";
import { describeSchedule } from "../../schedule/describe.js";
import { repositoryLabel } from "../../repository-label.js";

const h = createElement;
const AGGREGATE_REPOSITORY_KEY = "@aggregate";

function entryLabel(entry: RepositorySelection): string {
  return repositoryLabel(entry.configuration.repositoryKey, entry.displayName);
}

export type Loadable<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

/** The five per-repository read projections an aggregate group renders from. */
export interface RepositoryBundle {
  readonly snapshot: Loadable<ProtocolSnapshot>;
  readonly settings: Loadable<SettingsProjection>;
  readonly health: Loadable<HealthProjection>;
  readonly interactions: Loadable<PendingInteractionsProjection>;
  readonly runs: Loadable<OperationalRunListProjection>;
}

export function idleBundle(): RepositoryBundle {
  const idle = { status: "idle" as const };
  return { snapshot: idle, settings: idle, health: idle, interactions: idle, runs: idle };
}

/** One repository's slice of an aggregate tab, with a context pinned to that repository. */
export interface AggregateGroup {
  readonly entry: RepositorySelection;
  readonly bundle: RepositoryBundle;
  readonly ctx: ViewContext;
}

export type AggregateSection = "work" | "questions" | "runs";

/** Aggregate anchors travel as "<repositoryKey>/<inner anchor>". */
export function splitAggregateAnchor(anchor: string | null): { repositoryKey: string | null; inner: string | null } {
  if (!anchor) return { repositoryKey: null, inner: null };
  const slash = anchor.indexOf("/");
  if (slash <= 0) return { repositoryKey: null, inner: anchor };
  return { repositoryKey: anchor.slice(0, slash), inner: anchor.slice(slash + 1) };
}

function preferredProvider(bundle: RepositoryBundle): string | null {
  const preference = bundle.settings.status === "ready" ? bundle.settings.data.settings.providerPreference : null;
  return preference && preference !== "alternate" ? preference : null;
}

function RepositoryStatusGroup(props: {
  group: AggregateGroup;
  tab: AggregateSection;
  section: string;
  children: ReactNode;
}): ReactNode {
  return h(Section, {
    title: entryLabel(props.group.entry),
    collapsible: true,
    defaultOpen: true,
    storageKey: sectionStorageKey(props.group.entry.configuration.repositoryKey, props.tab, props.section),
    children: props.children,
  });
}

function groupFeedback(groups: readonly AggregateGroup[]): ReactNode[] {
  return groups
    .filter((group) => group.ctx.feedback !== null)
    .map((group) => h(FeedbackNotice, {
      key: `${group.entry.configuration.repositoryKey}:feedback`,
      feedback: group.ctx.feedback,
    }));
}

type OverviewState = {
  readonly group: AggregateGroup;
  readonly snapshot: ProtocolSnapshot | null;
  readonly settings: SettingsProjection | null;
  readonly health: HealthProjection | null;
  readonly interactions: PendingInteractionsProjection | null;
  readonly runs: OperationalRunListProjection | null;
  readonly attention: readonly AttentionItem[];
};

function overviewState(group: AggregateGroup): OverviewState {
  const { bundle } = group;
  const snapshot = bundle.snapshot.status === "ready" ? bundle.snapshot.data : null;
  const settings = bundle.settings.status === "ready" ? bundle.settings.data : null;
  const health = bundle.health.status === "ready" ? bundle.health.data : null;
  const interactions = bundle.interactions.status === "ready" ? bundle.interactions.data : null;
  const runs = bundle.runs.status === "ready" ? bundle.runs.data : null;
  return {
    group,
    snapshot,
    settings,
    health,
    interactions,
    runs,
    attention: computeAttention({
      snapshot,
      snapshotError: bundle.snapshot.status === "error",
      settings,
      health,
      runs,
      interactions,
    }),
  };
}

function resourcePending<T>(resource: Loadable<T>): boolean {
  return resource.status === "idle" || resource.status === "loading";
}

function resourceError<T>(resource: Loadable<T>): string | null {
  return resource.status === "error" ? resource.error : null;
}

function resourceLoadingNotice<T>(resource: Loadable<T>, label: string): ReactNode | null {
  return resourcePending(resource) ? h(LoadingNotice, { label }) : null;
}

function resourceErrorNotice<T>(resource: Loadable<T>, label: string, onRetry: () => void): ReactNode | null {
  const error = resourceError(resource);
  return error ? h(ErrorNotice, { message: `${label} failed to load (${error}).`, onRetry }) : null;
}

function overviewRepositorySection(props: {
  key?: string;
  state: OverviewState;
  title?: string;
  count?: number;
  defaultOpen: boolean;
  section: string;
  actions?: ReactNode;
  collapsible?: boolean;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const repositoryKey = props.state.group.entry.configuration.repositoryKey;
  return h(Section, {
    key: props.key,
    title: props.title ?? entryLabel(props.state.group.entry),
    count: props.count,
    collapsible: props.collapsible ?? true,
    defaultOpen: props.defaultOpen,
    storageKey: sectionStorageKey(repositoryKey, "overview", props.section),
    titleClassName: "text-sm font-normal text-foreground",
    actions: props.actions,
    testId: props.testId,
    children: props.children,
  });
}

interface OverviewAttentionAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly pendingTarget?: string;
}

function overviewAttentionAction(item: AttentionItem, ctx: ViewContext): OverviewAttentionAction | null {
  switch (item.id) {
    case "blocking-questions":
    case "assumption-questions":
    case "pending-interactions":
      return { label: "Answer", onClick: () => ctx.onOpenSection("questions") };
    case "approvals":
    case "gated-items":
    case "stale-question-gates":
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

function OverviewAttentionRow(props: { item: AttentionItem; ctx: ViewContext }): ReactNode {
  const { item, ctx } = props;
  const tone: Tone = item.severity === "action" ? "warning" : item.severity === "warning" ? "danger" : "neutral";
  const action = overviewAttentionAction(item, ctx);
  const mutating = action?.pendingTarget !== undefined;
  return h("div", {
    className: "flex min-w-0 flex-wrap items-start gap-3 py-2 sm:flex-nowrap",
    "data-attention-id": item.id,
  },
    h("span", { className: "mt-1.5 flex shrink-0" }, h(StatusDot, { tone })),
    h("div", { className: "min-w-0 flex-1" },
      h(Disclosure, {
        summary: h("span", { className: "text-sm font-normal text-foreground" }, item.title),
        children: h("p", { className: "break-words text-xs text-muted-foreground" }, item.detail),
      })),
    action
      ? h("div", { className: "ml-auto flex h-5 items-center justify-end" },
          h(ActionButton, {
            label: action.label,
            variant: "ghost",
            size: "xs",
            onClick: action.onClick,
            disabled: mutating && ctx.pendingTarget !== null,
            busy: mutating && ctx.pendingTarget === action.pendingTarget,
          }))
      : null);
}

function AggregateOverviewAttention(props: { states: readonly OverviewState[]; phone: boolean; onRetry: () => void }): ReactNode {
  const total = props.states.reduce((count, state) => count + state.attention.length, 0);
  const repositorySections = props.states.flatMap((state) => {
    const count = state.attention.length;
    const status = [
      resourceLoadingNotice(state.group.bundle.snapshot, "Loading repository state"),
      resourceErrorNotice(state.group.bundle.snapshot, "Repository state", props.onRetry),
      resourceLoadingNotice(state.group.bundle.settings, "Loading dispatch state"),
      resourceErrorNotice(state.group.bundle.settings, "Settings", props.onRetry),
      resourceLoadingNotice(state.group.bundle.health, "Loading repository health"),
      resourceErrorNotice(state.group.bundle.health, "Health", props.onRetry),
      resourceLoadingNotice(state.group.bundle.interactions, "Loading BB questions"),
      resourceErrorNotice(state.group.bundle.interactions, "BB questions", props.onRetry),
      resourceLoadingNotice(state.group.bundle.runs, "Loading repository last run"),
      resourceErrorNotice(state.group.bundle.runs, "Runs", props.onRetry),
    ];
    const unresolved = status.some((item) => item !== null);
    if (count === 0 && !unresolved) return [];
    return [overviewRepositorySection({
      key: state.group.entry.configuration.repositoryKey,
      state,
      count: count > 0 ? count : undefined,
      defaultOpen: unresolved || !props.phone,
      section: "needs-attention",
      children: [
        ...status,
        ...state.attention.map((item) => h(OverviewAttentionRow, {
          key: item.id,
          item,
          ctx: state.group.ctx,
        })),
      ],
    })];
  });
  return h(Section, {
    title: "Needs attention",
    count: total,
    collapsible: true,
    defaultOpen: true,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "needs-attention"),
    children: [
      ...repositorySections,
      total === 0 && repositorySections.length === 0
        ? h("div", { key: "empty", className: "flex flex-wrap items-center gap-2 px-1 py-2" },
            h(StatusDot, { tone: "success" }),
            h("span", { className: "text-sm font-medium text-success" }, "Nothing needs you."))
        : null,
    ],
  });
}

const OVERVIEW_WORK_TONE: Record<string, Tone> = {
  "needs-you": "warning",
  ready: "success",
  blocked: "warning",
  running: "primary",
  draft: "neutral",
  done: "neutral",
};

function OverviewWorkSummary(props: { state: OverviewState; phone: boolean }): ReactNode {
  const { state } = props;
  const queue = state.snapshot?.queue ?? [];
  const buckets = bucketWorkEntries(queue);
  const groups = WORK_GROUPS.filter((section) => buckets[section.key].length > 0);
  const chips = h("div", { className: "flex min-w-0 flex-wrap items-center gap-2" },
    groups.map((section) => h(Badge, {
      key: section.key,
      label: `${buckets[section.key].length} ${section.title}`,
      tone: OVERVIEW_WORK_TONE[section.key] ?? "neutral",
    })),
    h(ActionButton, {
      label: "Open work",
      variant: "ghost",
      size: "xs",
      onClick: () => state.group.ctx.onOpenSection("work"),
    }));
  return overviewRepositorySection({
    state,
    count: queue.length,
    defaultOpen: !props.phone,
    collapsible: props.phone,
    section: "work-queue",
    actions: props.phone ? undefined : chips,
    children: props.phone ? h("div", { className: "px-1 py-2" }, chips) : null,
  });
}

function AggregateOverviewWork(props: { states: readonly OverviewState[]; phone: boolean; onRetry: () => void }): ReactNode {
  const readyStates = props.states.filter((state) => state.snapshot !== null);
  const total = readyStates.reduce((count, state) => count + (state.snapshot?.queue.length ?? 0), 0);
  const unresolved = props.states.filter((state) => state.snapshot === null);
  return h(Section, {
    title: "Work queue",
    count: total,
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "work-queue"),
    children: [
      ...readyStates.flatMap((state) => (state.snapshot?.queue.length ?? 0) === 0 ? [] : [
        h(OverviewWorkSummary, {
          key: state.group.entry.configuration.repositoryKey,
          state,
          phone: props.phone,
        }),
      ]),
      ...unresolved.map((state) => overviewRepositorySection({
        key: state.group.entry.configuration.repositoryKey,
        state,
        defaultOpen: true,
        section: "work-queue",
        children: [
          resourceLoadingNotice(state.group.bundle.snapshot, "Loading repository work"),
          resourceErrorNotice(state.group.bundle.snapshot, "Work queue", props.onRetry),
        ],
      })),
      total === 0 && unresolved.length === 0
        ? h("p", { key: "empty", className: "px-1 py-2 text-sm text-muted-foreground" }, "No work across configured repositories.")
        : null,
    ],
  });
}

function OverviewQuestionRow(props: { question: Question; ctx: ViewContext }): ReactNode {
  const { question, ctx } = props;
  return h("div", {
    id: `${ctx.idPrefix ?? ""}question-${question.id}`,
    className: "flex min-w-0 items-start gap-3 px-1 py-2",
  },
    h("div", { className: "min-w-0 flex-1" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("span", { className: "font-mono text-xs text-muted-foreground" }, question.id),
        h(Badge, {
          label: question.classification,
          tone: question.classification === "blocking" ? "warning" : "neutral",
        })),
      h("p", { className: "mt-1 line-clamp-2 break-words text-sm text-foreground" }, question.question)),
    h(ActionButton, {
      label: "Open",
      ariaLabel: `Open question ${question.id}`,
      variant: "ghost",
      size: "xs",
      onClick: () => ctx.onOpenSection("questions", `question-${question.id}`),
    }));
}

function OverviewInteractionRow(props: { interaction: PendingInteraction; ctx: ViewContext }): ReactNode {
  const { interaction, ctx } = props;
  return h("div", {
    id: `${ctx.idPrefix ?? ""}interaction-${interaction.interactionId}`,
    className: "flex min-w-0 items-start gap-3 px-1 py-2",
  },
    h("div", { className: "min-w-0 flex-1" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("span", { className: "text-sm font-medium text-foreground" }, interaction.title),
        h(Badge, { label: interaction.kind === "approval" ? "Approval" : interaction.kind === "user-question" ? "Question" : "Plugin", tone: "primary" })),
      interaction.prompt ? h("p", { className: "mt-1 line-clamp-2 break-words text-xs text-muted-foreground" }, interaction.prompt) : null),
    h(ActionButton, {
      label: "Open",
      ariaLabel: `Open interaction ${interaction.interactionId}`,
      variant: "ghost",
      size: "xs",
      onClick: () => ctx.onOpenSection("questions", `interaction-${interaction.interactionId}`),
    }));
}

function overviewQuestionCount(state: OverviewState): number {
  return (state.snapshot?.questions.filter((question) => question.answer === null).length ?? 0)
    + (state.interactions?.interactions.length ?? 0);
}

function OverviewQuestionsRows({ state }: { state: OverviewState }): ReactNode {
  const questions = state.snapshot?.questions.filter((question) => question.answer === null) ?? [];
  const interactions = state.interactions?.interactions ?? [];
  return [
    ...questions.map((question) => h(OverviewQuestionRow, { key: `question:${question.id}`, question, ctx: state.group.ctx })),
    ...interactions.map((interaction) => h(OverviewInteractionRow, { key: `interaction:${interaction.interactionId}`, interaction, ctx: state.group.ctx })),
  ];
}

function revealInteraction(id: string, idPrefix?: string): boolean {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(`${idPrefix ?? ""}interaction-${id}`);
  if (!element) return false;
  let node = element.parentElement;
  while (node) {
    if (node instanceof HTMLDetailsElement) node.open = true;
    node = node.parentElement;
  }
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest" });
  }
  return true;
}

function AggregateOverviewQuestions(props: { states: readonly OverviewState[]; phone: boolean; onRetry: () => void }): ReactNode {
  const total = props.states.reduce((count, state) => count + overviewQuestionCount(state), 0);
  const repositorySections = props.states.flatMap((state) => {
    const count = overviewQuestionCount(state);
    const status = [
      resourceLoadingNotice(state.group.bundle.snapshot, "Loading repository questions"),
      resourceErrorNotice(state.group.bundle.snapshot, "Questions", props.onRetry),
      resourceLoadingNotice(state.group.bundle.interactions, "Loading BB questions"),
      resourceErrorNotice(state.group.bundle.interactions, "BB questions", props.onRetry),
    ];
    const unresolved = status.some((item) => item !== null);
    if (count === 0 && !unresolved) return [];
    return [overviewRepositorySection({
      key: state.group.entry.configuration.repositoryKey,
      state,
      count: count > 0 ? count : undefined,
      defaultOpen: unresolved || !props.phone,
      section: "questions",
      children: [
        ...status,
        count > 0 ? h(OverviewQuestionsRows, { state }) : null,
      ],
    })];
  });
  return h(Section, {
    title: "Questions",
    count: total,
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "questions"),
    children: [
      ...repositorySections,
      total === 0 && repositorySections.length === 0
        ? h("p", { key: "empty", className: "px-1 py-2 text-sm text-muted-foreground" }, "No questions across configured repositories.")
        : null,
    ],
  });
}

function activeRunFor(state: OverviewState): OperationalRunSummary | null {
  return state.runs?.runs.find((run) => isActiveRunStatus(run.status)) ?? null;
}

function OverviewCurrentRunRow(props: { state: OverviewState; run: OperationalRunSummary }): ReactNode {
  const { state, run } = props;
  const now = useRunsNow();
  const elapsed = formatDuration(run.startedAt ?? run.requestedAt, null, now);
  return h("div", { className: "flex min-w-0 flex-wrap items-center gap-2 px-1 py-2" },
    h(StatusDot, { tone: "primary", pulse: true }),
    h(Badge, { label: runStatusLabel(run.status), tone: runStatusTone(run.status) }),
    elapsed ? h("span", { className: "text-sm tabular-nums text-foreground" }, elapsed) : null,
    run.providerId ? h("span", { className: "text-xs text-muted-foreground" }, `on ${run.providerId}`) : null,
    h("span", { className: "text-xs text-muted-foreground" }, `${run.queueItemIds.length} task${run.queueItemIds.length === 1 ? "" : "s"}`),
    run.workerThreadId
      ? h(ActionButton, { label: "Thread", variant: "ghost", size: "xs", onClick: () => state.group.ctx.onOpenThread(run.workerThreadId!) })
      : null,
    h(ActionButton, { label: "View", ariaLabel: `View run ${run.runId}`, variant: "ghost", size: "xs", onClick: () => state.group.ctx.onOpenRun(run.runId) }));
}

function AggregateOverviewCurrentRun(props: { states: readonly OverviewState[]; phone: boolean }): ReactNode | null {
  const active = props.states.flatMap((state) => {
    const run = activeRunFor(state);
    return run ? [{ state, run }] : [];
  });
  if (active.length === 0) return null;
  return h(Section, {
    title: "Current run",
    count: active.length,
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "current-run"),
    children: active.map(({ state, run }) => overviewRepositorySection({
      key: state.group.entry.configuration.repositoryKey,
      state,
      count: 1,
      defaultOpen: !props.phone,
      section: "current-run",
      children: h(OverviewCurrentRunRow, { state, run }),
    })),
  });
}

function lastFinishedRun(runs: OperationalRunListProjection | null): OperationalRunSummary | null {
  return runs?.runs
    .filter((run) => run.finishedAt !== null)
    .sort((left, right) => new Date(right.finishedAt ?? 0).getTime() - new Date(left.finishedAt ?? 0).getTime())[0] ?? null;
}

function humanizeOverviewSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} sec`);
  return parts.join(" ");
}

function OverviewLastRunRow(props: { state: OverviewState }): ReactNode {
  const last = lastFinishedRun(props.state.runs);
  const ctx = props.state.group.ctx;
  if (!last) {
    return h("div", { className: "px-1 py-2 text-xs text-muted-foreground" }, "No finished runs on record.");
  }
  const duration = formatDuration(last.startedAt ?? last.requestedAt, last.finishedAt);
  return h("div", { className: "flex min-w-0 flex-wrap items-center gap-2 px-1 py-2 text-sm" },
    h("span", { className: "text-foreground" }, timeAgo(last.finishedAt) ?? formatTimestamp(last.finishedAt) ?? ""),
    h(Badge, { label: runStatusLabel(last.status), tone: runStatusTone(last.status) }),
    last.providerId ? h("span", { className: "text-xs text-muted-foreground" }, last.providerId) : null,
    duration ? h("span", { className: "text-xs tabular-nums text-muted-foreground" }, duration) : null,
    h(ActionButton, { label: "View", ariaLabel: `View run ${last.runId}`, variant: "ghost", size: "xs", onClick: () => ctx.onOpenRun(last.runId) }));
}

function AggregateOverviewLastRun(props: { states: readonly OverviewState[]; phone: boolean; onRetry: () => void }): ReactNode {
  return h(Section, {
    title: "Last run",
    count: props.states.length,
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "last-run"),
    children: props.states.map((state) => state.runs !== null
      ? overviewRepositorySection({
          key: state.group.entry.configuration.repositoryKey,
          state,
          count: 1,
          defaultOpen: !props.phone,
          section: "last-run",
          children: h(OverviewLastRunRow, { state }),
        })
      : overviewRepositorySection({
          key: `${state.group.entry.configuration.repositoryKey}:last-run-status`,
          state,
          defaultOpen: true,
          section: "last-run",
          children: [
            resourceLoadingNotice(state.group.bundle.runs, "Loading repository last run"),
            resourceErrorNotice(state.group.bundle.runs, "Runs", props.onRetry),
          ],
        })),
  });
}

function preferredHealth(state: OverviewState) {
  const preference = state.settings?.settings.providerPreference;
  return preference && preference !== "alternate"
    ? state.health?.providers.find((provider) => provider.providerId === preference) ?? null
    : null;
}

function healthSummary(state: OverviewState): { tone: Tone; text: string } {
  if (!state.health) return { tone: "neutral", text: "Health unavailable" };
  const provider = preferredHealth(state);
  const providerOk = !state.settings?.settings.providerPreference
    || state.settings.settings.providerPreference === "alternate"
    || provider?.availability === "available";
  if (state.health.host.ok && providerOk) return { tone: "success", text: "Healthy" };
  const providerReason = provider && provider.availability !== "available"
    ? `${provider.providerId} ${provider.availability}${provider.lastError ? `: ${provider.lastError}` : ""}`
    : state.settings?.settings.providerPreference && state.settings.settings.providerPreference !== "alternate"
      ? `Preferred provider ${state.settings.settings.providerPreference} is not reported`
      : null;
  return {
    tone: "warning",
    text: `Degraded: ${state.health.host.reasons[0] ?? providerReason ?? `Host ${state.health.host.hostId} is ${state.health.host.status}`}`,
  };
}

function OverviewDispatchRow(props: { state: OverviewState }): ReactNode {
  const { state } = props;
  const settings = state.settings;
  if (!settings) {
    return h("div", { className: "px-1 py-2 text-sm text-muted-foreground" }, "Dispatch settings are unavailable.");
  }
  const dispatch = settings.dispatch;
  const repositoryPaused = state.group.ctx.dispatchPaused || dispatch.repositoryPaused;
  const mode: { label: string; tone: Tone } = dispatch.mode !== "enabled"
    ? { label: "Paused", tone: "warning" }
    : repositoryPaused
      ? { label: "Repo paused", tone: "warning" }
      : { label: "Enabled", tone: "success" };
  const cron = settings.settings.scheduleCron;
  const next = cron ? nextCronTimes(cron, settings.settings.timeZone, 1)[0] : null;
  const schedule = cron ? describeSchedule(cron) ?? "Schedule configured" : "No schedule set";
  const timeZone = settings.settings.timeZone;
  const preferredProvider = settings.settings.providerPreference;
  const provider = preferredHealth(state);
  const preferredProviderNotReported = state.health !== null
    && preferredProvider !== undefined
    && preferredProvider !== "alternate"
    && provider === null;
  return h("div", { className: "flex min-w-0 flex-wrap items-center gap-2 px-1 py-2" },
    h(Badge, { label: mode.label, tone: mode.tone }),
    h("span", { className: "text-xs text-muted-foreground" }, schedule),
    timeZone !== "server-local"
      ? h("span", { className: "text-xs text-muted-foreground" }, `(${timeZone})`)
      : null,
    next ? h("span", { className: "text-xs text-muted-foreground" }, `Next ${formatTimestamp(next.toISOString()) ?? "scheduled run"}`) : null,
    h("span", { className: "text-xs text-muted-foreground" }, `${dispatch.activeRunCount}/${settings.settings.concurrencyLimit} slots`),
    h("span", { className: "text-xs text-muted-foreground" }, `${dispatch.acceptingNewRuns ? "Accepting" : "Not accepting"} new runs`),
    h("span", { className: "text-xs text-muted-foreground" }, `Min gap ${humanizeOverviewSeconds(settings.settings.minimumStartGapSeconds)}`),
    dispatch.reason ? h("span", { className: "basis-full text-xs text-muted-foreground", title: dispatch.reason }, dispatch.reason) : null,
    preferredProvider
      ? h("span", { className: "inline-flex items-center gap-2" },
          h(Badge, {
            label: preferredProvider,
            tone: provider ? (provider.availability === "available" ? "success" : "warning") : "neutral",
            ...(provider?.lastError ? { title: provider.lastError } : {}),
          }),
          preferredProviderNotReported
            ? h("span", { className: "text-xs text-muted-foreground" }, "not reported")
            : null)
      : null,
    h(ActionButton, { label: "Edit", variant: "ghost", size: "xs", onClick: () => state.group.ctx.onOpenSection("settings") }),
    state.health && healthSummary(state).tone !== "success"
      ? h("span", { className: "basis-full text-xs text-warning" }, healthSummary(state).text)
      : null);
}

function AggregateOverviewDispatch(props: { states: readonly OverviewState[]; phone: boolean; onRetry: () => void }): ReactNode {
  return h(Section, {
    title: "Dispatch",
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "dispatch"),
    children: props.states.map((state) => {
      const settingsError = resourceError(state.group.bundle.settings);
      const settingsPending = resourcePending(state.group.bundle.settings);
      return overviewRepositorySection({
        key: state.group.entry.configuration.repositoryKey,
        state,
        defaultOpen: !props.phone,
        section: "dispatch",
        children: [
          resourceLoadingNotice(state.group.bundle.settings, "Loading dispatch state"),
          resourceLoadingNotice(state.group.bundle.health, "Loading repository health"),
          resourceErrorNotice(state.group.bundle.settings, "Settings", props.onRetry),
          resourceErrorNotice(state.group.bundle.health, "Health", props.onRetry),
          !settingsPending && !settingsError ? h(OverviewDispatchRow, { state }) : null,
        ],
      });
    }),
  });
}

function repositoryNeedsDetail(state: OverviewState): boolean {
  if (resourceError(state.group.bundle.snapshot) || resourceError(state.group.bundle.health)) return true;
  if (state.snapshot?.dashboard.safeFastForward === false) return true;
  return state.health !== null && healthSummary(state).tone !== "success";
}

function OverviewFileLink(props: { ctx: ViewContext; label: string; path: string | null }): ReactNode | null {
  const fileLink = props.ctx.fileLink;
  if (!props.path || !fileLink) return null;
  const target = repositoryFileTarget(props.ctx.repository, props.ctx.environmentId, props.path);
  if (!target) return null;
  return h(fileLink, {
    target,
    className: "inline-flex items-center rounded px-1.5 py-1 text-xs font-medium text-primary hover:bg-state-hover hover:underline",
  }, props.label);
}

function OverviewRepositoryDetails({ state }: { state: OverviewState }): ReactNode {
  const snapshot = state.snapshot;
  const ctx = state.group.ctx;
  if (!snapshot) {
    return h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, "Repository details are unavailable.");
  }
  const dashboard = snapshot.dashboard;
  const branch = state.health?.host.branch ?? snapshot.repository.factoryBranch;
  const summary = healthSummary(state);
  return h("div", { className: "space-y-2 px-1 py-2" },
    h("div", { className: "flex flex-wrap items-center gap-2 text-sm" },
      h(Badge, { label: branch, tone: "neutral", title: "Checked-out branch" }),
      h("span", { className: "text-xs text-muted-foreground" }, `${dashboard.factoryAhead} ahead, ${dashboard.mainBehind} behind ${dashboard.mainRef}`),
      h(Badge, {
        label: dashboard.safeFastForward ? "fast-forward safe" : "not fast-forward safe",
        tone: dashboard.safeFastForward ? "success" : "warning",
      }),
      snapshot.revision.gitCommit
        ? h("code", { className: "font-mono text-xs text-muted-foreground" }, `@${snapshot.revision.gitCommit.slice(0, 7)}`)
        : h("span", { className: "text-xs text-muted-foreground" }, "uncommitted")),
    state.health && summary.tone !== "success"
      ? h("p", { className: "text-xs text-warning" }, summary.text)
      : null,
    snapshot.dashboard.taskCommits.length > 0
      ? h(Disclosure, {
          summary: `${snapshot.dashboard.taskCommits.length} task commit${snapshot.dashboard.taskCommits.length === 1 ? "" : "s"}`,
          children: h("ul", { className: "space-y-1" }, snapshot.dashboard.taskCommits.map((entry) =>
            h("li", { key: entry.sha, className: "flex items-baseline gap-2 text-xs" },
              h("code", { className: "shrink-0 font-mono text-muted-foreground" }, entry.sha.slice(0, 7)),
              h("span", { className: "min-w-0 break-words" }, entry.subject)))),
        })
      : null,
    h("div", { className: "flex flex-wrap gap-1" },
      h(OverviewFileLink, { ctx, label: "Open current state", path: snapshot.currentRun.currentPath }),
      h(OverviewFileLink, { ctx, label: "Open foreman", path: snapshot.foremanTemplate.relativePath }),
      h(OverviewFileLink, { ctx, label: "Open latest run report", path: snapshot.currentRun.latestRunPath }),
      h(OverviewFileLink, { ctx, label: "Open dashboard", path: snapshot.dashboard.canonicalPath })),
  );
}

function AggregateOverviewRepositoryDetails(props: { states: readonly OverviewState[]; phone: boolean }): ReactNode | null {
  const detailed = props.states.filter(repositoryNeedsDetail);
  if (detailed.length === 0) return null;
  return h(Section, {
    title: "Repository",
    collapsible: true,
    defaultOpen: !props.phone,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "overview", "repository"),
    children: detailed.map((state) => overviewRepositorySection({
      key: state.group.entry.configuration.repositoryKey,
      state,
      defaultOpen: !props.phone,
      section: "repository",
      children: h(OverviewRepositoryDetails, { state }),
    })),
  });
}

export function AggregateOverviewView(props: {
  groups: readonly AggregateGroup[];
  onRetry: () => void;
}): ReactNode {
  const phone = usePhoneViewport();
  if (props.groups.length === 0) {
    return h(EmptyNotice, {
      title: "No repositories configured",
      detail: "Add a repository registry entry to start dispatching factory runs.",
    });
  }
  const states = props.groups.map(overviewState);
  return h("div", { className: "space-y-4" },
    ...groupFeedback(props.groups),
    h(AggregateOverviewAttention, { states, phone, onRetry: props.onRetry }),
    h(AggregateOverviewWork, { states, phone, onRetry: props.onRetry }),
    h(AggregateOverviewQuestions, { states, phone, onRetry: props.onRetry }),
    h(AggregateOverviewCurrentRun, { states, phone }),
    h(AggregateOverviewLastRun, { states, phone, onRetry: props.onRetry }),
    h(AggregateOverviewDispatch, { states, phone, onRetry: props.onRetry }),
    h(AggregateOverviewRepositoryDetails, { states, phone }));
}

function AggregateWorkView(props: {
  groups: readonly AggregateGroup[];
  anchor: string | null;
  onRetry: () => void;
}): ReactNode {
  const phone = usePhoneViewport();
  const focus = splitAggregateAnchor(props.anchor);
  const focusItemId = focus.inner?.replace(/^work-/u, "") ?? null;
  const buckets = useMemo(() => props.groups.map((group) => ({
    group,
    entries: group.bundle.snapshot.status === "ready"
      ? bucketWorkEntries(group.bundle.snapshot.data.queue)
      : null,
  })), [props.groups]);
  const totalEntries = buckets.reduce((total, item) =>
    total + (item.entries ? Object.values(item.entries).reduce((count, entries) => count + entries.length, 0) : 0), 0);
  const unresolved = buckets.filter((item) => item.entries === null);
  const allSnapshotsSettled = unresolved.length === 0;

  if (allSnapshotsSettled && totalEntries === 0) {
    return h("div", { className: "space-y-4" },
      ...groupFeedback(props.groups),
      h(EmptyNotice, {
        title: "No work across configured repositories",
        detail: "Items appear here when a repository's plans/factory/queue.md defines them.",
      }));
  }

  return h("div", { className: "space-y-4" },
    ...groupFeedback(props.groups),
    WORK_GROUPS.map((section) => {
      const total = buckets.reduce((count, item) => count + (item.entries?.[section.key].length ?? 0), 0);
      const unresolvedForStatus = section.key === "needs-you" ? unresolved : [];
      if (total === 0 && unresolvedForStatus.length === 0) return null;
      const focusedGroup = buckets.find((item) =>
        (focus.repositoryKey === null || item.group.entry.configuration.repositoryKey === focus.repositoryKey)
        && item.entries?.[section.key].some((entry) => entry.id === focusItemId));
      return h(Section, {
        key: section.key,
        title: section.title,
        count: total,
        collapsible: true,
        defaultOpen: section.defaultOpen && (!phone || section.key === "needs-you"),
        forceOpen: focusedGroup ? focusItemId : false,
        storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "work", section.key),
        children: [
          ...buckets.flatMap((item) => {
            const entries = item.entries?.[section.key] ?? [];
            if (entries.length === 0) return [];
            return [h(WorkGroupSection, {
              key: item.group.entry.configuration.repositoryKey,
              group: section.key,
              title: entryLabel(item.group.entry),
              entries,
              ctx: item.group.ctx,
              focusItemId: (focus.repositoryKey === null || focus.repositoryKey === item.group.entry.configuration.repositoryKey)
                && entries.some((entry) => entry.id === focusItemId)
                ? focusItemId
                : null,
              providers: item.group.bundle.health.status === "ready" ? item.group.bundle.health.data.providers : [],
              preferredProviderId: preferredProvider(item.group.bundle),
              defaultOpen: section.defaultOpen && (!phone || section.key === "needs-you"),
              storageKey: sectionStorageKey(item.group.entry.configuration.repositoryKey, "work", section.key),
              showEmpty: false,
            })];
          }),
          ...unresolvedForStatus.map((item) => h(RepositoryStatusGroup, {
            key: item.group.entry.configuration.repositoryKey,
            group: item.group,
            tab: "work",
            section: section.key,
            children: item.group.bundle.snapshot.status === "error"
              ? h(ErrorNotice, { message: item.group.bundle.snapshot.error, onRetry: props.onRetry })
              : h(LoadingNotice, { label: "Loading repository work" }),
          })),
          total === 0 && unresolvedForStatus.length === 0
            ? h("p", { key: "empty", className: "px-1 py-2 text-sm text-muted-foreground" }, "Nothing in this category")
            : null,
        ],
      });
    }));
}

interface QuestionBucket {
  readonly group: AggregateGroup;
  readonly open: Question[];
  readonly answered: Question[];
}

interface LocalQuestionAnswers {
  readonly digest: string;
  readonly ids: ReadonlySet<string>;
}

function questionDigest(group: AggregateGroup): string {
  return group.ctx.revision?.fileDigests["plans/factory/questions.md"] ?? "";
}

function AggregateQuestionsView(props: {
  groups: readonly AggregateGroup[];
  anchor: string | null;
  onRetry: () => void;
}): ReactNode {
  const phone = usePhoneViewport();
  const focus = splitAggregateAnchor(props.anchor);
  const focusInteractionId = focus.inner?.startsWith("interaction-")
    ? focus.inner.slice("interaction-".length)
    : null;
  const focusQuestionId = focusInteractionId === null
    ? focus.inner?.replace(/^question-/u, "") ?? null
    : null;
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [locallyAnswered, setLocallyAnswered] = useState<Record<string, LocalQuestionAnswers>>({});
  const questionDigests = props.groups
    .map((group) => `${group.entry.configuration.repositoryKey}:${questionDigest(group)}`)
    .join("|");
  const questionDigestByRepository = useMemo(
    () => new Map(props.groups.map((group) => [group.entry.configuration.repositoryKey, questionDigest(group)])),
    [questionDigests],
  );
  useEffect(() => {
    setLocallyAnswered((current) => {
      const next: Record<string, LocalQuestionAnswers> = {};
      let changed = Object.keys(current).length !== questionDigestByRepository.size;
      for (const [repositoryKey, digest] of questionDigestByRepository) {
        const previous = current[repositoryKey];
        if (previous?.digest === digest) {
          next[repositoryKey] = previous;
        } else {
          next[repositoryKey] = { digest, ids: new Set<string>() };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [questionDigestByRepository]);

  const buckets = useMemo<QuestionBucket[]>(() => props.groups.flatMap((group) => {
    if (group.bundle.snapshot.status !== "ready") return [];
    const repositoryKey = group.entry.configuration.repositoryKey;
    const answeredForRepository = locallyAnswered[repositoryKey]?.ids ?? new Set<string>();
    const filtered = filterQuestions(group.bundle.snapshot.data.questions, query, kindFilter, stateFilter, answeredForRepository);
    return [{
      group,
      open: filtered
        .filter((question) => question.answer === null && !answeredForRepository.has(question.id))
        .sort((left, right) =>
          (left.classification === "blocking" ? 0 : 1) - (right.classification === "blocking" ? 0 : 1)),
      answered: filtered.filter((question) => question.answer !== null || answeredForRepository.has(question.id)),
    }];
  }), [props.groups, query, kindFilter, stateFilter, locallyAnswered]);

  const pendingCount = props.groups.reduce((count, group) =>
    count + (group.bundle.interactions.status === "ready" ? group.bundle.interactions.data.interactions.length : 0), 0);
  const pendingUnresolved = props.groups.filter((group) =>
    group.bundle.interactions.status === "loading" || group.bundle.interactions.status === "idle" || group.bundle.interactions.status === "error");
  const snapshotUnresolved = props.groups.filter((group) => group.bundle.snapshot.status !== "ready");
  const totalOpen = buckets.reduce((count, bucket) => count + bucket.open.length, 0);
  const totalAnswered = buckets.reduce((count, bucket) => count + bucket.answered.length, 0);
  const filtersActive = query.trim() !== "" || kindFilter !== "all" || stateFilter !== "all";
  const allQuestionsSettled = pendingUnresolved.length === 0 && snapshotUnresolved.length === 0;
  const focusedInteractionGroups = props.groups.filter((group) =>
    focusInteractionId !== null
    && (focus.repositoryKey === null || group.entry.configuration.repositoryKey === focus.repositoryKey)
    && group.bundle.interactions.status === "ready"
    && group.bundle.interactions.data.interactions.some((interaction) => interaction.interactionId === focusInteractionId));
  const interactionFocusToken = focusInteractionId
    ? focus.repositoryKey === null ? focusInteractionId : `${focus.repositoryKey}:${focusInteractionId}`
    : false;

  useRevealOnFocus(
    focusQuestionId
      ? `${focus.repositoryKey ?? "all"}:question:${focusQuestionId}@${questionDigests}`
      : focusInteractionId
        ? `${focus.repositoryKey ?? "all"}:interaction:${focusInteractionId}@${questionDigests}`
        : null,
    () => {
      if (focusInteractionId) {
        return focusedInteractionGroups
          .map((group) => revealInteraction(focusInteractionId, group.ctx.idPrefix))
          .some(Boolean);
      }
      if (!focusQuestionId) return false;
      const matching = props.groups.filter((group) =>
        focus.repositoryKey === null || group.entry.configuration.repositoryKey === focus.repositoryKey);
      return matching.map((group) => revealQuestion(focusQuestionId, group.ctx.idPrefix)).some(Boolean);
    },
  );

  const markAnswered = (repositoryKey: string, questionId: string) => {
    setLocallyAnswered((current) => {
      const previous = current[repositoryKey] ?? {
        digest: questionDigestByRepository.get(repositoryKey) ?? "",
        ids: new Set<string>(),
      };
      const next = new Set(previous.ids);
      next.add(questionId);
      return { ...current, [repositoryKey]: { ...previous, ids: next } };
    });
  };
  const filters = h(QuestionFilterControls, {
    query,
    kindFilter,
    stateFilter,
    onQueryChange: setQuery,
    onKindChange: setKindFilter,
    onStateChange: setStateFilter,
  });

  const renderOpenQuestion = (bucket: QuestionBucket, question: Question) => {
    const group = bucket.group;
    const ctx = group.ctx;
    const snapshot = group.bundle.snapshot.status === "ready" ? group.bundle.snapshot.data : null;
    return h(RepositoryQuestionCard, {
      key: question.id,
      question,
      gates: snapshot ? questionGates(snapshot, question.id) : [],
      pending: ctx.pendingTarget === `question:${question.id}`,
      providers: group.bundle.health.status === "ready" ? group.bundle.health.data.providers : [],
      preferredProviderId: preferredProvider(group.bundle),
      pickerRouting: pickerRoutingFor(ctx),
      onRecord: (questionId, answer) => {
        ctx.onAction({ kind: "answer-question", source: "repository-question", questionId, answer });
        markAnswered(group.entry.configuration.repositoryKey, questionId);
      },
      onRecommend: (questionId, selection) => {
        ctx.onAction({
          kind: "recommend-question",
          questionId,
          providerId: selection.providerId,
          model: selection.model,
          reasoningLevel: selection.reasoningLevel,
          ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }),
        });
      },
      onOpenGated: (queueItemId) => ctx.onOpenSection("work", `work-${queueItemId}`),
      idPrefix: ctx.idPrefix,
    });
  };

  const renderAnsweredQuestion = (bucket: QuestionBucket, question: Question) => h(AnsweredQuestionRow, {
    key: question.id,
    question,
    recorded: question.answer === null,
    idPrefix: bucket.group.ctx.idPrefix,
  });

  if (allQuestionsSettled && pendingCount === 0 && totalOpen === 0 && totalAnswered === 0) {
    return h("div", { className: "space-y-4" },
      ...groupFeedback(props.groups),
      filters,
      h(EmptyNotice, {
        title: "No questions",
        detail: filtersActive
          ? "No repository questions match the current filters."
          : "No configured repository has parsed questions.",
      }));
  }

  const focusBuckets = buckets.filter((bucket) =>
    (focus.repositoryKey === null || bucket.group.entry.configuration.repositoryKey === focus.repositoryKey)
    && (bucket.open.some((question) => question.id === focusQuestionId) || bucket.answered.some((question) => question.id === focusQuestionId)));
  const focusedOpen = focusBuckets.some((bucket) => bucket.open.some((question) => question.id === focusQuestionId));
  const focusedAnswered = focusBuckets.some((bucket) => bucket.answered.some((question) => question.id === focusQuestionId));
  const questionFocusToken = focusQuestionId
    ? focus.repositoryKey === null ? focusQuestionId : `${focus.repositoryKey}:${focusQuestionId}`
    : false;
  const openSection = h(Section, {
    title: "Open",
    count: totalOpen,
    collapsible: true,
    defaultOpen: true,
    forceOpen: focusedOpen ? questionFocusToken : false,
    storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "questions", "open"),
    children: [
      ...buckets.flatMap((bucket) => bucket.open.length === 0 ? [] : [h(Section, {
        key: bucket.group.entry.configuration.repositoryKey,
        title: entryLabel(bucket.group.entry),
        count: bucket.open.length,
        collapsible: true,
        defaultOpen: !phone,
        forceOpen: focusedOpen && focusBuckets.includes(bucket) && focusQuestionId ? focusQuestionId : false,
        storageKey: sectionStorageKey(bucket.group.entry.configuration.repositoryKey, "questions", "open"),
        children: h("div", { className: "space-y-3 py-1" }, bucket.open.map((question) => renderOpenQuestion(bucket, question))),
      })]),
      totalOpen === 0 && snapshotUnresolved.length === 0
        ? h("p", { key: "empty-open", className: "px-1 py-2 text-sm text-muted-foreground" }, "No open questions.")
        : null,
      ...snapshotUnresolved.map((group) => h(RepositoryStatusGroup, {
        key: `${group.entry.configuration.repositoryKey}:open-status`,
        group,
        tab: "questions",
        section: "open",
        children: group.bundle.snapshot.status === "error"
          ? h(ErrorNotice, { message: group.bundle.snapshot.error, onRetry: props.onRetry })
          : h(LoadingNotice, { label: "Loading questions" }),
      })),
    ],
  });
  const answeredSection = totalAnswered > 0
    ? h(Section, {
        title: "Answered",
        count: totalAnswered,
        collapsible: true,
        defaultOpen: false,
        forceOpen: focusedAnswered ? questionFocusToken : stateFilter === "answered",
        storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "questions", "answered"),
        testId: "answered-questions",
        children: buckets.flatMap((bucket) => bucket.answered.length === 0 ? [] : [h(Section, {
          key: bucket.group.entry.configuration.repositoryKey,
          title: entryLabel(bucket.group.entry),
          count: bucket.answered.length,
          collapsible: true,
          defaultOpen: !phone,
          forceOpen: focusedAnswered && focusBuckets.includes(bucket) && focusQuestionId ? focusQuestionId : false,
          storageKey: sectionStorageKey(bucket.group.entry.configuration.repositoryKey, "questions", "answered"),
          children: bucket.answered.map((question) => renderAnsweredQuestion(bucket, question)),
        })]),
      })
    : null;
  const bbSection = pendingCount > 0 || pendingUnresolved.length > 0
    ? h(Section, {
        title: "BB questions",
        count: pendingCount,
        collapsible: true,
        defaultOpen: !phone,
        forceOpen: focusedInteractionGroups.length > 0 ? interactionFocusToken : false,
        storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "questions", "bb-questions"),
        children: props.groups.flatMap<ReactNode>((group) => {
          if (group.bundle.interactions.status === "ready" && group.bundle.interactions.data.interactions.length > 0) {
            return [h(Section, {
              key: group.entry.configuration.repositoryKey,
              title: entryLabel(group.entry),
              count: group.bundle.interactions.data.interactions.length,
              collapsible: true,
              defaultOpen: !phone,
              forceOpen: focusedInteractionGroups.includes(group) ? interactionFocusToken : false,
              storageKey: sectionStorageKey(group.entry.configuration.repositoryKey, "questions", "bb-questions"),
              children: group.bundle.interactions.data.interactions.map((interaction) =>
                h(PendingInteractionRow, { key: interaction.interactionId, interaction, ctx: group.ctx })),
            })];
          }
          if (group.bundle.interactions.status === "loading" || group.bundle.interactions.status === "idle" || group.bundle.interactions.status === "error") {
            return [h(RepositoryStatusGroup, {
              key: `${group.entry.configuration.repositoryKey}:bb-status`,
              group,
              tab: "questions",
              section: "bb-questions",
              children: group.bundle.interactions.status === "error"
                ? h(ErrorNotice, { message: group.bundle.interactions.error, onRetry: props.onRetry })
                : h(LoadingNotice, { label: "Loading BB questions" }),
            })];
          }
          return [];
        }),
      })
    : null;

  return h("div", { className: "space-y-4" },
    ...groupFeedback(props.groups),
    filters,
    bbSection,
    openSection,
    answeredSection);
}

function AggregateRunsView(props: {
  groups: readonly AggregateGroup[];
  onRetry: () => void;
}): ReactNode {
  const phone = usePhoneViewport();
  const now = useRunsNow();
  const buckets = useMemo(() => props.groups.map((group) => ({
    group,
    runs: group.bundle.runs.status === "ready" ? bucketRuns(group.bundle.runs.data.runs) : null,
  })), [props.groups]);
  const totalRuns = buckets.reduce((total, item) => total + (item.runs ? item.runs.active.length + item.runs.history.length : 0), 0);
  const unresolved = buckets.filter((item) => item.runs === null);
  if (unresolved.length === 0 && totalRuns === 0) {
    return h("div", { className: "space-y-4" },
      ...groupFeedback(props.groups),
      h(EmptyNotice, {
        title: "No BB-tracked runs across configured repositories",
        detail: "Runs recorded directly by the protocol live in each repository's plans/factory/runs/ folder.",
      }));
  }
  const hasMore = buckets.some((item) => item.group.bundle.runs.status === "ready" && item.group.bundle.runs.data.nextCursor !== null);
  return h("div", { className: "space-y-4" },
    ...groupFeedback(props.groups),
    RUN_GROUPS.map((section) => {
      const total = buckets.reduce((count, item) => count + (item.runs?.[section.key].length ?? 0), 0);
      const unresolvedForStatus = section.key === "active" ? unresolved : [];
      if (total === 0 && unresolvedForStatus.length === 0) return null;
      return h(Section, {
        key: section.key,
        title: section.title,
        count: total,
        collapsible: true,
        defaultOpen: section.key === "active" || !phone,
        storageKey: sectionStorageKey(AGGREGATE_REPOSITORY_KEY, "runs", section.key),
        children: [
          ...buckets.flatMap((item) => {
            const runs = item.runs?.[section.key] ?? [];
            if (runs.length === 0) return [];
            return [h(RunGroupSection, {
              key: item.group.entry.configuration.repositoryKey,
              group: section.key,
              title: entryLabel(item.group.entry),
              runs,
              now,
              ctx: item.group.ctx,
              defaultOpen: section.key === "active" || !phone,
              storageKey: sectionStorageKey(item.group.entry.configuration.repositoryKey, "runs", section.key),
            })];
          }),
          ...unresolvedForStatus.map((item) => h(RepositoryStatusGroup, {
            key: item.group.entry.configuration.repositoryKey,
            group: item.group,
            tab: "runs",
            section: section.key,
            children: item.group.bundle.runs.status === "error"
              ? h(ErrorNotice, { message: item.group.bundle.runs.error, onRetry: props.onRetry })
              : h(LoadingNotice, { label: "Loading run history" }),
          })),
        ],
      });
    }),
    hasMore ? h("p", { className: "px-1 text-xs text-muted-foreground" }, "More runs exist beyond this page.") : null);
}

/** The aggregate tabs use shared per-repository rows, but place status categories before repository subgroups. */
export function AggregateSectionView(props: {
  section: AggregateSection;
  groups: readonly AggregateGroup[];
  anchor: string | null;
  onRetry: () => void;
}): ReactNode {
  if (props.groups.length === 0) {
    return h(EmptyNotice, {
      title: "No repositories configured",
      detail: "Add a repository registry entry to start dispatching factory runs.",
    });
  }
  if (props.section === "work") return h(AggregateWorkView, props);
  if (props.section === "questions") return h(AggregateQuestionsView, props);
  return h(AggregateRunsView, { groups: props.groups, onRetry: props.onRetry });
}
