import type { FactoryRoute, FactorySection } from "./context.js";

export type FactoryScope = "repository" | "all";

export interface FactoryRouteState {
  readonly section: FactoryRoute | "not-found";
  /** "all" renders the union of every repository; "repository" renders the selected one. */
  readonly scope: FactoryScope;
  readonly runId: string | null;
  /** The repository an aggregate run detail is pinned to; null on repo-scoped routes. */
  readonly runRepositoryKey: string | null;
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
  // The panel root and the legacy repositories route are the aggregate
  // overview: the sidebar Factory item lands on it.
  if (!path || path === "repositories" || path === "all" || path === "all/overview") {
    return { section: "overview", scope: "all", runId: null, runRepositoryKey: null, anchor: hashAnchor };
  }
  const [head, ...rest] = path.split("/");
  // Section anchors travel as a trailing path segment because the host
  // percent-encodes '#' inside subPath; runs/<id> stays a run id instead.
  const segmentAnchor = rest.length > 0 ? safeDecode(rest.join("/")) : null;
  const anchor = hashAnchor ?? segmentAnchor;
  const repositoryScope = { scope: "repository" as const, runRepositoryKey: null };
  if (head === "repositories" && rest[0] === "new") {
    return { section: "add-repository", runId: null, anchor: hashAnchor, ...repositoryScope };
  }
  if (head === "add-repository") {
    return { section: "add-repository", runId: null, anchor: hashAnchor, ...repositoryScope };
  }
  if (head === "all") {
    const [sub, ...subRest] = rest;
    const subAnchor = subRest.length > 0 ? safeDecode(subRest.join("/")) : hashAnchor;
    if (sub === "overview") {
      return { section: "overview", scope: "all", runId: null, runRepositoryKey: null, anchor: subAnchor };
    }
    if (sub === "work" || sub === "questions") {
      // Aggregate anchors carry the owning repository: "<repoKey>/<inner>".
      return { section: sub, scope: "all", runId: null, runRepositoryKey: null, anchor: subAnchor };
    }
    if (sub === "runs") {
      if (subRest.length === 0) {
        return { section: "runs", scope: "all", runId: null, runRepositoryKey: null, anchor: hashAnchor };
      }
      if (subRest.length === 1) {
        return { section: "not-found", scope: "all", runId: null, runRepositoryKey: null, anchor: hashAnchor, raw: path };
      }
      return {
        section: "runs",
        scope: "all",
        runRepositoryKey: safeDecode(subRest[0]!),
        runId: safeDecode(subRest.slice(1).join("/")),
        anchor: hashAnchor,
      };
    }
    // "all/settings" intentionally does not exist: settings stay repo-scoped.
    return { section: "not-found", scope: "all", runId: null, runRepositoryKey: null, anchor: subAnchor, raw: path };
  }
  if (head === "queue") return { section: "work", runId: null, anchor, ...repositoryScope };
  if (head === "runs" && rest.length > 0) {
    return { section: "runs", runId: safeDecode(rest.join("/")), anchor: hashAnchor, ...repositoryScope };
  }
  if (SECTION_SET.has(head as FactorySection)) {
    return { section: head as FactorySection, runId: null, anchor, ...repositoryScope };
  }
  return { section: "not-found", runId: null, anchor, raw: path, ...repositoryScope };
}

export function sectionPath(section: FactorySection, anchor?: string): string {
  // '#' inside subPath is percent-encoded by the host, so the anchor rides
  // as a trailing path segment (the same channel runs/<id> already uses).
  return anchor ? `${section}/${encodeURIComponent(anchor)}` : section;
}

export function aggregateSectionPath(section: FactorySection, anchor?: string): string {
  return `all/${sectionPath(section, anchor)}`;
}

export function runDetailPath(runId: string): string {
  return `runs/${encodeURIComponent(runId)}`;
}

export function aggregateRunDetailPath(repositoryKey: string, runId: string): string {
  return `all/runs/${encodeURIComponent(repositoryKey)}/${encodeURIComponent(runId)}`;
}
