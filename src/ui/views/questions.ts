import { Markdown } from "@get-bb/plugin-sdk/app";
import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ApprovalDecision,
  BbInteractionResolution,
  PendingInteraction,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  ProviderStatus,
  Question,
} from "../../contracts.js";
import type { ViewContext } from "../context.js";
import {
  ProviderModelPicker,
  pickerRoutingFor,
  seedPickerValue,
  type PickerRouting,
  type PickerValue,
} from "../providerPicker.js";
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  Disclosure,
  EmptyNotice,
  FeedbackNotice,
  Section,
  safeMarkdown,
  sectionStorageKey,
  usePhoneViewport,
  useRevealOnFocus,
  type Tone,
} from "../primitives.js";

const h = createElement;

const QUESTIONS_PATH = "plans/factory/questions.md";

const inputClass =
  "box-border rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground";
const labelClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export type KindFilter = "all" | "blocking" | "assumption";
export type StateFilter = "all" | "open" | "answered";

/** Queue items a question gates, resolved via blockedBy and blocked-by status. */
export function questionGates(snapshot: ProtocolSnapshot, questionId: string): string[] {
  return snapshot.queue
    .filter(
      (entry) =>
        entry.blockedBy.includes(questionId) ||
        (entry.status.kind === "blocked-by" && entry.status.questionId === questionId),
    )
    .map((entry) => entry.id);
}

function classificationBadge(classification: Question["classification"]) {
  return h(Badge, {
    label: classification === "blocking" ? "Blocking" : "Assumption",
    tone: classification === "blocking" ? "warning" : "neutral",
  });
}

