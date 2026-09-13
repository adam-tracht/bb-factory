import { experimental_FileLink, type ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import { createElement, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type {
  OperationalRunSummary,
  QueueEntry,
  RepositoryConfiguration,
  RepositoryRevision,
} from "../contracts.js";

const h = createElement;

export type Tone = "success" | "warning" | "danger" | "primary" | "neutral";

export const TONE_BADGE: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
  primary: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
};

const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  primary: "bg-primary",
  neutral: "bg-muted-foreground",
};

export function Badge({ label, tone, title }: { label: string; tone: Tone; title?: string }) {
  return h("span", {
    className: `inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium leading-tight ${TONE_BADGE[tone]}`,
    ...(title ? { title } : {}),
  }, label);
}

/** Tiny semantic dot for live state (running, offline). Not decoration. */
export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return h("span", {
    className: `inline-block h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${pulse ? "animate-pulse" : ""}`,
    "aria-hidden": true,
  });
}

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground",
  secondary: "border border-border bg-card text-foreground hover:bg-state-hover disabled:text-muted-foreground",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-muted disabled:text-muted-foreground",
  ghost: "text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:text-muted-foreground/50",
};

export function ActionButton(props: {
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
  size?: "xs" | "sm";
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  className?: string;
}) {
  const size = props.size === "xs" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return h("button", {
    type: "button",
    className: `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors active:translate-y-px disabled:cursor-not-allowed ${size} ${BUTTON_VARIANTS[props.variant ?? "secondary"]} ${props.className ?? ""}`,
    disabled: props.disabled || props.busy,
    onClick: props.onClick,
    ...(props.title ? { title: props.title } : {}),
  }, props.busy ? "Working..." : props.label);
}

