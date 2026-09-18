import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  reasoningLevelSchema,
  type FactorySettings,
  type FactorySettingsPatch,
  type HealthProjection,
  type ProviderId,
  type ProviderModelDefault,
  type ProviderModelDefaults,
  type ProviderPreference,
  type ReasoningLevel,
  type SettingsProjection,
} from "../../contracts.js";
import { cronValid, nextCronTimes } from "../../schedule/cron.js";
import { describeSchedule } from "../../schedule/describe.js";
import { hasFullPermission } from "../../provider-status.js";
import { repositoryLabel } from "../../repository-label.js";
import { ProviderModelPicker, pickerRoutingFor, type PickerValue } from "../providerPicker.js";
import type { ViewContext } from "../context.js";
import {
  ActionButton,
  Badge,
  Card,
  ConfirmDialog,
  CopyText,
  Disclosure,
  Field,
  formatTimestamp,
} from "../primitives.js";

const h = createElement;

const inputClass =
  "w-full box-border rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelClass = "text-xs font-medium text-muted-foreground";

type DispatchMode = "enabled" | "paused";

/**
 * Local form draft: number fields stay as text so half-typed input is not
 * coerced. `scheduleCron` uses "" for unset (patch maps it to null).
 * `providerModelDefaults` carries the whole stored map so the wholesale-replace
 * patch preserves entries for providers other than the pinned one.
 * `providerRotation` carries the ordered list; an empty list patches null.
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
  providerModelDefaults: ProviderModelDefaults;
  providerRotation: ProviderId[];
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
  providerModelDefaults: "providerModelDefaults",
  providerRotation: "providerRotation",
};

/** Shared empty map keeps untouched drafts at the stored reference. */
const NO_PROVIDER_DEFAULTS: ProviderModelDefaults = {};

/**
 * A settings reload re-parses the stored map into a fresh object, so dirty
 * tracking compares entries by value rather than reference.
 */
function sameProviderModelDefaults(a: ProviderModelDefaults, b: ProviderModelDefaults): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => a[key]!.model === b[key]?.model && a[key]!.reasoningLevel === b[key]?.reasoningLevel);
}