/** Markdown block clamped to about three lines with a show-more toggle. */
function ClampedMarkdown({ content, className }: { content: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const likelyOverflow = content.split("\n").length > 3 || content.length > 160;
  return h(
    "div",
    null,
    h(
      "div",
      { className: expanded || !likelyOverflow ? "" : "line-clamp-3" },
      h(Markdown, { content: safeMarkdown(content), className: className ?? "text-sm text-muted-foreground" }),
    ),
    likelyOverflow
      ? h(
          "button",
          {
            type: "button",
            className: "mt-1 text-xs text-primary underline-offset-2 hover:underline",
            onClick: () => setExpanded((current) => !current),
          },
          expanded ? "Show less" : "Show more",
        )
      : null,
  );
}

export function RepositoryQuestionCard(props: {
  question: Question;
  gates: string[];
  pending: boolean;
  providers: readonly ProviderStatus[];
  preferredProviderId: string | null;
  pickerRouting: PickerRouting;
  onRecord: (questionId: string, answer: string) => void;
  onRecommend: (questionId: string, selection: PickerValue) => void;
  onOpenGated: (queueItemId: string) => void;
  idPrefix?: string;
}) {
  const { question, gates, pending } = props;
  const assumed = question.assumed;
  const [draft, setDraft] = useState("");
  const [confirmAnswer, setConfirmAnswer] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [selection, setSelection] = useState<PickerValue | null>(null);
  const trimmed = draft.trim();
  const askSeed = seedPickerValue(props.providers, props.preferredProviderId);
  const canAsk = ProviderModelPicker !== undefined && askSeed !== null;

  return h(
    "section",
    { id: `${props.idPrefix ?? ""}question-${question.id}`, className: "rounded-lg border border-border bg-card p-4" },
    h(
      "div",
      { className: "flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground" },
      h("span", { className: "font-mono" }, question.id),
      h("span", null, question.date),
      classificationBadge(question.classification),
    ),
    h("h3", { className: "mt-1.5 break-words text-sm font-medium text-foreground" }, question.question),
    gates.length > 0
      ? h(
          "p",
          { className: "mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" },
          "Blocks:",
          gates.map((id) =>
            h(
              "button",
              {
                key: id,
                type: "button",
                className: "max-w-full break-all font-mono text-primary underline-offset-2 hover:underline",
                style: { overflowWrap: "anywhere" },
                onClick: () => props.onOpenGated(id),
              },
              id,
            ),
          ),
        )
      : null,
    h(
      "div",
      { className: "mt-3" },
      h("p", { className: labelClass }, "Context"),
      h(
        "div",
        { className: "mt-1 rounded-md bg-surface-recessed/40 p-3" },
        h(ClampedMarkdown, { content: question.context }),
      ),
    ),
    question.classification === "assumption" && assumed
      ? h("p", { className: "mt-3 text-sm text-muted-foreground" }, "Current assumption: ", assumed)
      : null,
    h(
      "div",
      { className: "mt-4 border-t border-border pt-3" },
      h("textarea", {
        className: `${inputClass} min-h-20 w-full`,
        value: draft,
        placeholder: `Your answer. Recorded to plans/factory/questions.md as ${question.id}'s answer.`,
        "aria-label": `Answer ${question.id}`,
        disabled: pending,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      }),
      h(
        "div",
        { className: "mt-2 flex flex-wrap items-center gap-2" },
        h(ActionButton, {
          label: "Ask an agent",
          variant: "ghost",
          disabled: pending || !canAsk,
          title: canAsk
            ? "Start a chat that recommends an answer"
            : "The provider catalog is unavailable, so no agent can be picked.",
          onClick: () => {
            setSelection(askSeed);
            setAskOpen(true);
          },
        }),
        h(
          "div",
          { className: "ml-auto flex flex-wrap gap-2" },
          question.classification === "assumption" && assumed
            ? h(ActionButton, {
                label: "Accept assumption",
                variant: "secondary",
                disabled: pending,
                onClick: () => setConfirmAnswer(assumed),
              })
            : null,
          h(ActionButton, {
            label: "Record answer",
            variant: "primary",
            disabled: pending || !trimmed,
            busy: pending,
            onClick: () => setConfirmAnswer(trimmed),
          }),
        ),
      ),
    ),
    h(ConfirmDialog, {
      open: askOpen,
      title: `Ask an agent about ${question.id}`,
      body: h(
        "div",
        { className: "space-y-3" },
        h(
          "p",
          null,
          "Starts a chat in this repository's environment that recommends an answer. Advisory only: it cannot edit the repository.",
        ),
        ProviderModelPicker !== undefined && selection !== null
          ? h(ProviderModelPicker, {
              value: selection,
              onChange: (next: PickerValue) => setSelection(next),
              routing: props.pickerRouting,
              disabled: pending,
            })
          : null,
      ),
      confirmLabel: "Start chat",
      busy: pending,
      onConfirm: () => {
        const picked = selection;
        setAskOpen(false);
        if (picked) props.onRecommend(question.id, picked);
      },
      onCancel: () => setAskOpen(false),
    }),
    h(ConfirmDialog, {
      open: confirmAnswer !== null,
      title: `Record ${question.id} answer`,
      body: `Appends to plans/factory/questions.md on branch factory. ${question.id} gates: ${gates.length > 0 ? gates.join(", ") : "no items"}.`,
      confirmLabel: "Record answer",
      busy: pending,
      onConfirm: () => {
        const answer = confirmAnswer;
        setConfirmAnswer(null);
        if (answer) props.onRecord(question.id, answer);
      },
      onCancel: () => setConfirmAnswer(null),
    }),
  );
}

export function AnsweredQuestionRow(props: { question: Question; recorded: boolean; idPrefix?: string }) {
  const { question, recorded } = props;
  return h(
    "div",
    { id: `${props.idPrefix ?? ""}question-${question.id}`, className: "py-1.5" },
    h(Disclosure, {
      summary: h(
        "span",
        { className: "flex min-w-0 flex-wrap items-center gap-2" },
        h("span", { className: "font-mono text-xs" }, question.id),
        classificationBadge(question.classification),
        h("span", { className: "min-w-0 line-clamp-2 break-words text-xs" }, question.question),
        h(
          "span",
          { className: "shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" },
          recorded ? "Recorded" : "Answered",
        ),
      ),
      children: h(
        "div",
        { className: "space-y-3 py-2 pl-5" },
        h("p", { className: "text-sm font-medium text-foreground" }, question.question),
        h(
          "div",
          null,
          h("p", { className: labelClass }, "Context"),
          h(
            "div",
            { className: "mt-1 rounded-md bg-surface-recessed/40 p-3" },
            h(ClampedMarkdown, { content: question.context }),
          ),
        ),
        question.answer !== null
          ? h(
              "div",
              null,
              h("p", { className: labelClass }, "Recorded answer"),
              h(Markdown, {
                content: safeMarkdown(question.answer),
                className: "mt-1 text-sm text-muted-foreground",
              }),
            )
          : h("p", { className: "text-xs text-muted-foreground" }, "Answer recorded this session."),
      ),
    }),
  );
}

const DECISION_LABELS: Record<ApprovalDecision, string> = {
  allow_once: "Allow once",
  allow_for_session: "Allow for session",
  deny: "Deny",
};

function ApprovalControls(props: {
  interaction: PendingInteraction;
  pending: boolean;
  onResolve: (resolution: BbInteractionResolution) => void;
}) {
  const decisions =
    props.interaction.metadata.kind === "approval" ? props.interaction.metadata.availableDecisions : [];
  return h(
    "div",
    { className: "mt-3 flex flex-wrap gap-2" },
    decisions.map((decision) =>
      h(ActionButton, {
        key: decision,
        label: DECISION_LABELS[decision],
        variant: decision === "deny" ? "danger" : decision === "allow_once" ? "primary" : "secondary",
        disabled: props.pending,
        onClick: () => props.onResolve({ kind: "approval", decision }),
      }),
    ),
  );
}

function UserQuestionControls(props: {
  interaction: PendingInteraction;
  pending: boolean;
  onResolve: (resolution: BbInteractionResolution) => void;
}) {
  const questions =
    props.interaction.metadata.kind === "user_question" ? props.interaction.metadata.questions : [];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const complete =
    questions.length > 0 &&
    questions.every(
      (question) =>
        (selected[question.id] ?? []).length > 0 || (freeText[question.id] ?? "").trim().length > 0,
    );
  const toggle = (questionId: string, value: string) => {
    setSelected((current) => {
      const list = current[questionId] ?? [];
      return {
        ...current,
        [questionId]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value],
      };
    });
  };

  return h(
    "div",
    { className: "mt-3 space-y-4" },
    questions.map((question) =>
      h(
        "div",
        { key: question.id, className: "space-y-2" },
        h("p", { className: "text-sm text-foreground" }, question.prompt),
        question.options && question.options.length > 0
          ? question.multiSelect
            ? h(
                "div",
                { className: "space-y-1.5" },
                question.options.map((option) =>
                  h(
                    "label",
                    { key: option.value, className: "flex items-start gap-2 text-sm" },
                    h("input", {
                      type: "checkbox",
                      className: "mt-1",
                      checked: (selected[question.id] ?? []).includes(option.value),
                      disabled: props.pending,
                      onChange: () => toggle(question.id, option.value),
                    }),
                    h(
                      "span",
                      null,
                      option.label,
                      option.description
                        ? h("span", { className: "ml-1 text-xs text-muted-foreground" }, option.description)
                        : null,
                    ),
                  ),
                ),
              )
            : h(
                "select",
                {
                  className: `${inputClass} w-full`,
                  "aria-label": question.prompt,
                  value: selected[question.id]?.[0] ?? "",
                  disabled: props.pending,
                  onChange: (event: { target: { value: string } }) =>
                    setSelected((current) => ({
                      ...current,
                      [question.id]: event.target.value ? [event.target.value] : [],
                    })),
                },
                h("option", { value: "" }, "Select an answer"),
                question.options.map((option) =>
                  h(
                    "option",
                    {
                      key: option.value,
                      value: option.value,
                      ...(option.description ? { title: option.description } : {}),
                    },
                    option.label,
                  ),
                ),
              )
          : null,
        question.allowFreeText
          ? h("input", {
              type: "text",
              className: `${inputClass} w-full`,
              placeholder: "Other answer",
              "aria-label": `${question.prompt} (free text)`,
              value: freeText[question.id] ?? "",
              disabled: props.pending,
              onChange: (event: { target: { value: string } }) =>
                setFreeText((current) => ({ ...current, [question.id]: event.target.value })),
            })
          : null,
      ),
    ),
    h(
      "div",
      { className: "flex justify-end" },
      h(ActionButton, {
        label: "Answer",
        variant: "primary",
        disabled: props.pending || !complete,
        busy: props.pending,
        onClick: () =>
          props.onResolve({
            kind: "user_answer",
            answers: Object.fromEntries(
              questions.map((question) => [
                question.id,
                {
                  selected: selected[question.id] ?? [],
                  ...((freeText[question.id] ?? "").trim()
                    ? { freeText: freeText[question.id]!.trim() }
                    : {}),
                },
              ]),
            ),
          }),
      }),
    ),
  );
}

