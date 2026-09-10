import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  FactorySettings,
  FactorySettingsPatch,
  HealthProjection,
  ProviderPreference,
  SettingsProjection,
} from "../../contracts.js";
import { cronValid, describeCron, nextCronTimes } from "../../schedule/cron.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  Card,
  ConfirmDialog,
  CopyText,
  Field,
  StateChip,
  formatTimestamp,
} from "../primitives.js";

const h = createElement;

const inputClass =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelClass = "text-xs font-medium text-muted-foreground";

type DispatchMode = "enabled" | "paused";

/**
 * Local form draft: number fields stay as text so half-typed input is not
 * coerced. `scheduleCron` uses "" for unset (patch maps it to null).
 */
interface DraftShape {
  dispatchMode: DispatchMode;
  scheduleCron: string;
  timeZone: string;
  nightWindowEndHour: string;
  runtimeCapMinutes: string;
  minimumGapMinutes: string;
  concurrencyLimit: string;
  providerPreference: string;
}

type DraftKey = keyof DraftShape;

/** Server fieldErrors arrive under patch keys; map them back onto draft fields. */
const PATCH_KEY_TO_FIELD: Record<string, DraftKey> = {
  dispatchMode: "dispatchMode",
  scheduleCron: "scheduleCron",
  timeZone: "timeZone",
  nightWindowEndHour: "nightWindowEndHour",
  runtimeCapSeconds: "runtimeCapMinutes",
  minimumStartGapSeconds: "minimumGapMinutes",
  concurrencyLimit: "concurrencyLimit",
  providerPreference: "providerPreference",
};

function seedDraft(settings: FactorySettings): DraftShape {
  return {
    dispatchMode: settings.dispatchMode,
    scheduleCron: settings.scheduleCron ?? "",
    timeZone: settings.timeZone,
    nightWindowEndHour: String(settings.nightWindowEndHour),
    runtimeCapMinutes: String(settings.runtimeCapSeconds / 60),
    minimumGapMinutes: String(settings.minimumStartGapSeconds / 60),
    concurrencyLimit: String(settings.concurrencyLimit),
    providerPreference: settings.providerPreference ?? "alternate",
  };
}

function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