/** Ordered list: position matters, so compare element by element. */
function sameProviderRotation(a: readonly ProviderId[], b: readonly ProviderId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

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
    providerModelDefaults: settings.providerModelDefaults ?? NO_PROVIDER_DEFAULTS,
    providerRotation: settings.providerRotation ?? [],
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
    const unchanged = key === "providerModelDefaults"
      ? sameProviderModelDefaults(draft.providerModelDefaults, baseline.providerModelDefaults)
      : key === "providerRotation"
        ? sameProviderRotation(draft.providerRotation, baseline.providerRotation)
        : draft[key] === baseline[key];
    if (!unchanged) dirty.add(key);
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

  // Only the pinned provider's entry is editable, so only it can hold a blank
  // model. Validating the whole map would block Save on a row that is not on
  // screen once the preference moves to alternate; stale blanks still fail
  // server-side if they reach the patch.
  const editableProviderDefault = draft.providerPreference === "alternate"
    ? undefined
    : draft.providerModelDefaults[draft.providerPreference];
  if (editableProviderDefault !== undefined && editableProviderDefault.model.trim() === "") {
    errors.providerModelDefaults = "Enter a model name.";
  } else if (dirty.has("providerModelDefaults")) {
    patch.providerModelDefaults = Object.keys(draft.providerModelDefaults).length === 0
      ? null
      : draft.providerModelDefaults;
  }

  // An empty list is the cleared state (patch null); a single member cannot
  // form a rotation, and the schema caps the list at five.
  if (dirty.has("providerRotation")) {
    if (draft.providerRotation.length === 0) {
      patch.providerRotation = null;
    } else if (draft.providerRotation.length < 2) {
      errors.providerRotation = "Use at least 2 providers, or remove the last one to clear the rotation.";
    } else if (draft.providerRotation.length > 5) {
      // Defensive: stored lists are schema-capped at 5 and the editor never adds past it.
      errors.providerRotation = "Use at most 5 providers.";
    } else {
      patch.providerRotation = [...draft.providerRotation];
    }
  }

  if (dirty.has("dispatchMode")) {
    patch.dispatchMode = draft.dispatchMode;
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
  status?: ReactNode;
}) {
  return h("div", { className: "min-w-0" },
    h("div", { className: "flex items-baseline gap-2" },
      h("span", { className: labelClass }, props.label),
      props.status ?? null),
    h("div", { className: "mt-1" }, props.children),
    props.error
      ? h("p", { className: "mt-1 text-xs text-destructive" }, props.error)
      : props.warning
        ? h("p", { className: "mt-1 text-xs text-warning-text" }, props.warning)
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
  const [displayNameDraft, setDisplayNameDraft] = useState(ctx.displayName ?? "");
  const [savedDisplayName, setSavedDisplayName] = useState(ctx.displayName ?? "");
  const [displayNameResult, setDisplayNameResult] = useState<{
    pending: boolean;
    message: string | null;
    error: string | null;
  }>({ pending: false, message: null, error: null });
  const repoPaused = ctx.dispatchPaused || projection.dispatch.repositoryPaused;
  const projectId = ctx.projectId ?? projection.settings.projectId ?? null;
  const environmentId = ctx.environmentId ?? projection.settings.environmentId ?? null;

  useEffect(() => {
    setDisplayNameDraft(ctx.displayName ?? "");
    setSavedDisplayName(ctx.displayName ?? "");
  }, [ctx.displayName, repository.repositoryKey]);

  const displayNameValidationError = displayNameDraft.trim().length > 64
    ? "Use 64 characters or fewer"
    : null;

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

  const saveDisplayName = () => {
    const normalized = displayNameDraft.trim();
    if (displayNameValidationError) {
      setDisplayNameResult({ pending: false, message: null, error: displayNameValidationError });
      return;
    }
    setDisplayNameResult({ pending: true, message: null, error: null });
    void ctx.updateRepository({
      repositoryKey: repository.repositoryKey,
      displayName: normalized === "" ? null : normalized,
    }).then(
      (mutation) => {
        if (mutation.ok) {
          setDisplayNameDraft(normalized);
          setSavedDisplayName(normalized);
          setDisplayNameResult({ pending: false, message: mutation.message, error: null });
        } else {
          setDisplayNameResult({ pending: false, message: null, error: mutation.error.message });
        }
      },
      (error: unknown) => setDisplayNameResult({
        pending: false,
        message: null,
        error: error instanceof Error ? error.message : String(error),
      }),
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
      h("dl", { key: "status", className: "grid gap-3 sm:grid-cols-2" },
        h(Field, { key: "host", label: "Host status" },
          health
            ? h("dd", { className: "mt-0.5 flex flex-wrap items-center gap-2" },
                h(Badge, {
                  label: health.host.status,
                  tone: health.host.ok ? "success" : health.host.status === "offline" ? "danger" : "warning",
                }),
                !health.host.ok && health.host.reasons[0]
                  ? h("span", { className: "text-xs text-warning-text" }, health.host.reasons[0])
                  : null)
            : h("dd", { className: "mt-0.5 text-sm text-muted-foreground" }, "Health not loaded"))),
      h("div", { key: "dispatch", className: "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3" },
        h("span", { className: "text-xs text-muted-foreground" },
          repoPaused ? "Repository dispatch is paused." : "Repository dispatch is active."),
        h(ActionButton, {
          label: repoPaused ? "Resume repository dispatch" : "Pause repository dispatch",
          variant: "secondary",
          size: "xs",
          busy: result.pending,
          title: repoPaused
            ? "Resumes new runs for this repository. Global dispatch pauses still apply."
            : "Stops new runs for this repository. Running runs continue.",
          onClick: toggle,
        }),
        result.message ? h("span", { className: "text-xs text-success-foreground", role: "status" }, result.message) : null,
        result.error ? h("span", { className: "text-xs text-destructive" }, result.error) : null),
      h("div", { key: "display-name", className: "mt-3 border-t border-border pt-3" },
        h("label", { className: labelClass, htmlFor: "repository-display-name" }, "Display name"),
        h("div", { className: "mt-1 flex flex-wrap items-center gap-2" },
          h("input", {
            id: "repository-display-name",
            type: "text",
            maxLength: 64,
            className: `${inputClass} min-w-[12rem] flex-1`,
            value: displayNameDraft,
            onChange: (event: { target: { value: string } }) => {
              setDisplayNameDraft(event.target.value);
              setDisplayNameResult((current) => ({ ...current, message: null, error: null }));
            },
          }),
          h(ActionButton, {
            label: "Save display name",
            variant: "secondary",
            size: "xs",
            busy: displayNameResult.pending,
            disabled: displayNameDraft === savedDisplayName || displayNameValidationError !== null,
            onClick: saveDisplayName,
          })),
        h("p", { className: "mt-1 text-xs text-muted-foreground" }, "Optional friendly name shown in the Factory UI. The repository key remains the technical identity."),
        displayNameValidationError
          ? h("p", { className: "mt-1 text-xs text-destructive", role: "alert" }, displayNameValidationError)
          : null,
        displayNameResult.message
          ? h("p", { className: "mt-1 text-xs text-success-foreground", role: "status" }, displayNameResult.message)
          : null,
        displayNameResult.error
          ? h("p", { className: "mt-1 text-xs text-destructive" }, displayNameResult.error)
          : null),
      h(Disclosure, {
        key: "details",
        summary: "Repository details",
        className: "mt-3 border-t border-border pt-3",
        children: h("dl", { className: "grid gap-3 sm:grid-cols-2" },
          copyField("Repository key", repository.repositoryKey),
          pathField("Repository root", repository.repositoryRoot),
          pathField("Checkout path", repository.checkoutPath),
          copyField("Factory branch", repository.factoryBranch),
          copyField("Main ref", repository.mainRef),
          copyField("Connected host", repository.connectedHostId),
          optionalField("Project", projectId),
          optionalField("Environment", environmentId)),
      }),
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
  const [savingFields, setSavingFields] = useState<ReadonlySet<DraftKey>>(new Set());
  const [savedFields, setSavedFields] = useState<ReadonlySet<DraftKey>>(new Set());

  // A reloaded projection becomes the baseline; saved-but-unreflected fields
  // stay masked. A same-repository refresh keeps the Saved marks (they end on
  // the 1500ms timer or the next edit); a different repository resets the form.
  const formRepositoryKey = useRef(settings.repositoryKey ?? ctx.repository.repositoryKey);
  useEffect(() => {
    const key = settings.repositoryKey ?? ctx.repository.repositoryKey;
    if (key === formRepositoryKey.current) {
      setLastSaved(null);
      return;
    }
    formRepositoryKey.current = key;
    setDraft(seedDraft(settings));
    setLastSaved(null);
    setSavedFields(new Set());
    setSavingFields(new Set());
    setSaveState(IDLE_SAVE);
  }, [settings, ctx.repository.repositoryKey]);

  // The Saved mark is brief on purpose: 1500ms, cleared on unmount by the effect cleanup.
  useEffect(() => {
    if (savedFields.size === 0) return;
    const timer = setTimeout(() => setSavedFields(new Set()), 1500);
    return () => clearTimeout(timer);
  }, [savedFields]);

  const analysis = useMemo(() => analyzeDraft(draft, settings), [draft, settings]);
  const dirtyFields = useMemo(
    () => new Set([...analysis.dirty].filter((key) => {
      if (lastSaved === null) return true;
      return key === "providerModelDefaults"
        ? !sameProviderModelDefaults(lastSaved.providerModelDefaults, draft.providerModelDefaults)
        : key === "providerRotation"
          ? !sameProviderRotation(lastSaved.providerRotation, draft.providerRotation)
          : lastSaved[key] !== draft[key];
    })),
    [analysis, lastSaved, draft],
  );
  const dirty = dirtyFields.size > 0;
  const dirtyHasError = [...dirtyFields].some((key) => analysis.errors[key] !== undefined);

  const setField = <K extends DraftKey>(key: K, update: DraftShape[K] | ((current: DraftShape[K]) => DraftShape[K])) => {
    setDraft((current) => ({
      ...current,
      [key]: typeof update === "function" ? (update as (current: DraftShape[K]) => DraftShape[K])(current[key]) : update,
    }));
    setSavedFields((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setSaveState((current) => {
      if (!current.fieldErrors[key]) return { ...current, message: null, error: null };
      const fieldErrors = { ...current.fieldErrors };
      delete fieldErrors[key];
      return { ...current, message: null, error: null, fieldErrors };
    });
  };

  const fieldStatus = (key: DraftKey): ReactNode =>
    savingFields.has(key)
      ? h("span", { className: "text-xs text-muted-foreground" }, "Saving...")
      : savedFields.has(key)
        ? h("span", { className: "text-xs text-success-foreground", role: "status" }, "Saved")
        : null;

  const fieldError = (key: DraftKey): string | null =>
    analysis.errors[key] ?? saveState.fieldErrors[key]?.join("; ") ?? null;

  const discard = () => {
    setDraft(seedDraft(settings));
    setLastSaved(null);
    setSavedFields(new Set());
    setSaveState(IDLE_SAVE);
  };

  const save = () => {
    const fields = new Set(
      Object.keys(analysis.patch)
        .map((key) => PATCH_KEY_TO_FIELD[key] as DraftKey | undefined)
        .filter((key): key is DraftKey => key !== undefined),
    );
    setSavingFields(fields);
    setSaveState({ pending: true, message: null, error: null, fieldErrors: {} });
    const savedDraft = draft;
    void ctx.updateSettings(analysis.patch).then(
      (mutation) => {
        setSavingFields(new Set());
        if (mutation.ok) {
          setLastSaved(savedDraft);
          setSavedFields(fields);
          setSaveState({ pending: false, message: mutation.message, error: null, fieldErrors: {} });
          return;
        }
        const fieldErrors: Partial<Record<DraftKey, string[]>> = {};
        for (const [key, messages] of Object.entries(mutation.error.fieldErrors ?? {})) {
          // Server issues arrive as dotted paths ("providerModelDefaults.codex.model").
          const field = PATCH_KEY_TO_FIELD[key.split(".")[0] ?? key] as DraftKey | undefined;
          if (field) fieldErrors[field] = [...(fieldErrors[field] ?? []), ...messages];
        }
        setSaveState({ pending: false, message: null, error: mutation.error.message, fieldErrors });
      },
      (error: unknown) => {
        setSavingFields(new Set());
        setSaveState({
          pending: false,
          message: null,
          error: error instanceof Error ? error.message : String(error),
          fieldErrors: {},
        });
      },
    );
  };

  const cron = draft.scheduleCron.trim();
  const timeZone = draft.timeZone.trim() || "server-local";
  const schedulePreview = useMemo(() => {
    if (cron === "") return { kind: "manual" as const };
    if (!cronValid(cron)) return { kind: "invalid" as const };
    const description = describeSchedule(cron);
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
    ? `Preferred provider is ${preferred.availability}${preferred.lastError ? `: ${preferred.lastError.replace(/\.+$/u, "")}` : ""}.`
    : null;

  const providerOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "alternate", label: "alternate (rotate providers)" },
    ];
    const seen = new Set<string>(["alternate"]);
    for (const provider of providers) {
      if (seen.has(provider.providerId)) continue;
      seen.add(provider.providerId);
      const full = hasFullPermission(provider);
      options.push({
        value: provider.providerId,
        label: `${provider.providerId} (${provider.availability}${full ? "" : ", lacks full permission"})`,
      });
    }
    if (draft.providerPreference !== "alternate" && !seen.has(draft.providerPreference)) {
      options.push({ value: draft.providerPreference, label: `${draft.providerPreference} (not reported)` });
    }
    return options;
  }, [providers, draft.providerPreference]);

  // The pinned provider can carry a configured model/thinking default. The
  // draft holds the whole map; the control edits only this provider's entry.
  const pinnedProviderId = draft.providerPreference === "alternate" ? null : draft.providerPreference;
  const storedDefault = pinnedProviderId === null ? undefined : draft.providerModelDefaults[pinnedProviderId];
  const providerDefaultsSaving = savingFields.has("providerModelDefaults");
  const updateProviderDefault = (entry: ProviderModelDefault | null) => {
    if (pinnedProviderId === null) return;
    setField("providerModelDefaults", (current) => {
      const next: ProviderModelDefaults = { ...current };
      if (entry === null) {
        delete next[pinnedProviderId];
      } else {
        next[pinnedProviderId] = entry;
      }
      return next;
    });
  };
  const resetToHostDefault = h(ActionButton, {
    label: "Use host default",
    variant: "ghost",
    size: "xs",
    disabled: providerDefaultsSaving,
    onClick: () => updateProviderDefault(null),
  });

  const providerDefaultControl = (() => {
    if (pinnedProviderId === null) return null;
    if (preferred === null) {
      // The host no longer reports the pinned provider: show a stored default
      // tolerantly (the "(not reported)" precedent) and allow clearing it.
      return storedDefault === undefined
        ? h("p", { className: "text-xs text-muted-foreground" },
            "The host does not report this provider, so its catalog is unknown.")
        : h("div", { className: "flex flex-wrap items-center gap-2" },
            h("code", { className: "text-sm" }, `${storedDefault.model} · ${storedDefault.reasoningLevel}`),
            h("span", { className: "text-xs text-muted-foreground" }, "(provider not reported)"),
            resetToHostDefault);
    }
    if (ProviderModelPicker !== undefined && preferred.model !== "unavailable") {
      return h("div", { className: "flex flex-wrap items-center gap-2" },
        h(ProviderModelPicker, {
          value: {
            providerId: preferred.providerId,
            model: storedDefault?.model ?? preferred.model,
            reasoningLevel: storedDefault?.reasoningLevel ?? preferred.reasoningLevel,
          },
          onChange: (next: PickerValue) =>
            updateProviderDefault({ model: next.model, reasoningLevel: next.reasoningLevel }),
          routing: pickerRoutingFor(ctx),
          allowProviderChange: false,
          disabled: providerDefaultsSaving,
        }),
        storedDefault === undefined ? null : resetToHostDefault);
    }
    // Hosts without the bound picker fall back to a model input plus the
    // fixed thinking-level list.
    const hostModel = preferred.model === "unavailable" ? "" : preferred.model;
    return h("div", { className: "flex flex-wrap items-center gap-2" },
      h("input", {
        type: "text",
        "aria-label": "Default model",
        className: `${inputClass} min-w-[10rem] flex-1`,
        placeholder: hostModel === "" ? "model name" : hostModel,
        value: storedDefault?.model ?? "",
        disabled: providerDefaultsSaving,
        onChange: (event: { target: { value: string } }) =>
          updateProviderDefault({
            model: event.target.value,
            reasoningLevel: storedDefault?.reasoningLevel ?? preferred.reasoningLevel,
          }),
      }),
      h("select", {
        "aria-label": "Default thinking level",
        className: `${inputClass} w-auto`,
        value: storedDefault?.reasoningLevel ?? preferred.reasoningLevel,
        disabled: providerDefaultsSaving,
        onChange: (event: { target: { value: string } }) =>
          updateProviderDefault({
            model: storedDefault?.model ?? hostModel,
            reasoningLevel: event.target.value as ReasoningLevel,
          }),
      },
        reasoningLevelSchema.options.map((level) =>
          h("option", { key: level, value: level }, level))),
      storedDefault === undefined ? null : resetToHostDefault);
  })();

  // The rotation editor only exists while the preference alternates. The draft
  // holds the ordered id list; stored ids the catalog no longer reports stay
  // listed (and removable) with a "(not reported)" marker.
  const rotationSaving = savingFields.has("providerRotation");
  const rotationIds = draft.providerRotation;
  const moveRotation = (from: number, to: number) =>
    setField("providerRotation", (current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  const rotationAddable = (() => {
    const seen = new Set<string>(rotationIds);
    return providers.filter((provider) => {
      if (seen.has(provider.providerId)) return false;
      seen.add(provider.providerId);
      return true;
    });
  })();
  const rotationEditor = h("div", null,
    rotationIds.length === 0
      ? h("p", { className: "text-xs text-muted-foreground" },
          "No rotation set: dispatch rotates across every reported provider.")
      : h("ul", { className: "space-y-1.5" },
          rotationIds.map((id, index) => {
            const reported = providers.find((provider) => provider.providerId === id);
            const memberDefault = draft.providerModelDefaults[id];
            return h("li", { key: id, className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
              h("span", { className: "w-4 text-xs text-muted-foreground" }, `${index + 1}.`),
              h("code", { className: "text-sm" }, id),
              reported === undefined
                ? h("span", { className: "text-xs text-muted-foreground" }, "(not reported)")
                : h("span", { className: "text-xs text-muted-foreground" }, reported.availability),
              memberDefault === undefined
                ? null
                : h("span", { className: "text-xs text-muted-foreground" },
                    `${memberDefault.model} · ${memberDefault.reasoningLevel}`),
              h("span", { className: "ml-auto flex items-center gap-1" },
                h(ActionButton, {
                  label: "Up",
                  ariaLabel: `Move ${id} up`,
                  variant: "ghost",
                  size: "xs",
                  disabled: rotationSaving || index === 0,
                  onClick: () => moveRotation(index, index - 1),
                }),
                h(ActionButton, {
                  label: "Down",
                  ariaLabel: `Move ${id} down`,
                  variant: "ghost",
                  size: "xs",
                  disabled: rotationSaving || index === rotationIds.length - 1,
                  onClick: () => moveRotation(index, index + 1),
                }),
                h(ActionButton, {
                  label: "Remove",
                  ariaLabel: `Remove ${id} from rotation`,
                  variant: "ghost",
                  size: "xs",
                  disabled: rotationSaving,
                  onClick: () =>
                    setField("providerRotation", (current) => current.filter((member) => member !== id)),
                })));
          })),
    h("div", { className: "mt-2 flex flex-wrap items-center gap-2" },
      h("select", {
        "aria-label": "Add provider to rotation",
        className: `${inputClass} w-auto`,
        value: "",
        disabled: rotationSaving || rotationIds.length >= 5 || rotationAddable.length === 0,
        onChange: (event: { target: { value: string } }) => {
          const id = event.target.value;
          if (id === "") return;
          setField("providerRotation", (current) =>
            current.includes(id) || current.length >= 5 ? current : [...current, id]);
        },
      },
        h("option", { value: "" },
          rotationIds.length >= 5
            ? "Rotation is full (5)"
            : rotationAddable.length === 0
              ? "No more reported providers"
              : "Add provider..."),
        rotationAddable.map((provider) =>
          h("option", { key: provider.providerId, value: provider.providerId },
            `${provider.providerId} (${provider.availability}${hasFullPermission(provider) ? "" : ", lacks full permission"})`))),
      rotationIds.length === 0
        ? null
        : h(ActionButton, {
            label: "Clear rotation",
            variant: "ghost",
            size: "xs",
            disabled: rotationSaving,
            title: "Removes every member; saving clears the stored rotation.",
            onClick: () => setField("providerRotation", []),
          })));

  const previewBlock = schedulePreview.kind === "manual"
    ? h("p", { className: "mt-1.5 text-xs text-muted-foreground" }, "Manual only: no scheduled runs.")
    : schedulePreview.kind === "ok"
      ? h("div", { className: "mt-1.5 space-y-0.5 text-xs text-muted-foreground" },
          h("p", null, schedulePreview.description ?? h("code", { className: "font-mono" }, cron)),
          schedulePreview.times.length > 0
            ? h("p", null,
                `Next: ${schedulePreview.times.map((time) => formatTimestamp(time.toISOString()) ?? time.toISOString()).join(", ")}`,
                timeZone !== "server-local" ? ` (${timeZone})` : "")
            : h("p", null, "No fire times within 14 days."))
      : null;

  const validationIssues = Object.entries(projection.validation.fieldErrors);

  return h(Card, {
    title: "Global dispatch",
    actions: h(Badge, {
      label: projection.dispatch.mode === "enabled" ? "Enabled" : "Paused",
      tone: projection.dispatch.mode === "enabled" ? "success" : "warning",
      title: projection.dispatch.reason ?? undefined,
    }),
    children: [
      !projection.validation.valid && validationIssues.length > 0
        ? h("div", {
            key: "validation",
            className: "mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-text",
          },
            `Stored settings have validation issues: ${validationIssues.map(([key, messages]) => `${key} (${messages.join("; ")})`).join(", ")}`)
        : null,
      h("div", { key: "form", className: "grid gap-4 sm:grid-cols-2" },
        h(FormRow, { label: "Global dispatch mode", status: fieldStatus("dispatchMode") },
          h("div", {
            className: "inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1",
            role: "group",
            "aria-label": "Global dispatch mode",
          },
            (["enabled", "paused"] as const).map((mode) =>
              h("button", {
                key: mode,
                type: "button",
                "aria-pressed": draft.dispatchMode === mode,
                disabled: savingFields.has("dispatchMode"),
                className: `rounded-md px-3 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                  draft.dispatchMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`,
                onClick: () => setField("dispatchMode", mode),
              }, mode === "enabled" ? "Enabled" : "Paused")))),
        h(FormRow, { label: "Schedule", error: fieldError("scheduleCron"), status: fieldStatus("scheduleCron") },
          h("input", {
            type: "text",
            "aria-label": "Schedule",
            className: `${inputClass} font-mono`,
            value: draft.scheduleCron,
            placeholder: "* * * * *",
            disabled: savingFields.has("scheduleCron"),
            onChange: (event: { target: { value: string } }) => setField("scheduleCron", event.target.value),
          }),
          h("div", { className: "mt-1.5 flex flex-wrap items-center gap-1" },
            h("span", { className: "text-xs text-muted-foreground" }, "Presets:"),
            h(ActionButton, { label: "Nightly", variant: "ghost", size: "xs", disabled: savingFields.has("scheduleCron"), onClick: () => setField("scheduleCron", "*/10 1-5 * * *") }),
            h(ActionButton, { label: "Hourly", variant: "ghost", size: "xs", disabled: savingFields.has("scheduleCron"), onClick: () => setField("scheduleCron", "0 * * * *") }),
            h(ActionButton, { label: "Manual only", variant: "ghost", size: "xs", disabled: savingFields.has("scheduleCron"), onClick: () => setField("scheduleCron", "") })),
          previewBlock),
        h(FormRow, { label: "Time zone", error: fieldError("timeZone"), status: fieldStatus("timeZone"), hint: "Use an IANA name like America/New_York, or server-local." },
          h("input", {
            type: "text",
            "aria-label": "Time zone",
            className: inputClass,
            value: draft.timeZone,
            disabled: savingFields.has("timeZone"),
            onChange: (event: { target: { value: string } }) => setField("timeZone", event.target.value),
          })),
        h(FormRow, { label: "Night-window end hour", error: fieldError("nightWindowEndHour"), status: fieldStatus("nightWindowEndHour"), hint: "Hour 0 to 23 in the configured time zone." },
          h("input", {
            type: "number",
            "aria-label": "Night-window end hour",
            className: inputClass,
            min: 0,
            max: 23,
            value: draft.nightWindowEndHour,
            disabled: savingFields.has("nightWindowEndHour"),
            onChange: (event: { target: { value: string } }) => setField("nightWindowEndHour", event.target.value),
          })),
        h(FormRow, { label: "Runtime cap (minutes)", error: fieldError("runtimeCapMinutes"), status: fieldStatus("runtimeCapMinutes"), hint: "Minimum 1 minute." },
          h("input", {
            type: "number",
            "aria-label": "Runtime cap (minutes)",
            className: inputClass,
            min: 1,
            value: draft.runtimeCapMinutes,
            disabled: savingFields.has("runtimeCapMinutes"),
            onChange: (event: { target: { value: string } }) => setField("runtimeCapMinutes", event.target.value),
          })),
        h(FormRow, { label: "Minimum start gap (minutes)", error: fieldError("minimumGapMinutes"), status: fieldStatus("minimumGapMinutes"), hint: "Minimum 60 minutes." },
          h("input", {
            type: "number",
            "aria-label": "Minimum start gap (minutes)",
            className: inputClass,
            min: 60,
            value: draft.minimumGapMinutes,
            disabled: savingFields.has("minimumGapMinutes"),
            onChange: (event: { target: { value: string } }) => setField("minimumGapMinutes", event.target.value),
          })),
        h(FormRow, { label: "Concurrency limit", error: fieldError("concurrencyLimit"), warning: concurrencyWarning, status: fieldStatus("concurrencyLimit") },
          h("input", {
            type: "number",
            "aria-label": "Concurrency limit",
            className: inputClass,
            min: 1,
            value: draft.concurrencyLimit,
            disabled: savingFields.has("concurrencyLimit"),
            onChange: (event: { target: { value: string } }) => setField("concurrencyLimit", event.target.value),
          })),
        h(FormRow, { label: "Provider preference", error: fieldError("providerPreference"), warning: providerWarning, status: fieldStatus("providerPreference") },
          h("select", {
            "aria-label": "Provider preference",
            className: inputClass,
            value: draft.providerPreference,
            disabled: savingFields.has("providerPreference"),
            onChange: (event: { target: { value: string } }) => setField("providerPreference", event.target.value),
          },
            providerOptions.map((option) =>
              h("option", { key: option.value, value: option.value }, option.label)))),
        providerDefaultControl === null ? null : h(FormRow, {
          label: "Default model + thinking",
          error: fieldError("providerModelDefaults"),
          status: fieldStatus("providerModelDefaults"),
          hint: preferred === null
            ? undefined
            : storedDefault === undefined
              ? `Dispatch uses the model and thinking level the host reports for ${pinnedProviderId}.`
              : `Dispatch on ${pinnedProviderId} uses this instead of the host's defaults.`,
        }, providerDefaultControl),
        draft.providerPreference !== "alternate" ? null : h(FormRow, {
          label: "Provider rotation",
          error: fieldError("providerRotation"),
          status: fieldStatus("providerRotation"),
          hint: "Dispatch rotates through this list in order; a usable provider outside it is the fallback.",
        }, rotationEditor)),
      saveState.message
        ? h("p", { key: "saved", className: "mt-3 text-sm text-success-foreground", role: "status" }, saveState.message)
        : null,
      saveState.error
        ? h("p", { key: "save-error", className: "mt-3 text-sm text-destructive" }, saveState.error)
        : null,
      dirty
        ? h("div", {
            key: "dirty-bar",
            className: "sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3",
          },
            h("span", { className: "text-sm font-medium text-warning-text" }, "Unsaved changes"),
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
        body: `Applies to ${repositoryLabel(ctx.repository.repositoryKey, ctx.displayName)} on the next dispatch cycle. A run in progress is not affected.`,
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
