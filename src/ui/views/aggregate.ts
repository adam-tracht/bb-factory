import { createElement, type ReactNode } from "react";
import type {
  HealthProjection,
  OperationalRunListProjection,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  RepositorySelection,
  SettingsProjection,
} from "../../contracts.js";
import type { ViewContext } from "../context.js";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../primitives.js";
import { QuestionsView } from "./questions.js";
import { RunsView } from "./runs.js";
import { WorkView } from "./work.js";

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

/** One repository's slice of an aggregate tab: its registry entry, its loaded projections, and its scoped context. */
export interface AggregateGroup {
  readonly entry: RepositorySelection;
  readonly bundle: RepositoryBundle;
  readonly ctx: ViewContext;
}

export type AggregateSection = "work" | "questions" | "runs";

/** Aggregate anchors travel as "<repositoryKey>/<inner anchor>"; a bare inner anchor focuses every group that contains the item. */
export function splitAggregateAnchor(anchor: string | null): { repositoryKey: string | null; inner: string | null } {
  if (!anchor) return { repositoryKey: null, inner: null };
  const slash = anchor.indexOf("/");
  if (slash <= 0) return { repositoryKey: null, inner: anchor };
  return { repositoryKey: anchor.slice(0, slash), inner: anchor.slice(slash + 1) };
}

function GroupHeading(props: { entry: RepositorySelection }) {
  const configuration = props.entry.configuration;
  return h(
    "div",
    { className: "flex min-w-0 items-baseline gap-2 border-b border-border pb-1.5" },
    h("h2", { className: "truncate text-sm font-semibold text-foreground" }, configuration.repositoryKey),
    h("span", { className: "shrink-0 text-xs text-muted-foreground" }, configuration.connectedHostId),
  );
}

function preferredProvider(bundle: RepositoryBundle): string | null {
  const preference = bundle.settings.status === "ready" ? bundle.settings.data.settings.providerPreference : null;
  return preference && preference !== "alternate" ? preference : null;
}

function GroupBody(props: {
  section: AggregateSection;
  group: AggregateGroup;
  focusInner: string | null;
  onRetry: () => void;
}) {
  const { section, group, onRetry } = props;
  const { bundle, ctx } = group;
  const inner = props.focusInner;
  if (section === "work") {
    return bundle.snapshot.status === "ready"
      ? h(WorkView, {
          snapshot: bundle.snapshot.data,
          ctx,
          focusItemId: inner?.replace(/^work-/u, "") ?? null,
          providers: bundle.health.status === "ready" ? bundle.health.data.providers : [],
          preferredProviderId: preferredProvider(bundle),
        })
      : bundle.snapshot.status === "error"
        ? h(ErrorNotice, { message: bundle.snapshot.error, onRetry })
        : h(LoadingNotice, { label: "Loading repository work" });
  }
  if (section === "questions") {
    return bundle.snapshot.status === "ready"
      ? h(QuestionsView, {
          snapshot: bundle.snapshot.data,
          interactions: bundle.interactions.status === "ready" ? bundle.interactions.data : null,
          ctx,
          focusQuestionId: inner?.replace(/^question-/u, "") ?? null,
          providers: bundle.health.status === "ready" ? bundle.health.data.providers : [],
          preferredProviderId: preferredProvider(bundle),
        })
      : bundle.snapshot.status === "error"
        ? h(ErrorNotice, { message: bundle.snapshot.error, onRetry })
        : h(LoadingNotice, { label: "Loading questions" });
  }
  return bundle.runs.status === "ready"
    ? h(RunsView, { runs: bundle.runs.data, ctx })
    : bundle.runs.status === "error"
      ? h(ErrorNotice, { message: bundle.runs.error, onRetry })
      : h(LoadingNotice, { label: "Loading run history" });
}

/**
 * The "All" union tabs: one section per registered repository, each rendered
 * by the existing per-repository view against a context scoped to that
 * repository, so rows act on and link within their own repository.
 */
export function AggregateSectionView(props: {
  section: AggregateSection;
  groups: readonly AggregateGroup[];
  anchor: string | null;
  onRetry: () => void;
}): ReactNode {
  const focus = splitAggregateAnchor(props.anchor);
  const matching = props.groups.filter(
    (group) => focus.repositoryKey === null || group.entry.configuration.repositoryKey === focus.repositoryKey,
  );
  if (props.groups.length === 0) {
    return h(EmptyNotice, {
      title: "No repositories configured",
      detail: "Add a repository registry entry to start dispatching factory runs.",
    });
  }
  return h(
    "div",
    { className: "space-y-4" },
    props.groups.map((group) =>
      h(
        "section",
        { key: group.entry.configuration.repositoryKey },
        h(GroupHeading, { entry: group.entry }),
        h(GroupBody, {
          section: props.section,
          group,
          focusInner: matching.includes(group) ? focus.inner : null,
          onRetry: props.onRetry,
        }),
      ),
    ),
  );
}
