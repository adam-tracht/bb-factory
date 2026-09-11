import type {
  HealthProjection,
  OperationalRunListProjection,
  PendingInteractionsProjection,
  ProtocolSnapshot,
  QueueEntry,
  SettingsProjection,
} from "../contracts.js";
import { isActiveRunStatus } from "./primitives.js";

export type AttentionSection = "work" | "questions" | "runs" | "settings";
export type AttentionSeverity = "action" | "warning" | "info";

export interface AttentionItem {
  readonly id: string;
  readonly severity: AttentionSeverity;
  readonly section: AttentionSection;
  readonly title: string;
  readonly detail: string;
}

export interface AttentionInput {
  readonly snapshot: ProtocolSnapshot | null;
  readonly snapshotError: boolean;
  readonly settings: SettingsProjection | null;
  readonly health: HealthProjection | null;
  readonly runs: OperationalRunListProjection | null;
  readonly interactions: PendingInteractionsProjection | null;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { action: 0, warning: 1, info: 2 };

function openQuestions(snapshot: ProtocolSnapshot | null) {
  return (snapshot?.questions ?? []).filter((question) => question.answer === null);
}

function questionGates(snapshot: ProtocolSnapshot | null, questionId: string): string[] {
  return (snapshot?.queue ?? [])
    .filter((entry) =>
      entry.blockedBy.includes(questionId) ||
      (entry.status.kind === "blocked-by" && entry.status.questionId === questionId))
    .map((entry) => entry.id);
}

/** A queue row that still needs human authorization. */
function needsApproval(entry: QueueEntry): boolean {
  return entry.eligibilityReasons.some(
    (reason) => reason === "missing-authorization" || reason === "high-risk-approval-missing",
  );
}

/**
 * Pure "needs attention" model over the already-loaded projections. Dispatch
 * state comes from BB-side projections so a malformed protocol file still
 * surfaces pause/provider problems.
 */
export function computeAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { snapshot, settings, health, runs, interactions } = input;

  if (snapshot) {
    const blocking = openQuestions(snapshot).filter((question) => question.classification === "blocking");
    const assumptions = openQuestions(snapshot).filter((question) => question.classification === "assumption");
    if (blocking.length > 0) {
      const gated = [...new Set(blocking.flatMap((question) => questionGates(snapshot, question.id)))];
      items.push({
        id: "blocking-questions",
        severity: "action",
        section: "questions",
        title: `${blocking.length} blocking question${blocking.length === 1 ? "" : "s"} open`,
        detail: gated.length > 0 ? `Gates ${gated.join(", ")}` : blocking.map((question) => question.id).join(", "),
      });
    }
    if (assumptions.length > 0) {
      items.push({
        id: "assumption-questions",
        severity: "info",
        section: "questions",
        title: `${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"} unconfirmed`,
        detail: assumptions.map((question) => question.id).join(", "),
      });
    }

    const approvalNeeded = snapshot.queue.filter(needsApproval);
    if (approvalNeeded.length > 0) {
      items.push({
        id: "approvals",
        severity: "action",
        section: "work",
        title: `${approvalNeeded.length} item${approvalNeeded.length === 1 ? "" : "s"} need approval`,
        detail: approvalNeeded.slice(0, 4).map((entry) => entry.id).join(", ") + (approvalNeeded.length > 4 ? ` +${approvalNeeded.length - 4}` : ""),
      });
    }
    const gatedItems = snapshot.queue.filter((entry) => entry.blockingQuestionIds.length > 0 && !needsApproval(entry));
    if (gatedItems.length > 0) {
      items.push({
        id: "gated-items",
        severity: "info",
        section: "work",
        title: `${gatedItems.length} item${gatedItems.length === 1 ? "" : "s"} gated by questions`,
        detail: gatedItems.map((entry) => entry.id).join(", "),
      });
    }
    const staleGated = snapshot.queue.filter(
      (entry) => entry.eligibilityReasons.includes("stale-question-gate"),
    );
    if (staleGated.length > 0) {
      items.push({
        id: "stale-question-gates",
        severity: "action",
        section: "work",
        title: `${staleGated.length} item${staleGated.length === 1 ? "" : "s"} blocked by a resolved or missing question`,
        detail: `${staleGated.map((entry) => entry.id).join(", ")} · review the gate and re-point or mark ready`,
      });
    }
    const waiting = snapshot.queue.filter(
      (entry) => entry.eligibilityReasons.includes("unmet-dependency") && entry.status.kind === "ready",
    );
    if (waiting.length > 0) {
      items.push({
        id: "waiting-dependencies",
        severity: "info",
        section: "work",
        title: `${waiting.length} ready item${waiting.length === 1 ? "" : "s"} waiting on dependencies`,
        detail: waiting.map((entry) => entry.id).join(", "),
      });
    }
    const unknown = snapshot.queue.filter((entry) => entry.status.kind === "unknown");
    if (unknown.length > 0) {
      items.push({
        id: "unknown-status",
        severity: "warning",
        section: "work",
        title: `${unknown.length} item${unknown.length === 1 ? "" : "s"} have an unrecognized status`,
        detail: unknown.map((entry) => `${entry.id}: ${entry.status.kind === "unknown" ? entry.status.raw : ""}`).join(", "),
      });
    }
  } else if (input.snapshotError) {
    items.push({
      id: "snapshot-error",
      severity: "warning",
      section: "work",
      title: "Protocol files failed to parse",
      detail: "Queue, questions, and run state are degraded until the files load.",
    });
  }

