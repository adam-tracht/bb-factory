import { createElement, useEffect, useState, type ReactNode } from "react";
import type {
  AddRepositoryInput,
  DispatchStatus,
  RegistryOptionsProjection,
  RepositorySelection,
} from "../../contracts.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  Card,
  ConfirmDialog,
  EmptyNotice,
  ErrorNotice,
  LoadingNotice,
} from "../primitives.js";

const h = createElement;

const inputClass =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelClass = "text-xs font-medium text-muted-foreground";

type SummaryLoader = (repositoryKey: string) => Promise<{
  attention: number;
  dispatch: DispatchStatus | null;
  error: string | null;
}>;

type SummaryState =
  | { status: "loading" }
  | { status: "ready"; attention: number }
  | { status: "error"; error: string };

function RepositoryRow(props: {
  repository: RepositorySelection;
  onSelect: () => void;
  loadSummary?: SummaryLoader;
}) {
  const { repository, onSelect, loadSummary } = props;
  const repositoryKey = repository.configuration.repositoryKey;
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });

  useEffect(() => {
    if (!loadSummary) return;
    let cancelled = false;
    setSummary({ status: "loading" });
    void loadSummary(repositoryKey).then(
      (result) => {
        if (cancelled) return;
        setSummary(result.error
          ? { status: "error", error: result.error }
          : { status: "ready", attention: result.attention });
      },
      (error: unknown) => {
        if (!cancelled) {
          setSummary({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repositoryKey, loadSummary]);

  const attentionBadge = !loadSummary
    ? null
    : summary.status === "loading"
      ? h(Badge, { label: "…", tone: "neutral" })
      : summary.status === "error"
        ? h(Badge, { label: "!", tone: "danger", title: summary.error })
        : h(Badge, {
            label: String(summary.attention),
            tone: summary.attention > 0 ? "warning" : "neutral",
            title: `${summary.attention} item${summary.attention === 1 ? "" : "s"} need attention`,
          });

  return h("button", {
    type: "button",
    className: "flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-state-hover",
    onClick: onSelect,
  },
    h("div", { className: "min-w-0 flex-1" },
      h("div", { className: "flex items-center gap-2" },
        h("span", { className: "truncate text-sm font-semibold text-foreground" }, repositoryKey),
        repository.selected ? h(Badge, { label: "current", tone: "primary" }) : null),
      h("div", { className: "mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground" },
        h("span", { className: "font-mono" }, repository.configuration.connectedHostId),
        h("span", null, repository.configuration.factoryBranch))),
    h("div", { className: "flex shrink-0 items-center gap-2" },
      !repository.available
        ? h(Badge, {
            label: "unavailable",
            tone: "danger",
            title: repository.reasons.join("; ") || "Repository is unavailable",
          })
        : null,
      repository.dispatchPaused ? h(Badge, { label: "paused", tone: "warning" }) : null,
      attentionBadge));
}

export function RepositoryLandingView(props: {
  repositories: readonly RepositorySelection[];
  onSelect: (repositoryKey: string) => void;
  onAddRepository: () => void;
  loadSummary?: (repositoryKey: string) => Promise<{
    attention: number;
    dispatch: DispatchStatus | null;
    error: string | null;
  }>;
}): ReactNode {
  return h("div", { className: "space-y-4" },
    h("div", { className: "flex items-center justify-between gap-3" },
      h("h1", { className: "text-xl font-semibold" }, "Repositories"),
      h(ActionButton, { label: "Add repository", variant: "primary", onClick: props.onAddRepository })),
    props.repositories.length === 0
      ? h(EmptyNotice, {
          title: "No repositories configured",
          detail: "Add a repository registry entry to start dispatching factory runs.",
          action: h(ActionButton, { label: "Add repository", variant: "secondary", onClick: props.onAddRepository }),
        })
      : h("div", { className: "space-y-2" },
          props.repositories.map((repository) =>
            h(RepositoryRow, {
              key: repository.configuration.repositoryKey,
              repository,
              onSelect: () => props.onSelect(repository.configuration.repositoryKey),
              loadSummary: props.loadSummary,
            }))));
}

interface AddForm {
  repositoryKey: string;
  connectedHostId: string;
  repositoryRoot: string;
  checkoutPath: string;
  projectId: string;
  environmentId: string;
  mainRef: string;
  dispatchPaused: boolean;
}

type AddField = Exclude<keyof AddForm, "dispatchPaused">;

const ADD_FIELDS: ReadonlySet<string> = new Set<AddField>([
  "repositoryKey",
  "connectedHostId",
  "repositoryRoot",
  "checkoutPath",
  "projectId",
  "environmentId",
  "mainRef",
]);

const REPOSITORY_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/u;

function validateAddForm(form: AddForm): Partial<Record<AddField, string>> {
  const errors: Partial<Record<AddField, string>> = {};
  if (!REPOSITORY_KEY_RE.test(form.repositoryKey.trim())) {
    errors.repositoryKey = "Lowercase letters, digits, dots, dashes, or underscores; start with a letter or digit.";
  }
  if (!form.connectedHostId) errors.connectedHostId = "Choose a connected host.";
  if (!ABSOLUTE_PATH_RE.test(form.repositoryRoot.trim())) errors.repositoryRoot = "Enter an absolute path.";
  if (!ABSOLUTE_PATH_RE.test(form.checkoutPath.trim())) errors.checkoutPath = "Enter an absolute path.";
  if (!form.projectId) errors.projectId = "Choose a project.";
  if (!form.mainRef.trim()) errors.mainRef = "Enter the main ref.";
  return errors;
}

function buildAddInput(form: AddForm): AddRepositoryInput {
  return {
    configuration: {
      repositoryKey: form.repositoryKey.trim(),
      repositoryRoot: form.repositoryRoot.trim(),
      connectedHostId: form.connectedHostId,
      checkoutPath: form.checkoutPath.trim(),
      mainRef: form.mainRef.trim() || "origin/main",
    },
    projectId: form.projectId,
    environmentId: form.environmentId.trim() || undefined,
    dispatchPaused: form.dispatchPaused,
  };
}

type OptionsState =
  | { status: "loading" }
  | { status: "ready"; options: RegistryOptionsProjection }
  | { status: "error"; error: string };

/** Local label/control/error row: Field renders dt/dd, form rows need aria-labels. */
function FormRow(props: {
  label: string;
  children?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
}) {
  return h("div", { className: "min-w-0" },
    h("span", { className: labelClass }, props.label),
    h("div", { className: "mt-1" }, props.children),
    props.error
      ? h("p", { className: "mt-1 text-xs text-destructive" }, props.error)
      : props.hint
        ? h("p", { className: "mt-1 text-xs text-muted-foreground" }, props.hint)
        : null);
}

export function AddRepositoryView(props: {
  ctx: ViewContext;
  onDone: (repositoryKey: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { ctx, onDone, onCancel } = props;
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [form, setForm] = useState<AddForm>({
    repositoryKey: "",
    connectedHostId: "",
    repositoryRoot: "",
    checkoutPath: "",
    projectId: "",
    environmentId: "",
    mainRef: "origin/main",
    dispatchPaused: true,
  });
  const [errors, setErrors] = useState<Partial<Record<AddField, string>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOptionsState({ status: "loading" });
    void ctx.loadRegistryOptions().then(
      (options) => {
        if (!cancelled) setOptionsState({ status: "ready", options });
      },
      (error: unknown) => {
        if (!cancelled) {
          setOptionsState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctx, reloadToken]);

  const setField = <K extends keyof AddForm>(key: K, value: AddForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSubmitError(null);
    if (key !== "dispatchPaused") {
      const field = key as AddField;
      setErrors((current) => {
        if (current[field] === undefined) return current;
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  const submit = () => {
    const found = validateAddForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setConfirmOpen(true);
  };

  const confirmAdd = () => {
    setConfirmOpen(false);
    const input = buildAddInput(form);
    setSubmitting(true);
    setSubmitError(null);
    void ctx.addRepository(input).then(
      (result) => {
        setSubmitting(false);
        if (result.ok) {
          onDone(input.configuration.repositoryKey);
          return;
        }
        setSubmitError(result.error.message);
        const mapped: Partial<Record<AddField, string>> = {};
        for (const [key, messages] of Object.entries(result.error.fieldErrors ?? {})) {
          const field = key.split(".").pop() ?? "";
          if (ADD_FIELDS.has(field)) mapped[field as AddField] = messages.join("; ");
        }
        setErrors((current) => ({ ...current, ...mapped }));
      },
      (error: unknown) => {
        setSubmitting(false);
        setSubmitError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const header = h("div", { className: "flex items-center gap-3" },
    h(ActionButton, { label: "Back", variant: "ghost", size: "sm", onClick: onCancel }),
    h("h1", { className: "text-xl font-semibold" }, "Add repository"));

  if (optionsState.status === "loading") {
    return h("div", { className: "space-y-4" }, header, h(LoadingNotice, { label: "Loading hosts and projects" }));
  }
  if (optionsState.status === "error") {
    return h("div", { className: "space-y-4" },
      header,
      h(ErrorNotice, {
        message: optionsState.error,
        onRetry: () => setReloadToken((token) => token + 1),
      }));
  }

  const options = optionsState.options;
  const reviewInput = buildAddInput(form);
  const confirmBody = `Creates a registry entry. ${form.dispatchPaused
    ? "It starts paused; no runs will be scheduled until you enable it."
    : "Dispatch is on; runs may be scheduled immediately."}`;

  const hostControl = options.hosts.length > 0
    ? h("select", {
        "aria-label": "Connected host",
        className: inputClass,
        value: form.connectedHostId,
        onChange: (event: { target: { value: string } }) => setField("connectedHostId", event.target.value),
      },
        h("option", { value: "" }, "Select a host"),
        options.hosts.map((host) =>
          h("option", { key: host.hostId, value: host.hostId }, `${host.label ?? host.hostId} (${host.status})`)))
    : h("input", {
        type: "text",
        "aria-label": "Connected host",
        className: `${inputClass} font-mono`,
        value: form.connectedHostId,
        onChange: (event: { target: { value: string } }) => setField("connectedHostId", event.target.value),
      });

  const projectControl = options.projects.length > 0
    ? h("select", {
        "aria-label": "Project",
        className: inputClass,
        value: form.projectId,
        onChange: (event: { target: { value: string } }) => setField("projectId", event.target.value),
      },
        h("option", { value: "" }, "Select a project"),
        options.projects.map((project) =>
          h("option", { key: project.projectId, value: project.projectId }, project.label ?? project.projectId)))
    : h("input", {
        type: "text",
        "aria-label": "Project",
        className: `${inputClass} font-mono`,
        value: form.projectId,
        onChange: (event: { target: { value: string } }) => setField("projectId", event.target.value),
      });

  return h("div", { className: "space-y-4" },
    header,
    h(Card, {
      title: "Repository registration",
      children: [
        h("div", { key: "fields", className: "grid gap-4 sm:grid-cols-2" },
          h(FormRow, {
            label: "Repository key",
            error: errors.repositoryKey,
            hint: "Lowercase letters, digits, dots, dashes, underscores.",
          },
            h("input", {
              type: "text",
              "aria-label": "Repository key",
              className: `${inputClass} font-mono`,
              value: form.repositoryKey,
              onChange: (event: { target: { value: string } }) => setField("repositoryKey", event.target.value),
            })),
          h(FormRow, { label: "Connected host", error: errors.connectedHostId }, hostControl),
          h(FormRow, { label: "Repository root", error: errors.repositoryRoot },
            h("input", {
              type: "text",
              "aria-label": "Repository root",
              className: `${inputClass} font-mono`,
              value: form.repositoryRoot,
              placeholder: "/work/name",
              onChange: (event: { target: { value: string } }) => setField("repositoryRoot", event.target.value),
            })),
          h(FormRow, { label: "Checkout path", error: errors.checkoutPath },
            h("input", {
              type: "text",
              "aria-label": "Checkout path",
              className: `${inputClass} font-mono`,
              value: form.checkoutPath,
              placeholder: "e.g. /work/<name>-factory",
              onChange: (event: { target: { value: string } }) => setField("checkoutPath", event.target.value),
            })),
          h(FormRow, { label: "Project", error: errors.projectId }, projectControl),
          h(FormRow, { label: "Environment", error: errors.environmentId, hint: "Optional. Pin a pre-existing environment on the selected project; leave empty and bb registers one for the checkout path." },
            h("input", {
              type: "text",
              "aria-label": "Environment",
              className: `${inputClass} font-mono`,
              value: form.environmentId,
              placeholder: "env_...",
              onChange: (event: { target: { value: string } }) => setField("environmentId", event.target.value),
            })),
          h(FormRow, { label: "Main ref", error: errors.mainRef },
            h("input", {
              type: "text",
              "aria-label": "Main ref",
              className: `${inputClass} font-mono`,
              value: form.mainRef,
              onChange: (event: { target: { value: string } }) => setField("mainRef", event.target.value),
            })),
          h(FormRow, { label: "Dispatch" },
            h("label", { className: "flex items-center gap-2 text-sm" },
              h("input", {
                type: "checkbox",
                className: "h-4 w-4 rounded border-border",
                checked: form.dispatchPaused,
                onChange: (event: { target: { checked: boolean } }) => setField("dispatchPaused", event.target.checked),
              }),
              "Start paused"),
            h("p", { className: "mt-1 text-xs text-muted-foreground" },
              "New repositories start paused until you turn dispatch on."))),
        h("div", { key: "review", className: "mt-4 rounded-md bg-surface-recessed/40 p-3" },
          h("p", { className: labelClass }, "Review"),
          h("pre", { className: "mt-1 overflow-x-auto break-all font-mono text-xs text-muted-foreground" },
            JSON.stringify(reviewInput, null, 2))),
        submitError
          ? h("p", { key: "submit-error", className: "mt-3 text-sm text-destructive" }, submitError)
          : null,
        h("div", { key: "submit", className: "mt-4 flex items-center gap-2" },
          h(ActionButton, { label: "Add repository", variant: "primary", onClick: submit, busy: submitting })),
        h("p", { key: "note", className: "mt-2 text-xs text-muted-foreground" },
          "If the checkout has no plans/factory files yet, the entry is still created; scaffold them before the first run."),
        h(ConfirmDialog, {
          key: "confirm",
          open: confirmOpen,
          title: "Add repository",
          body: confirmBody,
          confirmLabel: "Add repository",
          busy: submitting,
          onConfirm: confirmAdd,
          onCancel: () => setConfirmOpen(false),
        }),
      ],
    }));
}
