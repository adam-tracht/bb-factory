import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  HealthProjection,
  OperationalRunListProjection,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  Question,
  RepositorySelection,
  SettingsProjection,
} from "../../contracts.js";
import { computeAttention } from "../attention.js";
import type { ViewContext } from "../context.js";
import {
  EmptyNotice,
  ErrorNotice,
  FeedbackNotice,
  LoadingNotice,
  Section,
  isActiveRunStatus,
  sectionStorageKey,
  usePhoneViewport,
  useRevealOnFocus,
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
import { bucketRuns, RunGroupSection, RUN_GROUPS, useRunsNow } from "./runs.js";
import { OverviewView } from "./overview.js";
import { bucketWorkEntries, WorkGroupSection, WORK_GROUPS } from "./work.js";

const h = createElement;

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
    title: props.group.entry.configuration.repositoryKey,
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

function AggregateOverviewRepository(props: {
  group: AggregateGroup;
  phone: boolean;
  onRetry: () => void;
}): ReactNode {
  const { group, phone, onRetry } = props;
  const { bundle, ctx } = group;
  const snapshot = bundle.snapshot.status === "ready" ? bundle.snapshot.data : null;
  const settings = bundle.settings.status === "ready" ? bundle.settings.data : null;
  const health = bundle.health.status === "ready" ? bundle.health.data : null;
  const runs = bundle.runs.status === "ready" ? bundle.runs.data : null;
  const interactions = bundle.interactions.status === "ready" ? bundle.interactions.data : null;
  const settled = [bundle.snapshot, bundle.settings, bundle.health, bundle.runs, bundle.interactions]
    .some((resource) => resource.status === "ready" || resource.status === "error");
  const loading = [bundle.snapshot, bundle.settings, bundle.health, bundle.runs, bundle.interactions]
    .some((resource) => resource.status === "idle" || resource.status === "loading");
  const errors = [
    ["Settings", bundle.settings],
    ["Health", bundle.health],
    ["Runs", bundle.runs],
    ["BB questions", bundle.interactions],
  ] as const;
  const activeRun = runs?.runs.find((run) => isActiveRunStatus(run.status)) ?? null;
  const attention = computeAttention({
    snapshot,
    snapshotError: bundle.snapshot.status === "error",
    settings,
    health,
    runs,
    interactions,
  });

  return h(Section, {
    title: group.entry.configuration.repositoryKey,
    collapsible: true,
    defaultOpen: !phone,
    storageKey: sectionStorageKey(group.entry.configuration.repositoryKey, "overview", "aggregate"),
    testId: `aggregate-overview-${group.entry.configuration.repositoryKey}`,
    children: [
      group.ctx.feedback ? h(FeedbackNotice, { key: "feedback", feedback: group.ctx.feedback }) : null,
      !settled
        ? h(LoadingNotice, { key: "initial-loading", label: "Loading repository overview" })
        : null,
      loading
        ? h(LoadingNotice, { key: "partial-loading", label: "Loading remaining repository state" })
        : null,
      ...errors.flatMap(([label, resource]) => resource.status === "error"
        ? [h(ErrorNotice, { key: `${label}-error`, message: `${label} failed to load (${resource.error}).`, onRetry })]
        : []),
      settled
        ? h(OverviewView, {
            key: "overview",
            snapshot,
            snapshotError: bundle.snapshot.status === "error" ? bundle.snapshot.error : null,
            settings,
            health,
            runs,
            attention,
            activeRun,
            ctx,
          })
        : null,
    ],
  });
}

/** Aggregate overview reuses the repository overview internals per scoped group. */
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
  return h("div", { className: "space-y-4" },
    props.groups.map((group) => h(AggregateOverviewRepository, {
      key: group.entry.configuration.repositoryKey,
      group,
      phone,
      onRetry: props.onRetry,
    })));
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
        storageKey: sectionStorageKey("all", "work", section.key),
        children: [
          ...buckets.flatMap((item) => {
            const entries = item.entries?.[section.key] ?? [];
            if (entries.length === 0) return [];
            return [h(WorkGroupSection, {
              key: item.group.entry.configuration.repositoryKey,
              group: section.key,
              title: item.group.entry.configuration.repositoryKey,
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
  const focusQuestionId = focus.inner?.replace(/^question-/u, "") ?? null;
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

  useRevealOnFocus(
    focusQuestionId ? `${focus.repositoryKey ?? "all"}:${focusQuestionId}@${questionDigests}` : null,
    () => {
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
      pickerRouting: ctx.environmentId
        ? { kind: "environment", environmentId: ctx.environmentId }
        : { kind: "host", hostId: ctx.repository.connectedHostId },
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
    storageKey: sectionStorageKey("all", "questions", "open"),
    children: [
      ...buckets.flatMap((bucket) => bucket.open.length === 0 ? [] : [h(Section, {
        key: bucket.group.entry.configuration.repositoryKey,
        title: bucket.group.entry.configuration.repositoryKey,
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
        storageKey: sectionStorageKey("all", "questions", "answered"),
        testId: "answered-questions",
        children: buckets.flatMap((bucket) => bucket.answered.length === 0 ? [] : [h(Section, {
          key: bucket.group.entry.configuration.repositoryKey,
          title: bucket.group.entry.configuration.repositoryKey,
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
        storageKey: sectionStorageKey("all", "questions", "bb-questions"),
        children: props.groups.flatMap<ReactNode>((group) => {
          if (group.bundle.interactions.status === "ready" && group.bundle.interactions.data.interactions.length > 0) {
            return [h(Section, {
              key: group.entry.configuration.repositoryKey,
              title: group.entry.configuration.repositoryKey,
              count: group.bundle.interactions.data.interactions.length,
              collapsible: true,
              defaultOpen: !phone,
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
        storageKey: sectionStorageKey("all", "runs", section.key),
        children: [
          ...buckets.flatMap((item) => {
            const runs = item.runs?.[section.key] ?? [];
            if (runs.length === 0) return [];
            return [h(RunGroupSection, {
              key: item.group.entry.configuration.repositoryKey,
              group: section.key,
              title: item.group.entry.configuration.repositoryKey,
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