  const interactionCount = interactions?.interactions.length ?? 0;
  if (interactionCount > 0) {
    items.push({
      id: "pending-interactions",
      severity: "action",
      section: "questions",
      title: `${interactionCount} BB question${interactionCount === 1 ? "" : "s"} waiting`,
      detail: "Answer them to unblock dispatch.",
    });
  }

  const failedRun = runs?.runs.find((run) => run.status === "failed-safe" || run.status === "reconciliation-required");
  if (failedRun) {
    items.push({
      id: "failed-run",
      severity: "warning",
      section: "runs",
      title: failedRun.status === "reconciliation-required" ? "A run needs reconciliation" : "A run failed safe",
      detail: `${failedRun.runId} · retry available on the run`,
    });
  }

  if (health) {
    if (!health.host.ok) {
      items.push({
        id: "host-degraded",
        severity: "warning",
        section: "settings",
        title: health.host.status === "online" ? "Checkout is not healthy" : "Host is not online",
        detail: health.host.reasons[0] ?? `Host ${health.host.hostId} ${health.host.status}`,
      });
    }
    const preferred = settings?.settings.providerPreference;
    const provider = preferred && preferred !== "alternate"
      ? health.providers.find((candidate) => candidate.providerId === preferred)
      : null;
    if (provider && provider.availability !== "available") {
      items.push({
        id: "provider-degraded",
        severity: "warning",
        section: "settings",
        title: `Preferred provider ${provider.providerId} is ${provider.availability}`,
        detail: provider.lastError ?? "Scheduled runs may fall back or skip.",
      });
    } else if (health.providers.length > 0 && health.providers.every((candidate) => candidate.availability !== "available")) {
      items.push({
        id: "no-provider",
        severity: "warning",
        section: "settings",
        title: "No dispatch provider is available",
        detail: "Scheduled runs will skip until a provider recovers.",
      });
    }
  }

  if (settings) {
    if (settings.dispatch.mode !== "enabled") {
      items.push({
        id: "dispatch-paused",
        severity: "info",
        section: "settings",
        title: "Dispatch is paused",
        detail: "No new runs start until it is resumed.",
      });
    }
    if (settings.dispatch.repositoryPaused) {
      items.push({
        id: "repository-paused",
        severity: "info",
        section: "settings",
        title: "Dispatch paused for this repository",
        detail: "Turn it back on in Settings.",
      });
    }
    const active = runs?.runs.filter((run) => isActiveRunStatus(run.status)).length ?? 0;
    if (settings.dispatch.mode === "enabled" && !settings.dispatch.repositoryPaused && active >= settings.settings.concurrencyLimit) {
      items.push({
        id: "concurrency-reached",
        severity: "info",
        section: "settings",
        title: "Concurrency limit reached",
        detail: `${active} active run${active === 1 ? "" : "s"} of ${settings.settings.concurrencyLimit}.`,
      });
    }
  }

  return items.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

export function attentionCounts(items: readonly AttentionItem[]): Record<AttentionSection, number> {
  const counts: Record<AttentionSection, number> = { work: 0, questions: 0, runs: 0, settings: 0 };
  for (const item of items) {
    if (item.severity !== "info") counts[item.section] += 1;
  }
  return counts;
}