function timeZoneValid(timeZone: string): boolean {
  if (timeZone === "server-local") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface DraftAnalysis {
  readonly patch: FactorySettingsPatch;
  readonly dirty: ReadonlySet<DraftKey>;
  readonly errors: Readonly<Partial<Record<DraftKey, string>>>;
}

/** Compare draft against the stored settings, build the patch, collect inline errors. */
function analyzeDraft(draft: DraftShape, settings: FactorySettings): DraftAnalysis {
  const baseline = seedDraft(settings);
  const dirty = new Set<DraftKey>();
  const errors: Partial<Record<DraftKey, string>> = {};
  const patch: FactorySettingsPatch = {};

  for (const key of Object.keys(draft) as DraftKey[]) {
    if (draft[key] !== baseline[key]) dirty.add(key);
  }

  const cron = draft.scheduleCron.trim();
  if (cron !== "" && !cronValid(cron)) errors.scheduleCron = "Not a valid five-field cron";
  if (dirty.has("scheduleCron")) patch.scheduleCron = cron === "" ? null : cron;

  const timeZone = draft.timeZone.trim() || "server-local";
  if (!timeZoneValid(timeZone)) errors.timeZone = "Enter an IANA time zone or server-local.";
  if (dirty.has("timeZone") && errors.timeZone === undefined) patch.timeZone = timeZone;

  const endHour = parseInteger(draft.nightWindowEndHour);
  if (endHour === null || endHour > 23) {
    errors.nightWindowEndHour = "Enter a whole hour from 0 to 23.";
  } else if (dirty.has("nightWindowEndHour")) {
    patch.nightWindowEndHour = endHour;
  }

  const capMinutes = Number(draft.runtimeCapMinutes);
  const capSeconds = Number.isFinite(capMinutes) ? Math.round(capMinutes * 60) : null;
  if (capSeconds === null || capSeconds <= 0) {
    errors.runtimeCapMinutes = "Enter minutes greater than 0.";
  } else if (dirty.has("runtimeCapMinutes")) {
    patch.runtimeCapSeconds = capSeconds;
  }

  const gapMinutes = Number(draft.minimumGapMinutes);
  const gapSeconds = Number.isFinite(gapMinutes) ? Math.round(gapMinutes * 60) : null;
  if (gapSeconds === null || gapSeconds < 3600) {
    errors.minimumGapMinutes = "Enter at least 60 minutes.";
  } else if (dirty.has("minimumGapMinutes")) {
    patch.minimumStartGapSeconds = gapSeconds;
  }

  const concurrency = parseInteger(draft.concurrencyLimit);
  if (concurrency === null || concurrency < 1) {
    errors.concurrencyLimit = "Enter a whole number of at least 1.";
  } else if (dirty.has("concurrencyLimit")) {
    patch.concurrencyLimit = concurrency;
  }

  if (dirty.has("providerPreference")) {
    patch.providerPreference = draft.providerPreference as ProviderPreference;
  }

  return { patch, dirty, errors };
}

interface SaveState {
  readonly pending: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly fieldErrors: Partial<Record<DraftKey, string[]>>;
}

const IDLE_SAVE: SaveState = { pending: false, message: null, error: null, fieldErrors: {} };

/** Local label/control/error row: Field renders dt/dd, form rows need aria-labels. */
function FormRow(props: {
  label: string;
  children?: ReactNode;
  error?: string | null;
  warning?: string | null;
  hint?: ReactNode;
}) {
  return h("div", { className: "min-w-0" },
    h("span", { className: labelClass }, props.label),
    h("div", { className: "mt-1" }, props.children),
    props.error
      ? h("p", { className: "mt-1 text-xs text-destructive" }, props.error)
      : props.warning
        ? h("p", { className: "mt-1 text-xs text-warning" }, props.warning)
        : props.hint
          ? h("p", { className: "mt-1 text-xs text-muted-foreground" }, props.hint)
          : null);
}

function RepositoryCard(props: {
  ctx: ViewContext;
  projection: SettingsProjection;
  health: HealthProjection | null;
}) {
  const { ctx, projection, health } = props;
  const repository = ctx.repository;
  const [result, setResult] = useState<{ pending: boolean; message: string | null; error: string | null }>(
    { pending: false, message: null, error: null },
  );
  const repoPaused = ctx.dispatchPaused || projection.dispatch.repositoryPaused;
  const projectId = ctx.projectId ?? projection.settings.projectId ?? null;
  const environmentId = ctx.environmentId ?? projection.settings.environmentId ?? null;

  const toggle = () => {
    setResult({ pending: true, message: null, error: null });
    void ctx.updateRepository({ repositoryKey: repository.repositoryKey, dispatchPaused: !repoPaused }).then(
      (mutation) =>
        setResult(mutation.ok
          ? { pending: false, message: mutation.message, error: null }
          : { pending: false, message: null, error: mutation.error.message }),
      (error: unknown) =>
        setResult({ pending: false, message: null, error: error instanceof Error ? error.message : String(error) }),
    );
  };

  const copyField = (label: string, value: string) =>
    h(Field, { key: label, label }, h("dd", { className: "mt-0.5" }, h(CopyText, { value, mono: true })));

  const pathField = (label: string, value: string) =>
    h(Field, { key: label, label },
      h("dd", { className: "mt-0.5 break-all", style: { overflowWrap: "anywhere" } },
        h(CopyText, { value, mono: true })));

  const optionalField = (label: string, value: string | null) =>
    h(Field, { key: label, label },
      value
        ? h("dd", { className: "mt-0.5" }, h(CopyText, { value, mono: true }))
        : h("dd", { className: "mt-0.5 text-sm text-muted-foreground" }, "Not set"));

  return h(Card, {
    title: "Repository",
    children: [
      h("dl", { key: "fields", className: "grid gap-3 sm:grid-cols-2" },
        copyField("Repository key", repository.repositoryKey),
        pathField("Repository root", repository.repositoryRoot),
        pathField("Checkout path", repository.checkoutPath),
        copyField("Factory branch", repository.factoryBranch),
        copyField("Main ref", repository.mainRef),
        copyField("Connected host", repository.connectedHostId),
        h(Field, { key: "host", label: "Host status" },
          health
            ? h("dd", { className: "mt-0.5 flex flex-wrap items-center gap-2" },
                h(Badge, {
                  label: health.host.status,
                  tone: health.host.ok ? "success" : health.host.status === "offline" ? "danger" : "warning",
                }),
                !health.host.ok && health.host.reasons[0]
                  ? h("span", { className: "text-xs text-warning" }, health.host.reasons[0])
                  : null)
            : h("dd", { className: "mt-0.5 text-sm text-muted-foreground" }, "Health not loaded")),
        optionalField("Project", projectId),
        optionalField("Environment", environmentId)),
      h("div", { key: "dispatch", className: "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3" },
        h(StateChip, {
          on: !repoPaused,
          label: repoPaused ? "Dispatch paused for this repo" : "Dispatch active for this repo",
          title: "Stops new runs for this repository. Running runs continue.",
          onClick: toggle,
          disabled: result.pending,
        }),
        result.message ? h("span", { className: "text-xs text-success", role: "status" }, result.message) : null,
        result.error ? h("span", { className: "text-xs text-destructive" }, result.error) : null),
    ],
  });
}

function DispatchCard(props: {
  projection: SettingsProjection;
  health: HealthProjection | null;
  ctx: ViewContext;
}) {
  const { projection, health, ctx } = props;
  const settings = projection.settings;
  const [draft, setDraft] = useState<DraftShape>(() => seedDraft(settings));
  const [lastSaved, setLastSaved] = useState<DraftShape | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(IDLE_SAVE);

  // A reloaded projection becomes the baseline; saved-but-unreflected fields stay masked.
  useEffect(() => setLastSaved(null), [settings]);

  const analysis = useMemo(() => analyzeDraft(draft, settings), [draft, settings]);
  const dirtyFields = useMemo(
    () => new Set([...analysis.dirty].filter((key) => !(lastSaved && lastSaved[key] === draft[key]))),
    [analysis, lastSaved, draft],
  );
  const dirty = dirtyFields.size > 0;
  const dirtyHasError = [...dirtyFields].some((key) => analysis.errors[key] !== undefined);

  const setField = <K extends DraftKey>(key: K, value: DraftShape[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState((current) => ({ ...current, message: null, error: null }));
  };

  const fieldError = (key: DraftKey): string | null =>
    analysis.errors[key] ?? saveState.fieldErrors[key]?.join("; ") ?? null;

  const discard = () => {
    setDraft(seedDraft(settings));
    setLastSaved(null);
    setSaveState(IDLE_SAVE);
  };

  const save = () => {
    setSaveState({ pending: true, message: null, error: null, fieldErrors: {} });
    const savedDraft = draft;
    void ctx.updateSettings(analysis.patch).then(
      (mutation) => {
        if (mutation.ok) {
          setLastSaved(savedDraft);
          setSaveState({ pending: false, message: mutation.message, error: null, fieldErrors: {} });
          return;
        }
        const fieldErrors: Partial<Record<DraftKey, string[]>> = {};
        for (const [key, messages] of Object.entries(mutation.error.fieldErrors ?? {})) {
          const field = PATCH_KEY_TO_FIELD[key] as DraftKey | undefined;
          if (field) fieldErrors[field] = messages;
        }
        setSaveState({ pending: false, message: null, error: mutation.error.message, fieldErrors });
      },
      (error: unknown) =>
        setSaveState({
          pending: false,
          message: null,
          error: error instanceof Error ? error.message : String(error),
          fieldErrors: {},
        }),
    );
  };

  const cron = draft.scheduleCron.trim();
  const timeZone = draft.timeZone.trim() || "server-local";
  const schedulePreview = useMemo(() => {
    if (cron === "") return { kind: "manual" as const };
    if (!cronValid(cron)) return { kind: "invalid" as const };
    const description = describeCron(cron);
    const times = timeZoneValid(timeZone) ? nextCronTimes(cron, timeZone, 3) : [];
    return { kind: "ok" as const, description, times };
  }, [cron, timeZone]);

  const providers = health?.providers ?? [];
  const preferred = draft.providerPreference !== "alternate"
    ? providers.find((provider) => provider.providerId === draft.providerPreference) ?? null
    : null;
  const concurrencyWarning = preferred?.availability === "limited" && Number(draft.concurrencyLimit) > 1
    ? "The preferred provider is limited; >1 may still serialize"
    : null;
  const providerWarning = preferred && preferred.availability !== "available"
    ? `Preferred provider is ${preferred.availability}${preferred.lastError ? `: ${preferred.lastError}` : ""}.`
    : null;

  const providerOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "alternate", label: "alternate (rotate providers)" },
    ];
    const seen = new Set<string>(["alternate"]);
    for (const provider of providers) {
      if (seen.has(provider.providerId)) continue;
      seen.add(provider.providerId);
      options.push({ value: provider.providerId, label: `${provider.providerId} (${provider.availability})` });
    }
    if (draft.providerPreference !== "alternate" && !seen.has(draft.providerPreference)) {
      options.push({ value: draft.providerPreference, label: `${draft.providerPreference} (not reported)` });
    }
    return options;
  }, [providers, draft.providerPreference]);

  const previewBlock = schedulePreview.kind === "manual"
    ? h("p", { className: "mt-1.5 text-xs text-muted-foreground" }, "Manual only: no scheduled runs.")
    : schedulePreview.kind === "ok"
      ? h("div", { className: "mt-1.5 space-y-0.5 text-xs text-muted-foreground" },
          h("p", null, schedulePreview.description ?? "Custom schedule"),
          schedulePreview.times.length > 0
            ? h("p", null,
                `Next: ${schedulePreview.times.map((time) => formatTimestamp(time.toISOString()) ?? time.toISOString()).join(", ")}`,
                timeZone !== "server-local" ? ` (${timeZone})` : "")
            : h("p", null, "No fire times within 14 days."))
      : null;

  const validationIssues = Object.entries(projection.validation.fieldErrors);

  return h(Card, {
    title: "Dispatch",
    actions: h(Badge, {
      label: projection.dispatch.mode === "enabled" ? "Enabled" : "Paused",
      tone: projection.dispatch.mode === "enabled" ? "success" : "warning",
      title: projection.dispatch.reason ?? undefined,
    }),
    children: [
      !projection.validation.valid && validationIssues.length > 0
        ? h("div", {
            key: "validation",
            className: "mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning",
          },
            `Stored settings have validation issues: ${validationIssues.map(([key, messages]) => `${key} (${messages.join("; ")})`).join(", ")}`)
        : null,
      h("div", { key: "form", className: "grid gap-4 sm:grid-cols-2" },
        h(FormRow, { label: "Dispatch mode" },
          h("div", {
            className: "inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1",
            role: "group",
            "aria-label": "Dispatch mode",
          },
            (["enabled", "paused"] as const).map((mode) =>
              h("button", {
                key: mode,
                type: "button",
                "aria-pressed": draft.dispatchMode === mode,
                className: `rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  draft.dispatchMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`,
                onClick: () => setField("dispatchMode", mode),
              }, mode === "enabled" ? "Enabled" : "Paused")))),
        h(FormRow, { label: "Schedule", error: fieldError("scheduleCron") },
          h("input", {
            type: "text",
            "aria-label": "Schedule",
            className: `${inputClass} font-mono`,
            value: draft.scheduleCron,
            placeholder: "* * * * *",
            onChange: (event: { target: { value: string } }) => setField("scheduleCron", event.target.value),
          }),
          h("div", { className: "mt-1.5 flex flex-wrap items-center gap-1" },
            h("span", { className: "text-xs text-muted-foreground" }, "Presets:"),
            h(ActionButton, { label: "Nightly", variant: "ghost", size: "xs", onClick: () => setField("scheduleCron", "*/10 1-5 * * *") }),
            h(ActionButton, { label: "Hourly", variant: "ghost", size: "xs", onClick: () => setField("scheduleCron", "0 * * * *") }),
            h(ActionButton, { label: "Manual only", variant: "ghost", size: "xs", onClick: () => setField("scheduleCron", "") })),
          previewBlock),
        h(FormRow, { label: "Time zone", error: fieldError("timeZone"), hint: "Use an IANA name like America/New_York, or server-local." },
          h("input", {
            type: "text",
            "aria-label": "Time zone",
            className: inputClass,
            value: draft.timeZone,
            onChange: (event: { target: { value: string } }) => setField("timeZone", event.target.value),
          })),
        h(FormRow, { label: "Night-window end hour", error: fieldError("nightWindowEndHour"), hint: "Hour 0 to 23 in the configured time zone." },
          h("input", {
            type: "number",
            "aria-label": "Night-window end hour",
            className: inputClass,
            min: 0,
            max: 23,
            value: draft.nightWindowEndHour,
            onChange: (event: { target: { value: string } }) => setField("nightWindowEndHour", event.target.value),
          })),
        h(FormRow, { label: "Runtime cap (minutes)", error: fieldError("runtimeCapMinutes"), hint: "Stored as seconds; minimum 1 minute." },
          h("input", {
            type: "number",
            "aria-label": "Runtime cap (minutes)",
            className: inputClass,
            min: 1,
            value: draft.runtimeCapMinutes,
            onChange: (event: { target: { value: string } }) => setField("runtimeCapMinutes", event.target.value),
          })),
        h(FormRow, { label: "Minimum start gap (minutes)", error: fieldError("minimumGapMinutes"), hint: "Minimum 60 minutes." },
          h("input", {
            type: "number",
            "aria-label": "Minimum start gap (minutes)",
            className: inputClass,
            min: 60,
            value: draft.minimumGapMinutes,
            onChange: (event: { target: { value: string } }) => setField("minimumGapMinutes", event.target.value),
          })),
        h(FormRow, { label: "Concurrency limit", error: fieldError("concurrencyLimit"), warning: concurrencyWarning },
          h("input", {
            type: "number",
            "aria-label": "Concurrency limit",
            className: inputClass,
            min: 1,
            value: draft.concurrencyLimit,
            onChange: (event: { target: { value: string } }) => setField("concurrencyLimit", event.target.value),
          })),
        h(FormRow, { label: "Provider preference", error: fieldError("providerPreference"), warning: providerWarning },
          h("select", {
            "aria-label": "Provider preference",
            className: inputClass,
            value: draft.providerPreference,
            onChange: (event: { target: { value: string } }) => setField("providerPreference", event.target.value),
          },
            providerOptions.map((option) =>
              h("option", { key: option.value, value: option.value }, option.label))))),
      saveState.message
        ? h("p", { key: "saved", className: "mt-3 text-sm text-success", role: "status" }, saveState.message)
        : null,
      saveState.error
        ? h("p", { key: "save-error", className: "mt-3 text-sm text-destructive" }, saveState.error)
        : null,
      dirty
        ? h("div", {
            key: "dirty-bar",
            className: "sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3",
          },
            h("span", { className: "text-sm font-medium text-warning" }, "Unsaved changes"),
            h("div", { className: "ml-auto flex items-center gap-2" },
              h(ActionButton, { label: "Discard", variant: "secondary", onClick: discard, disabled: saveState.pending }),
              h(ActionButton, {
                label: "Save",
                variant: "primary",
                onClick: () => setConfirmOpen(true),
                disabled: dirtyHasError,
                busy: saveState.pending,
              })))
        : null,
      h(ConfirmDialog, {
        key: "confirm",
        open: confirmOpen,
        title: "Save settings",
        body: `Applies to ${ctx.repository.repositoryKey} on the next dispatch cycle. A run in progress is not affected.`,
        confirmLabel: "Save",
        busy: saveState.pending,
        onConfirm: () => {
          setConfirmOpen(false);
          save();
        },
        onCancel: () => setConfirmOpen(false),
      }),
    ],
  });
}

export function SettingsView(props: {
  projection: SettingsProjection;
  health: HealthProjection | null;
  ctx: ViewContext;
}): ReactNode {
  return h("div", { className: "space-y-4" },
    h(RepositoryCard, { ctx: props.ctx, projection: props.projection, health: props.health }),
    h(DispatchCard, { projection: props.projection, health: props.health, ctx: props.ctx }));
}