const INTERACTION_KIND_LABEL: Record<PendingInteraction["kind"], string> = {
  approval: "Approval",
  "user-question": "Question",
  plugin: "Plugin",
};

const INTERACTION_KIND_TONE: Record<PendingInteraction["kind"], Tone> = {
  approval: "warning",
  "user-question": "primary",
  plugin: "neutral",
};

export function PendingInteractionRow(props: { interaction: PendingInteraction; ctx: ViewContext }) {
  const { interaction, ctx } = props;
  const pending = ctx.pendingTarget === `interaction:${interaction.interactionId}`;
  const resolve = (resolution: BbInteractionResolution) =>
    ctx.onAction({
      kind: "answer-question",
      source: "bb-interaction",
      interactionId: interaction.interactionId,
      resolution,
    });

  return h(
    "div",
    { id: `${ctx.idPrefix ?? ""}interaction-${interaction.interactionId}`, className: "py-3" },
    h(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      h("p", { className: "text-sm font-medium text-foreground" }, interaction.title),
      h(Badge, { label: INTERACTION_KIND_LABEL[interaction.kind], tone: INTERACTION_KIND_TONE[interaction.kind] }),
    ),
    interaction.prompt
      ? h(
          "div",
          { className: "mt-1.5" },
          h(Markdown, { content: safeMarkdown(interaction.prompt), className: "text-sm text-muted-foreground" }),
        )
      : null,
    interaction.kind === "approval"
      ? h(ApprovalControls, { interaction, pending, onResolve: resolve })
      : interaction.kind === "user-question"
        ? h(UserQuestionControls, { interaction, pending, onResolve: resolve })
        : h(
            "div",
            { className: "mt-3" },
            h(ActionButton, {
              label: "Respond in the thread",
              variant: "secondary",
              onClick: () => ctx.onOpenThread(interaction.threadId),
            }),
          ),
  );
}

