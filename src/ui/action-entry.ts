import { createElement, useState } from "react";
import type {
  ApprovalDecision,
  PendingInteraction,
  QueueEntry,
} from "../contracts.js";
import { buttonClass } from "./views.js";

const h = createElement;

const quietButtonClass =
  "inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-surface-recessed hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none";

export interface ActionFeedback {
  readonly pending: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

export const idleActionFeedback: ActionFeedback = { pending: false, message: null, error: null };

export function ActionFeedbackNotice({ feedback }: { feedback: ActionFeedback | null }) {
  if (!feedback || (!feedback.message && !feedback.error)) return null;
  return h(
    "p",
    {
      className: `mt-3 rounded-md border px-3 py-2 text-xs leading-5 ${
        feedback.error
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-success/40 bg-success/10 text-success"
      }`,
      role: "status",
    },
    feedback.error ?? feedback.message,
  );
}

/** Initial-ready approval: the only UI path that writes `status: ready`. */
export function QueueApprovalControl({
  entry,
  feedback,
  onApprove,
}: {
  entry: QueueEntry;
  feedback: ActionFeedback | null;
  onApprove: (queueItemId: string, approvedText: string) => void;
}) {
  const existing = entry.approved.kind === "explicit" ? entry.approved.text : "";
  const [text, setText] = useState(existing);
  const approvable = entry.status.kind !== "ready" && entry.status.kind !== "in-progress" && entry.status.kind !== "done";
  if (!approvable) return null;
  return h(
    "div",
    { className: "mt-4 border-t border-border pt-3" },
    h("p", { className: "text-xs font-medium uppercase tracking-wide text-muted-foreground" }, "Initial ready authorization"),
    h("p", { className: "mt-1 text-xs text-muted-foreground" }, "Only this native action can set status: ready. List the gated actions you allow, for example dependency add or migration."),
    h("div", { className: "mt-2 flex flex-col gap-2 sm:flex-row" },
      h("input", {
        type: "text",
        className: inputClass,
        value: text,
        placeholder: "approved: none, or gated actions",
        disabled: feedback?.pending,
        onChange: (event: { target: { value: string } }) => setText(event.target.value),
      }),
      h("button", {
        type: "button",
        className: buttonClass,
        disabled: feedback?.pending || !text.trim(),
        onClick: () => onApprove(entry.id, text.trim()),
      }, feedback?.pending ? "Approving…" : "Approve as ready"),
    ),
  );
}

/** Repository question answer entry. */
export function QuestionAnswerControl({
  questionId,
  feedback,
  onAnswer,
}: {
  questionId: string;
  feedback: ActionFeedback | null;
  onAnswer: (questionId: string, answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  return h(
    "div",
    { className: "mt-4 border-t border-border pt-3" },
    h("p", { className: "text-xs font-medium uppercase tracking-wide text-muted-foreground" }, "Answer in place"),
    h("textarea", {
      className: `${inputClass} mt-2 min-h-20`,
      value: answer,
      placeholder: "Write the answer recorded in questions.md",
      disabled: feedback?.pending,
      onChange: (event: { target: { value: string } }) => setAnswer(event.target.value),
    }),
    h("div", { className: "mt-2 flex justify-end" },
      h("button", {
        type: "button",
        className: buttonClass,
        disabled: feedback?.pending || !answer.trim(),
        onClick: () => onAnswer(questionId, answer.trim()),
      }, feedback?.pending ? "Answering…" : "Record answer"),
    ),
  );
}

function ApprovalButtons({
  interaction,
  feedback,
  onResolve,
}: {
  interaction: PendingInteraction;
  feedback: ActionFeedback | null;
  onResolve: (interactionId: string, resolution: { kind: "approval"; decision: ApprovalDecision }) => void;
}) {
  const decisions = interaction.metadata.kind === "approval" ? interaction.metadata.availableDecisions : [];
  const labels: Record<ApprovalDecision, string> = {
    allow_once: "Allow once",
    allow_for_session: "Allow for session",
    deny: "Deny",
  };
  return h(
    "div",
    { className: "mt-3 flex flex-wrap gap-2" },
    decisions.map((decision) => h("button", {
      key: decision,
      type: "button",
      className: decision === "deny" ? quietButtonClass : buttonClass,
      disabled: feedback?.pending,
      onClick: () => onResolve(interaction.interactionId, { kind: "approval", decision }),
    }, labels[decision])),
  );
}

function UserQuestionForm({
  interaction,
  feedback,
  onResolve,
}: {
  interaction: PendingInteraction;
  feedback: ActionFeedback | null;
  onResolve: (interactionId: string, resolution: { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> }) => void;
}) {
  const questions = interaction.metadata.kind === "user_question" ? interaction.metadata.questions : [];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const toggle = (questionId: string, value: string, multi: boolean) => {
    setSelected((current) => {
      const existing = current[questionId] ?? [];
      const next = existing.includes(value)
        ? existing.filter((item) => item !== value)
        : multi ? [...existing, value] : [value];
      return { ...current, [questionId]: next };
    });
  };
  const complete = questions.every((question) =>
    (selected[question.id] ?? []).length > 0 || (freeText[question.id] ?? "").trim().length > 0);
  return h(
    "div",
    { className: "mt-3 space-y-4" },
    questions.map((question) => h(
      "div",
      { key: question.id, className: "space-y-2" },
      h("p", { className: "text-sm font-medium" }, question.prompt),
      (question.options ?? []).map((option) => h(
        "label",
        { key: option.value, className: "flex items-start gap-2 text-sm" },
        h("input", {
          type: question.multiSelect ? "checkbox" : "radio",
          name: `interaction-${interaction.interactionId}-${question.id}`,
          className: "mt-1",
          checked: (selected[question.id] ?? []).includes(option.value),
          disabled: feedback?.pending,
          onChange: () => toggle(question.id, option.value, question.multiSelect),
        }),
        h("span", null, option.label, option.description ? h("span", { className: "ml-1 text-xs text-muted-foreground" }, option.description) : null),
      )),
      question.allowFreeText ? h("input", {
        type: "text",
        className: inputClass,
        placeholder: "Other answer",
        value: freeText[question.id] ?? "",
        disabled: feedback?.pending,
        onChange: (event: { target: { value: string } }) => setFreeText((current) => ({ ...current, [question.id]: event.target.value })),
      }) : null,
    )),
    h("div", { className: "flex justify-end" },
      h("button", {
        type: "button",
        className: buttonClass,
        disabled: feedback?.pending || !complete,
        onClick: () => onResolve(interaction.interactionId, {
          kind: "user_answer",
          answers: Object.fromEntries(questions.map((question) => [question.id, {
            selected: selected[question.id] ?? [],
            ...((freeText[question.id] ?? "").trim() ? { freeText: freeText[question.id]!.trim() } : {}),
          }])),
        }),
      }, feedback?.pending ? "Submitting…" : "Submit answers"),
    ),
  );
}

export function PendingInteractionControls({
  interaction,
  feedback,
  onResolve,
}: {
  interaction: PendingInteraction;
  feedback: ActionFeedback | null;
  onResolve: (interactionId: string, resolution: { kind: "approval"; decision: ApprovalDecision } | { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> }) => void;
}) {
  if (interaction.kind === "approval") {
    return h(ApprovalButtons, { interaction, feedback, onResolve });
  }
  if (interaction.kind === "user-question") {
    return h(UserQuestionForm, { interaction, feedback, onResolve });
  }
  return h("p", { className: "mt-3 text-xs text-muted-foreground" }, "This plugin interaction must be resolved inside its thread.");
}

/** Run control buttons for the overview surface. */
export function DispatchControls({
  mode,
  acceptingNewRuns,
  feedback,
  onRunNow,
  onPause,
  onResume,
}: {
  mode: "enabled" | "paused";
  acceptingNewRuns: boolean;
  feedback: ActionFeedback | null;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  return h(
    "div",
    { className: "mt-3 flex flex-wrap gap-2 border-t border-border pt-3" },
    h("button", {
      type: "button",
      className: buttonClass,
      disabled: feedback?.pending || mode !== "enabled" || !acceptingNewRuns,
      title: mode !== "enabled" ? "Dispatch is paused" : acceptingNewRuns ? "Start a foreman run now" : "A run or the concurrency limit is active",
      onClick: onRunNow,
    }, feedback?.pending ? "Working…" : "Run now"),
    mode === "enabled"
      ? h("button", { type: "button", className: quietButtonClass, disabled: feedback?.pending, onClick: onPause }, "Pause dispatch")
      : h("button", { type: "button", className: quietButtonClass, disabled: feedback?.pending, onClick: onResume }, "Resume dispatch"),
  );
}

/** Stop / retry controls for a run detail surface. */
export function RunActionControls({
  status,
  latestFailedAttemptId,
  feedback,
  onStop,
  onRetry,
}: {
  status: string;
  latestFailedAttemptId: string | null;
  feedback: ActionFeedback | null;
  onStop: () => void;
  onRetry: (attemptId: string) => void;
}) {
  const active = status === "started" || status === "pending";
  if (!active && !latestFailedAttemptId) return null;
  return h(
    "div",
    { className: "mt-3 flex flex-wrap gap-2" },
    active ? h("button", {
      type: "button",
      className: quietButtonClass,
      disabled: feedback?.pending,
      onClick: onStop,
    }, "Stop run") : null,
    latestFailedAttemptId ? h("button", {
      type: "button",
      className: buttonClass,
      disabled: feedback?.pending,
      onClick: () => onRetry(latestFailedAttemptId),
    }, "Retry failed attempt") : null,
  );
}
