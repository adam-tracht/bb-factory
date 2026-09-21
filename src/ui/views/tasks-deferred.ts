import { createElement, type ReactNode } from "react";
import type { HealthProjection, ProtocolSnapshot } from "../../contracts.js";
import type { AttentionItem } from "../attention.js";
import { Badge, Section } from "../primitives.js";

const h = createElement;

export function TasksDeferredView(props: {
  readonly section: "work" | "questions" | "runs";
  readonly snapshot: ProtocolSnapshot;
  readonly health: HealthProjection | null;
  readonly attention: readonly AttentionItem[];
}): ReactNode {
  const sectionLabel = props.section === "work" ? "work queue" : props.section;
  const attention = props.attention.filter((item) => item.section === props.section || item.section === "settings");
  return h("div", { className: "space-y-4" },
    h(Section, {
      title: "Native Tasks board",
      children: null,
      actions: h("a", {
        href: "/plugins/tasks/tasks",
        className: "text-sm font-medium text-primary hover:underline",
      }, "Open Tasks board"),
    },
      h("div", { className: "space-y-2 text-sm text-muted-foreground" },
        h("p", null, `Tasks is the authoritative ${sectionLabel} for this repository. Factory keeps dispatch safety, approvals, dependencies, blockers, and run settlement here.`),
        h("p", null, `${props.snapshot.queue.length} task card${props.snapshot.queue.length === 1 ? "" : "s"} are in the linked Tasks project.`),
        h("p", null, `${props.snapshot.questions.filter((question) => question.answer === null).length} blocking question${props.snapshot.questions.filter((question) => question.answer === null).length === 1 ? "" : "s"} are open in the Factory ledger.`),
      ),
    ),
    h(Section, { title: "Factory attention", children: null },
      attention.length === 0 && props.health?.host.ok !== false
        ? h("p", { className: "text-sm text-muted-foreground" }, "No Factory-owned attention items.")
        : h("div", { className: "space-y-2" },
            ...attention.slice(0, 6).map((item) => h("div", { key: item.id, className: "flex items-start justify-between gap-3 rounded-md border p-3" },
              h("div", null, h("p", { className: "text-sm font-medium" }, item.title), h("p", { className: "text-xs text-muted-foreground" }, item.detail)),
              h(Badge, { label: item.severity, tone: item.severity === "action" ? "danger" : item.severity === "warning" ? "warning" : "neutral" }),
            )),
            ...(props.health?.host.ok === false ? [h("p", { key: "host-health", className: "text-sm text-destructive" }, props.health.host.reasons.join(" "))] : []),
          ),
    ),
  );
}
