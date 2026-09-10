import type { FactoryRoute, FactorySection } from "./context.js";

export interface FactoryRouteState {
  readonly section: FactoryRoute | "not-found";
  readonly runId: string | null;
  readonly anchor: string | null;
  readonly raw?: string;
}

const SECTION_SET = new Set<FactorySection>(["overview", "work", "questions", "runs", "settings"]);

export function parseFactoryRoute(subPath: string): FactoryRouteState {
  const [pathPart, hashPart] = subPath.split("#");
  const path = (pathPart ?? "").replace(/^\/+|\/+$/g, "");
  const anchor = hashPart ? decodeURIComponent(hashPart) : null;
  if (!path) return { section: "overview", runId: null, anchor };
  const [head, ...rest] = path.split("/");
  if (head === "queue") return { section: "work", runId: null, anchor };
  if (head === "repositories" && rest[0] === "new") return { section: "add-repository", runId: null, anchor };
  if (head === "repositories" && rest.length === 0) return { section: "repositories", runId: null, anchor };
  if (head === "add-repository") return { section: "add-repository", runId: null, anchor };
  if (head === "runs" && rest.length > 0) {
    return { section: "runs", runId: decodeURIComponent(rest.join("/")), anchor };
  }
  if (SECTION_SET.has(head as FactorySection) && rest.length === 0) {
    return { section: head as FactorySection, runId: null, anchor };
  }
  return { section: "not-found", runId: null, anchor, raw: path };
}

export function sectionPath(section: FactorySection, anchor?: string): string {
  return anchor ? `${section}#${encodeURIComponent(anchor)}` : section;
}

export function runDetailPath(runId: string): string {
  return `runs/${encodeURIComponent(runId)}`;
}
