import type { FactoryRoute, FactorySection } from "./context.js";

export interface FactoryRouteState {
  readonly section: FactoryRoute | "not-found";
  readonly runId: string | null;
  readonly anchor: string | null;
  readonly raw?: string;
}

const SECTION_SET = new Set<FactorySection>(["overview", "work", "questions", "runs", "settings"]);

/** Percent-decoding that returns the input unchanged instead of throwing on stray '%'. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseFactoryRoute(subPath: string): FactoryRouteState {
  // The host percent-encodes each subPath segment when it builds the panel
  // URL, so a '#' written by older builds arrives as %23. Decoding once up
  // front lets the legacy "questions%23question-Q3" form and literal-hash
  // links resolve alongside the segment form "questions/question-Q3".
  const [pathPart, hashPart] = safeDecode(subPath).split("#");
  const path = (pathPart ?? "").replace(/^\/+|\/+$/g, "");
  const hashAnchor = hashPart ? safeDecode(hashPart) : null;
  if (!path) return { section: "overview", runId: null, anchor: hashAnchor };
  const [head, ...rest] = path.split("/");
  // Section anchors travel as a trailing path segment because the host
  // percent-encodes '#' inside subPath; runs/<id> stays a run id instead.
  const segmentAnchor = rest.length > 0 ? safeDecode(rest.join("/")) : null;
  const anchor = hashAnchor ?? segmentAnchor;
  if (head === "queue") return { section: "work", runId: null, anchor };
  if (head === "repositories" && rest[0] === "new") return { section: "add-repository", runId: null, anchor: hashAnchor };
  if (head === "repositories" && rest.length === 0) return { section: "repositories", runId: null, anchor: hashAnchor };
  if (head === "add-repository") return { section: "add-repository", runId: null, anchor: hashAnchor };
  if (head === "runs" && rest.length > 0) {
    return { section: "runs", runId: safeDecode(rest.join("/")), anchor: hashAnchor };
  }
  if (SECTION_SET.has(head as FactorySection)) {
    return { section: head as FactorySection, runId: null, anchor };
  }
  return { section: "not-found", runId: null, anchor, raw: path };
}

export function sectionPath(section: FactorySection, anchor?: string): string {
  // '#' inside subPath is percent-encoded by the host, so the anchor rides
  // as a trailing path segment (the same channel runs/<id> already uses).
  return anchor ? `${section}/${encodeURIComponent(anchor)}` : section;
}

export function runDetailPath(runId: string): string {
  return `runs/${encodeURIComponent(runId)}`;
}