/** Enabled/disabled toggle chip used for repository dispatch state. */
export function StateChip({ on, label, onClick, disabled, title }: {
  on: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return h("button", {
    type: "button",
    className: `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
      on
        ? "border-success/40 bg-success/10 text-success"
        : "border-border bg-muted text-muted-foreground hover:bg-state-hover"
    }`,
    onClick,
    disabled,
    ...(title ? { title } : {}),
  }, h(StatusDot, { tone: on ? "success" : "neutral" }), label);
}

export function Card(props: { title?: string; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return h("section", {
    className: `rounded-lg border border-border bg-card p-4 ${props.className ?? ""}`,
    ...(props.id ? { id: props.id } : {}),
  },
    props.title
      ? h("div", { className: "mb-3 flex items-center justify-between gap-3" },
          h("h2", { className: "text-sm font-semibold" }, props.title),
          props.actions ?? null)
      : props.actions ?? null,
    props.children,
  );
}

/** Divided section with a count-aware header; the standard list container. */
export function Section(props: {
  title: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  actions?: ReactNode;
  id?: string;
}) {
  const heading = h("div", { className: "flex items-center gap-2 py-1.5" },
    h("h2", { className: "text-sm font-semibold text-foreground" }, props.title),
    props.count !== undefined
      ? h("span", { className: "rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground" }, String(props.count))
      : null,
    props.actions ? h("div", { className: "ml-auto flex items-center gap-2" }, props.actions) : null,
  );
  if (props.collapsible) {
    return h(CollapsibleSection, {
      defaultOpen: props.defaultOpen ?? false,
      id: props.id,
      summaryClassName: "cursor-pointer list-none select-none rounded-md px-1 hover:bg-state-hover",
      bodyClassName: "mt-1 divide-y divide-border",
      heading,
      children: props.children,
    });
  }
  return h("section", { ...(props.id ? { id: props.id } : {}) },
    h("div", { className: "px-1" }, heading),
    h("div", { className: "divide-y divide-border" }, props.children),
  );
}

export function Disclosure(props: { summary: ReactNode; children: ReactNode; className?: string }) {
  return h(CollapsibleSection, {
    defaultOpen: false,
    className: props.className,
    summaryClassName: "cursor-pointer list-none select-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
    summaryPrefix: h("span", { className: "inline-block transition-transform group-open:rotate-90" }, "▸"),
    bodyClassName: "mt-2",
    heading: props.summary,
    children: props.children,
  });
}

/**
 * Controlled details: children only mount while open. The host stylesheet can
 * keep closed details children rendered, which escapes the scroll container's
 * height accounting and clips overflowed content instead of scrolling.
 */
export function CollapsibleSection(props: {
  heading: ReactNode;
  children: ReactNode;
  defaultOpen: boolean;
  id?: string;
  className?: string;
  summaryClassName?: string;
  summaryPrefix?: ReactNode;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(props.defaultOpen);
  const defaultOpenRef = useRef(props.defaultOpen);
  useEffect(() => {
    if (props.defaultOpen && !defaultOpenRef.current) setOpen(true);
    defaultOpenRef.current = props.defaultOpen;
  }, [props.defaultOpen]);
  return h("details", {
    className: `group ${props.className ?? ""}`,
    open,
    onToggle: (event: { currentTarget: { open: boolean } }) => setOpen(event.currentTarget.open),
    ...(props.id ? { id: props.id } : {}),
  },
    h("summary", {
      className: props.summaryClassName,
      onClick: (event: { preventDefault(): void }) => {
        event.preventDefault();
        setOpen((value) => !value);
      },
    },
      props.summaryPrefix ?? null,
      props.summaryPrefix ? " " : null,
      props.heading),
    open ? h("div", { className: props.bodyClassName }, props.children) : null,
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return h("div", {
    className: "rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3",
    role: "alert",
  },
    h("div", { className: "flex items-start justify-between gap-3" },
      h("div", null,
        h("p", { className: "text-sm font-medium text-destructive" }, "Something failed to load"),
        h("p", { className: "mt-1 text-xs text-destructive/80" }, message)),
      onRetry ? h(ActionButton, { label: "Retry", variant: "secondary", size: "xs", onClick: onRetry }) : null),
  );
}

export function EmptyNotice({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return h("div", { className: "rounded-lg border border-dashed border-border px-4 py-6 text-center" },
    h("p", { className: "text-sm font-medium text-foreground" }, title),
    detail ? h("p", { className: "mt-1 text-xs text-muted-foreground" }, detail) : null,
    action ? h("div", { className: "mt-3 flex justify-center" }, action) : null);
}

export function LoadingNotice({ label = "Loading..." }: { label?: string }) {
  return h("div", { className: "space-y-2", role: "status", "aria-label": label },
    ...[0, 1, 2].map((index) => h("div", {
      key: index,
      className: "h-9 animate-pulse rounded-md bg-muted/60",
      style: { animationDelay: `${index * 90}ms` },
    })));
}

export function Field({ label, value, mono, children }: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  children?: ReactNode;
}) {
  return h("div", { className: "min-w-0" },
    h("dt", { className: "text-xs text-muted-foreground" }, label),
    children ?? h("dd", {
      className: `mt-0.5 break-words text-sm ${mono ? "font-mono" : ""}`,
    }, value ?? "Not set"));
}

/** Inline confirmation dialog. Lightweight modal, no portal dependency. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!props.open) return null;
  return h("div", {
    className: "fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4",
    role: "presentation",
    onClick: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget) props.onCancel();
    },
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape") props.onCancel();
    },
  },
    h("div", {
      role: "alertdialog",
      "aria-modal": true,
      "aria-label": props.title,
      className: "w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-lg",
    },
      h("h2", { className: "text-sm font-semibold text-foreground" }, props.title),
      h("div", { className: "mt-2 text-sm text-muted-foreground" }, props.body),
      h("div", { className: "mt-4 flex justify-end gap-2" },
        h(ActionButton, { label: "Cancel", variant: "secondary", onClick: props.onCancel, disabled: props.busy }),
        h(ActionButton, {
          label: props.confirmLabel,
          variant: props.destructive ? "danger" : "primary",
          onClick: props.onConfirm,
          busy: props.busy,
        }))));
}

/** Destructive confirmation that requires typing a phrase (for Stop). */
export function TypedConfirmDialog(props: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmPhrase: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  if (!props.open) return null;
  const matches = value.trim().toLowerCase() === props.confirmPhrase.toLowerCase();
  return h("div", {
    className: "fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4",
    role: "presentation",
    onClick: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget) props.onCancel();
    },
  },
    h("div", {
      role: "alertdialog",
      "aria-modal": true,
      "aria-label": props.title,
      className: "w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-lg",
    },
      h("h2", { className: "text-sm font-semibold text-foreground" }, props.title),
      h("div", { className: "mt-2 text-sm text-muted-foreground" }, props.body),
      h("label", { className: "mt-3 block text-xs font-medium text-foreground" },
        `Type "${props.confirmPhrase}" to confirm`,
        h("input", {
          type: "text",
          value,
          onChange: (event: { target: { value: string } }) => setValue(event.target.value),
          className: "mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm",
          autoFocus: true,
        })),
      h("div", { className: "mt-4 flex justify-end gap-2" },
        h(ActionButton, { label: "Cancel", variant: "secondary", onClick: props.onCancel, disabled: props.busy }),
        h(ActionButton, {
          label: props.confirmLabel,
          variant: "danger",
          onClick: props.onConfirm,
          disabled: !matches,
          busy: props.busy,
        }))));
}

export function CopyText({ value, label, mono }: { value: string; label?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return h("button", {
    type: "button",
    className: `inline-flex max-w-full items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground ${mono ? "font-mono" : ""}`,
    title: copied ? "Copied" : `Copy ${value}`,
    onClick: () => {
      void navigator.clipboard?.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    },
  },
    h("span", { className: "truncate" }, label ?? value),
    h("span", { className: "shrink-0 text-[10px] uppercase tracking-wide" }, copied ? "copied" : "copy"));
}

export type FileLinkTarget = ExperimentalLiveFileTarget;

export interface FileLinkProps {
  target: FileLinkTarget;
  className?: string;
  children?: ReactNode;
}

export type FileLinkRenderer = ComponentType<FileLinkProps>;

/** Host-resolved link used by default; tests inject a stub. */
export const HostFileLink: FileLinkRenderer = experimental_FileLink as unknown as FileLinkRenderer;

export function normalizeRepositoryRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

/**
 * Resolve a repo-relative protocol path to a live file target. Environment
 * scope wins (the env knows its checkout); the host+absolute path is the
 * fallback when no environment is configured.
 */
export function repositoryFileTarget(
  repository: RepositoryConfiguration,
  environmentId: string | null,
  relativePath: string,
): FileLinkTarget | null {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  if (!normalized) return null;
  if (environmentId) {
    return { kind: "workspace", environmentId, path: normalized };
  }
  const separator = repository.checkoutPath.includes("\\") ? "\\" : "/";
  const checkoutPath = repository.checkoutPath.replace(/[\\/]+$/u, "");
  return {
    kind: "host",
    hostId: repository.connectedHostId,
    path: `${checkoutPath}${separator}${normalized.replaceAll("/", separator)}`,
  };
}

/** A run-scoped file target: the run's environment wins over the repository default. */
export function runFileTarget(
  run: OperationalRunSummary,
  repository: RepositoryConfiguration,
  environmentId: string | null,
  relativePath: string,
): FileLinkTarget | null {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  if (!normalized) return null;
  const scopedEnvironment = run.environmentId ?? environmentId;
  if (scopedEnvironment && scopedEnvironment !== "unknown") {
    return { kind: "workspace", environmentId: scopedEnvironment, path: normalized };
  }
  return repositoryFileTarget(repository, environmentId, relativePath);
}

/** Middle-truncated monospace path with an optional file link. */
export function FilePath(props: {
  path: string;
  target?: FileLinkTarget | null;
  fileLink?: FileLinkRenderer;
  className?: string;
}) {
  if (props.target && props.fileLink) {
    return h(props.fileLink, {
      target: props.target,
      className: `font-mono text-xs text-primary underline-offset-2 hover:underline ${props.className ?? ""}`,
    }, props.path);
  }
  return h("code", {
    className: `block truncate font-mono text-xs ${props.className ?? ""}`,
    title: props.path,
  }, props.path);
}

const PLAN_PATH_RE = /\S+\.md/g;

/** Renders free text, linking each `.md` path token to its file. */
export function linkifyPaths(text: string, render: (token: string, index: number) => ReactNode): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(PLAN_PATH_RE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    nodes.push(render(match[0], index));
    index += 1;
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Demote ATX headings so pasted markdown cannot hijack the visual hierarchy. */
export function safeMarkdown(content: string): string {
  return content.replace(/^(#{1,6})\s+(.*)$/gmu, "**$2**");
}

export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(startIso: string | null, endIso: string | null, now = Date.now()): string | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const minutes = Math.floor((end - start) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function statusTone(status: "ok" | "warn" | "error" | "idle" | "running"): Tone {
  switch (status) {
    case "ok": return "success";
    case "warn": return "warning";
    case "error": return "danger";
    case "running": return "primary";
    case "idle": return "neutral";
  }
}

export function queueStatusLabel(status: QueueEntry["status"]): string {
  switch (status.kind) {
    case "ready":
      return "Ready";
    case "in-progress":
      return "In progress";
    case "done":
      return "Done";
    case "blocked-by":
      return `Blocked by ${status.questionId}`;
    case "draft":
      return "Draft";
    case "unknown":
      return "Unrecognized status";
  }
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case "pending": return "Pending";
    case "started": return "Running";
    case "completed": return "Completed";
    case "no-op": return "No-op";
    case "failed-safe": return "Failed safe";
    case "cancelled": return "Cancelled";
    case "cancel-requested": return "Cancelling";
    case "reconciliation-required": return "Needs reconciliation";
    default: return status;
  }
}

export function runStatusTone(status: string): Tone {
  switch (status) {
    case "completed": return "success";
    case "no-op": return "neutral";
    case "started": return "primary";
    case "pending": return "primary";
    case "failed-safe": return "danger";
    case "cancel-requested": return "warning";
    case "reconciliation-required": return "warning";
    case "cancelled": return "neutral";
    default: return "neutral";
  }
}

export function formatEligibilityReason(reason: QueueEntry["eligibilityReasons"][number]): string {
  switch (reason) {
    case "not-ready": return "Status is not ready";
    case "unmet-dependency": return "Waiting on dependencies";
    case "blocking-question": return "An open question blocks this item";
    case "stale-question-gate": return "Gating question is answered or missing";
    case "missing-authorization": return "Needs an approved line";
    case "high-risk-approval-missing": return "High risk: needs an approved line";
    case "repository-policy": return "Blocked by repository policy";
  }
}

export function isActiveRunStatus(status: string): boolean {
  return status === "pending" || status === "started" || status === "cancel-requested" || status === "reconciliation-required";
}

/** Action feedback notice scoped to the repository + tab that produced it. */
export interface ActionFeedback {
  readonly pending: boolean;
  readonly target: string | null;
  readonly message: string | null;
  readonly error: string | null;
  readonly scope: { repositoryKey: string; section: string };
}

export function FeedbackNotice({ feedback }: { feedback: ActionFeedback | null }) {
  if (!feedback || (!feedback.message && !feedback.error && !feedback.pending)) return null;
  const tone = feedback.error ? "danger" : feedback.pending ? "primary" : "success";
  return h("div", {
    className: `flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
      tone === "danger"
        ? "border-destructive/40 bg-destructive/5 text-destructive"
        : tone === "primary"
          ? "border-primary/40 bg-primary/5 text-primary"
          : "border-success/40 bg-success/5 text-success"
    }`,
    role: "status",
  },
    feedback.pending ? h("span", { className: "animate-pulse" }, "Applying...") : null,
    h("span", null, feedback.error ?? feedback.message ?? ""));
}

export function connectionBanner(state: "connected" | "reconnecting" | "disconnected"): { label: string; detail: string; tone: Tone } | null {
  if (state === "connected") return null;
  return state === "reconnecting"
    ? { label: "Connection lost", detail: "Durable state will reload when it reconnects.", tone: "warning" }
    : { label: "Disconnected", detail: "The plugin host is unreachable. Reads and actions are suspended.", tone: "danger" };
}

export function revisionEqual(left: RepositoryRevision | null, right: RepositoryRevision | null): boolean {
  if (!left || !right) return left === right;
  return left.protocolDigest === right.protocolDigest && left.gitCommit === right.gitCommit;
}