/**
 * Reveal a focused card: open collapsed ancestors and the row expander, then
 * scroll. False while the card has not mounted yet; a section just opened by
 * forceOpen mounts its children in the follow-up commit.
 */
export function revealQuestion(id: string, idPrefix?: string): boolean {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(`${idPrefix ?? ""}question-${id}`);
  if (!element) return false;
  const rowDetails = element.querySelector(":scope > details");
  if (rowDetails instanceof HTMLDetailsElement) rowDetails.open = true;
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

export function filterQuestions(
  questions: readonly Question[],
  query: string,
  kindFilter: KindFilter,
  stateFilter: StateFilter,
  locallyAnswered: ReadonlySet<string>,
): Question[] {
  const needle = query.trim().toLowerCase();
  return questions.filter((question) => {
    if (kindFilter !== "all" && question.classification !== kindFilter) return false;
    const answered = question.answer !== null || locallyAnswered.has(question.id);
    if (stateFilter === "open" && answered) return false;
    if (stateFilter === "answered" && !answered) return false;
    if (needle && !`${question.id} ${question.question} ${question.context}`.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

export function QuestionFilterControls(props: {
  query: string;
  kindFilter: KindFilter;
  stateFilter: StateFilter;
  onQueryChange: (value: string) => void;
  onKindChange: (value: KindFilter) => void;
  onStateChange: (value: StateFilter) => void;
}): ReactNode {
  return h(
    "div",
    { className: "flex flex-wrap items-center gap-2" },
    h("input", {
      type: "search",
      className: `${inputClass} w-full min-w-0 sm:w-auto sm:min-w-48 sm:flex-1`,
      placeholder: "Filter by id, question, or context",
      "aria-label": "Filter questions",
      value: props.query,
      onChange: (event: { target: { value: string } }) => props.onQueryChange(event.target.value),
    }),
    h(
      "select",
      {
        className: inputClass,
        "aria-label": "Question kind",
        value: props.kindFilter,
        onChange: (event: { target: { value: string } }) => props.onKindChange(event.target.value as KindFilter),
      },
      h("option", { value: "all" }, "All"),
      h("option", { value: "blocking" }, "Blocking"),
      h("option", { value: "assumption" }, "Assumption"),
    ),
    h(
      "select",
      {
        className: inputClass,
        "aria-label": "Question state",
        value: props.stateFilter,
        onChange: (event: { target: { value: string } }) => props.onStateChange(event.target.value as StateFilter),
      },
      h("option", { value: "all" }, "All"),
      h("option", { value: "open" }, "Open"),
      h("option", { value: "answered" }, "Answered"),
    ),
  );
}

export function QuestionsView(props: {
  snapshot: ProtocolSnapshot;
  interactions: PendingInteractionsProjection | null;
  ctx: ViewContext;
  focusQuestionId?: string | null;
  providers?: readonly ProviderStatus[];
  preferredProviderId?: string | null;
}): ReactNode {
  const { snapshot, interactions, ctx } = props;
  const focusQuestionId = props.focusQuestionId ?? null;
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [locallyAnswered, setLocallyAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const phone = usePhoneViewport();
  // The questions source alone keys the re-arms below: a refresh touching
  // foreman, queue, current, dashboard, runs, or lock must not re-scroll a
  // still-focused card or drop optimistic answers it cannot supersede.
  const questionsDigest = ctx.revision?.fileDigests[QUESTIONS_PATH] ?? null;

  // Optimistic answers are stale once the questions file actually changes.
  useEffect(() => {
    setLocallyAnswered((current) => (current.size === 0 ? current : new Set()));
  }, [questionsDigest]);

  const isAnswered = (question: Question) =>
    question.answer !== null || locallyAnswered.has(question.id);

  const filtered = useMemo(
    () => filterQuestions(snapshot.questions, query, kindFilter, stateFilter, locallyAnswered),
    [snapshot.questions, kindFilter, stateFilter, query, locallyAnswered],
  );

  const openQuestions = filtered
    .filter((question) => !isAnswered(question))
    .sort(
      (left, right) =>
        (left.classification === "blocking" ? 0 : 1) - (right.classification === "blocking" ? 0 : 1),
    );
  const answeredQuestions = filtered.filter((question) => isAnswered(question));

  // A questions.md digest bump re-arms the reveal so a refresh that remounts
  // the focused card (open -> answered group move) scrolls back to it.
  const focusElementId = focusQuestionId ? `${ctx.idPrefix ?? ""}question-${focusQuestionId}` : null;
  useRevealOnFocus(
    focusElementId ? `${ctx.repository.repositoryKey}:${focusElementId}@${questionsDigest ?? ""}` : null,
    () => focusQuestionId !== null && revealQuestion(focusQuestionId, ctx.idPrefix),
  );

  const recordAnswer = (questionId: string, answer: string) => {
    ctx.onAction({ kind: "answer-question", source: "repository-question", questionId, answer });
    setLocallyAnswered((current) => {
      const next = new Set(current);
      next.add(questionId);
      return next;
    });
  };

  const recommend = (questionId: string, selection: PickerValue) => {
    ctx.onAction({
      kind: "recommend-question",
      questionId,
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel,
      ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }),
    });
  };

  const pickerRouting = pickerRoutingFor(ctx);

  const pendingInteractions = interactions?.interactions ?? [];
  const filtersActive = query.trim() !== "" || kindFilter !== "all" || stateFilter !== "all";
  const focusedOpen =
    focusQuestionId !== null && openQuestions.some((question) => question.id === focusQuestionId);
  const focusedAnswered =
    focusQuestionId !== null && answeredQuestions.some((question) => question.id === focusQuestionId);

  return h(
    "div",
    { className: "space-y-4" },
    h(FeedbackNotice, { feedback: ctx.feedback }),
    h(QuestionFilterControls, {
      query,
      kindFilter,
      stateFilter,
      onQueryChange: setQuery,
      onKindChange: setKindFilter,
      onStateChange: setStateFilter,
    }),
    pendingInteractions.length > 0
      ? h(Section, {
          title: "BB questions",
          count: pendingInteractions.length,
          collapsible: true,
          defaultOpen: !phone,
          storageKey: sectionStorageKey(ctx.repository.repositoryKey, "questions", "bb-questions"),
          children: pendingInteractions.map((interaction) =>
            h(PendingInteractionRow, { key: interaction.interactionId, interaction, ctx }),
          ),
        })
      : null,
    filtered.length === 0
      ? h(EmptyNotice, {
          title: "No questions",
          detail: filtersActive
            ? "No repository questions match the current filters."
            : "The selected repository has no parsed questions.",
        })
      : h(
          "div",
          { className: "space-y-3" },
          h(Section, {
            title: "Open",
            count: openQuestions.length,
            collapsible: true,
            defaultOpen: true,
            // The focus id doubles as the force-open token: a new target in
            // the same section reopens it, a repeated one stays user-closable.
            forceOpen: focusedOpen ? focusElementId : false,
            storageKey: sectionStorageKey(ctx.repository.repositoryKey, "questions", "open"),
            children:
              openQuestions.length === 0
                ? h("p", { className: "px-1 py-2 text-sm text-muted-foreground" }, "No open questions.")
                : h(
                    "div",
                    { className: "space-y-3 py-1" },
                    openQuestions.map((question) =>
                      h(RepositoryQuestionCard, {
                        key: question.id,
                        question,
                        gates: questionGates(snapshot, question.id),
                        pending: ctx.pendingTarget === `question:${question.id}`,
                        providers: props.providers ?? [],
                        preferredProviderId: props.preferredProviderId ?? null,
                        pickerRouting,
                        onRecord: recordAnswer,
                        onRecommend: recommend,
                        onOpenGated: (queueItemId) => ctx.onOpenSection("work", `work-${queueItemId}`),
                        idPrefix: ctx.idPrefix,
                      }),
                    ),
                  ),
          }),
          answeredQuestions.length > 0
            ? h(Section, {
                title: "Answered",
                count: answeredQuestions.length,
                collapsible: true,
                defaultOpen: false,
                forceOpen: focusedAnswered ? focusElementId : stateFilter === "answered",
                storageKey: sectionStorageKey(ctx.repository.repositoryKey, "questions", "answered"),
                testId: "answered-questions",
                children: answeredQuestions.map((question) =>
                  h(AnsweredQuestionRow, {
                    key: question.id,
                    question,
                    recorded: question.answer === null,
                    idPrefix: ctx.idPrefix,
                  }),
                ),
              })
            : null,
        ),
  );
}
