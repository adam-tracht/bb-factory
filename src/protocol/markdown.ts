import type {
  DashboardRowProjection,
  ImmutableRunRecord,
} from "./types.js";
import { ProtocolError } from "./errors.js";

interface MarkdownSection {
  readonly heading: string;
  readonly startLine: number;
  readonly lines: readonly string[];
}

function sectionsOutsideFences(content: string, path: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/u);
  const sections: MarkdownSection[] = [];
  let current: { heading: string; startLine: number; lines: string[] } | undefined;
  let fence: string | undefined;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) {
        fence = fenceMatch[1];
      } else if (fence[0] === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (fence) {
      return;
    }

    const headingMatch = line.match(/^##\s+(.+?)\s*$/u);
    if (headingMatch) {
      if (current) {
        sections.push({ ...current, lines: [...current.lines] });
      }
      current = { heading: headingMatch[1], startLine: index + 1, lines: [] };
      return;
    }
    if (current) {
      current.lines.push(line);
    }
  });

  if (current) {
    sections.push({ ...current, lines: [...current.lines] });
  }
  if (fence) {
    throw new ProtocolError("malformed-protocol", "Unterminated Markdown fence in '" + path + "'", { path });
  }
  return sections;
}

function parseFields(lines: readonly string[], path: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let activeList: string | undefined;
  let activeScalar: string | undefined;

  for (const line of lines) {
    const fieldMatch = line.match(/^([a-z][a-z_]*)\s*:\s*(.*)$/u);
    if (fieldMatch) {
      const [, field, value] = fieldMatch;
      activeList = undefined;
      activeScalar = field;
      fields.set(field, value.trim());
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.*)$/u);
    if (bulletMatch && (activeScalar === "acceptance" || activeScalar === "validate")) {
      activeList = activeScalar;
      const existing = fields.get(activeList);
      const values = Array.isArray(existing) ? existing : [];
      values.push(bulletMatch[1].trim());
      fields.set(activeList, values);
      continue;
    }

    if (line.trim() && activeScalar && activeScalar !== "acceptance" && activeScalar !== "validate") {
      const existing = fields.get(activeScalar);
      if (typeof existing === "string") {
        fields.set(activeScalar, `${existing}\n${line.trim()}`.trim());
      }
    } else if (line.trim() && activeList) {
      const existing = fields.get(activeList);
      if (Array.isArray(existing) && existing.length > 0) {
        existing[existing.length - 1] = `${existing[existing.length - 1]}\n${line.trim()}`.trim();
      }
    }
  }

  if (fields.size === 0) {
    throw new ProtocolError("malformed-protocol", `Section at line ${lines.length} in '${path}' has no fields`, {
      path,
    });
  }
  return fields;
}

function requiredString(fields: Map<string, string | string[]>, field: string, path: string): string {
  const value = fields.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError("malformed-protocol", `Missing non-empty '${field}:' in '${path}'`, {
      path,
      details: { field },
    });
  }
  return value.trim();
}

function optionalString(fields: Map<string, string | string[]>, field: string): string | null {
  const value = fields.get(field);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listField(fields: Map<string, string | string[]>, field: string): string[] {
  const value = fields.get(field);
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    return value.trim() ? [value.trim()] : [];
  }
  return value.filter((item) => item.trim()).map((item) => item.trim());
}

function parseHeader(header: string, path: string, lineNumber: number): { id: string; title: string } {
  const match = header.match(/^(\S+)\s+(.+?)\s*$/u);
  if (!match) {
    throw new ProtocolError("malformed-protocol", `Queue heading at line ${lineNumber} must contain an id and title`, {
      path,
    });
  }
  return { id: match[1], title: match[2].trim() };
}

function parseStatus(value: string, path: string):
  | { readonly kind: "ready" }
  | { readonly kind: "in-progress"; readonly detail: string }
  | { readonly kind: "done"; readonly detail?: string }
  | { readonly kind: "blocked-by"; readonly questionId: string; readonly detail?: string } {
  const trimmed = value.trim();
  if (trimmed === "ready") {
    return { kind: "ready" };
  }
  const inProgress = trimmed.match(/^in-progress(?:\s+(.+))?$/u);
  if (inProgress) {
    if (!inProgress[1]?.trim()) {
      throw new ProtocolError("malformed-protocol", `in-progress status in '${path}' needs a detail`, { path });
    }
    return { kind: "in-progress", detail: inProgress[1].trim() };
  }
  const done = trimmed.match(/^done(?:\s+(.+))?$/u);
  if (done) {
    return done[1]?.trim() ? { kind: "done", detail: done[1].trim() } : { kind: "done" };
  }
  const blocked = trimmed.match(/^blocked-by\s*:\s*(\S+)(?:\s+(.+))?$/u);
  if (blocked) {
    return blocked[2]?.trim()
      ? { kind: "blocked-by", questionId: blocked[1], detail: blocked[2].trim() }
      : { kind: "blocked-by", questionId: blocked[1] };
  }
  throw new ProtocolError("malformed-protocol", `Unsupported queue status '${value}' in '${path}'`, {
    path,
  });
}

function parseRisk(value: string, path: string): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new ProtocolError("malformed-protocol", `Unsupported queue risk '${value}' in '${path}'`, { path });
}

export interface ParsedQuestion {
  readonly id: string;
  readonly date: string;
  readonly classification: "blocking" | "assumption";
  readonly dashboardId: string;
  readonly question: string;
  readonly context: string;
  readonly assumed: string | null;
  readonly recommended?: string | null;
  readonly answer: string | null;
}

export function parseQuestions(content: string, path: string): readonly ParsedQuestion[] {
  const output: ParsedQuestion[] = [];
  const seen = new Set<string>();
  for (const section of sectionsOutsideFences(content, path)) {
    const match = section.heading.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(blocking|assumption)\s+(\S+)$/u);
    if (!match) {
      if (/^Q\d+(?:\s|$)/u.test(section.heading)) {
        throw new ProtocolError("malformed-protocol", "Question heading '" + section.heading + "' is malformed in '" + path + "'", {
          path,
        });
      }
      continue;
    }
    const [, id, date, classification, dashboardId] = match;
    if (seen.has(id)) {
      throw new ProtocolError("malformed-protocol", `Duplicate question '${id}' in '${path}'`, { path });
    }
    seen.add(id);
    const fields = parseFields(section.lines, path);
    const recommendedValue = fields.get("recommended");
    const questionBase = {
      id,
      date,
      classification: classification as "blocking" | "assumption",
      dashboardId,
      question: requiredString(fields, "question", path),
      context: requiredString(fields, "context", path),
      assumed: optionalString(fields, "assumed"),
      answer: optionalString(fields, "answer"),
    };
    if (recommendedValue !== undefined) {
      output.push({
        ...questionBase,
        recommended: typeof recommendedValue === "string" && recommendedValue.trim()
          ? recommendedValue.trim()
          : null,
      });
    } else {
      output.push(questionBase);
    }
  }
  return output;
}

export interface ParsedQueueEntry {
  readonly id: string;
  readonly title: string;
  readonly status:
    | { readonly kind: "ready" }
    | { readonly kind: "in-progress"; readonly detail: string }
    | { readonly kind: "done"; readonly detail?: string }
    | { readonly kind: "blocked-by"; readonly questionId: string; readonly detail?: string };
  readonly priority: number;
  readonly dependsOn: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly planPath: string;
  readonly approved: { readonly kind: "explicit"; readonly text: string } | { readonly kind: "none" };
  readonly acceptance: readonly string[];
  readonly validate: readonly string[];
  readonly notes: string | null;
}

function parsePriority(value: string, path: string): number {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new ProtocolError("malformed-protocol", `Queue priority '${value}' is not an integer from 1 to 5`, { path });
  }
  return priority;
}

function parseDependencies(value: string, path: string): readonly string[] {
  if (value.trim() === "none") {
    return [];
  }
  const dependencies = value.split(",").map((item) => item.trim());
  if (
    dependencies.some((dependency) => !dependency) ||
    dependencies.includes("none") ||
    new Set(dependencies).size !== dependencies.length
  ) {
    throw new ProtocolError("malformed-protocol", "Invalid dependency list '" + value + "' in '" + path + "'", { path });
  }
  return dependencies;
}

export function parseQueue(content: string, path: string): readonly ParsedQueueEntry[] {
  const output: ParsedQueueEntry[] = [];
  const seen = new Set<string>();
  for (const section of sectionsOutsideFences(content, path)) {
    if (section.heading.startsWith("<DASHBOARD-ID>")) {
      continue;
    }
    const hasProtocolField = section.lines.some((line) => /^[a-z][a-z_]*\s*:/u.test(line));
    const looksLikeDashboardId = /^[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+(?:\s|$)/u.test(section.heading);
    if (!hasProtocolField && !looksLikeDashboardId) {
      continue;
    }
    const { id, title } = parseHeader(section.heading, path, section.startLine);
    if (seen.has(id)) {
      throw new ProtocolError("malformed-protocol", `Duplicate queue item '${id}' in '${path}'`, { path });
    }
    seen.add(id);
    const fields = parseFields(section.lines, path);
    const status = parseStatus(requiredString(fields, "status", path), path);
    const approved = requiredString(fields, "approved", path);
    output.push({
      id,
      title,
      status,
      priority: parsePriority(requiredString(fields, "priority", path), path),
      dependsOn: parseDependencies(requiredString(fields, "depends_on", path), path),
      risk: parseRisk(requiredString(fields, "risk", path), path),
      planPath: requiredString(fields, "plan", path),
      approved: approved.toLowerCase() === "none"
        ? { kind: "none" }
        : { kind: "explicit", text: approved },
      acceptance: listField(fields, "acceptance"),
      validate: listField(fields, "validate"),
      notes: optionalString(fields, "notes"),
    });
  }
  return output;
}

export function parseCurrentState(content: string, path: string): {
  readonly state: "success" | "blocked" | "failed-safe" | "no-op";
  readonly lastRunAt: string | null;
} {
  const lines = content.split(/\r?\n/u);
  const stateLine = [...lines].reverse().find((line) => line.trim());
  const stateMatch = stateLine?.match(/^state:\s*(success|blocked|failed-safe|no-op)\s*$/u);
  if (!stateMatch) {
    throw new ProtocolError("malformed-protocol", `The last non-empty line in '${path}' must declare state`, { path });
  }

  const timestamp = content.match(
    /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2}):?(\d{2})Z\b|\b(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\b/u,
  );
  const lastRunAt = timestamp
    ? timestamp[1]
      ? `${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}:${timestamp[6]}Z`
      : `${timestamp[7]}-${timestamp[8]}-${timestamp[9]}T${timestamp[10]}:${timestamp[11]}:${timestamp[12]}Z`
    : null;
  return {
    state: stateMatch[1] as "success" | "blocked" | "failed-safe" | "no-op",
    lastRunAt,
  };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = withoutEdges.endsWith("|") ? withoutEdges.slice(0, -1) : withoutEdges;
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) {
    current += "\\";
  }
  cells.push(current.trim());
  return cells;
}

function markdownTableLines(content: string): readonly string[][] {
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^\s*\|.*\|\s*$/u.test(lines[index]) || !/^\s*\|?\s*:?-{3,}/u.test(lines[index + 1])) {
      continue;
    }
    const headers = splitTableRow(lines[index]).map((header) => header.toLowerCase());
    if (!headers.includes("id") || !headers.includes("status")) {
      continue;
    }
    const rows: string[][] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (!/^\s*\|.*\|\s*$/u.test(lines[rowIndex])) {
        break;
      }
      const cells = splitTableRow(lines[rowIndex]);
      if (cells.some(Boolean)) {
        if (cells.length !== headers.length) {
          throw new ProtocolError("malformed-protocol", "Canonical dashboard row has the wrong number of columns", {
            path: "plans/README.md",
          });
        }
        rows.push(cells);
      }
    }
    return [headers, ...rows];
  }
  throw new ProtocolError("malformed-protocol", "Canonical dashboard does not contain an ID/status table", {
    path: "plans/README.md",
  });
}

export function parseDashboard(content: string, path: string): readonly DashboardRowProjection[] {
  const table = markdownTableLines(content);
  const headers = table[0] ?? [];
  const indexOf = (name: string) => headers.indexOf(name);
  const idIndex = indexOf("id");
  const statusIndex = indexOf("status");
  const titleIndex = headers.indexOf("work item");
  const nextActionIndex = headers.findIndex((header) => header.includes("next action"));
  const evidenceIndex = headers.indexOf("evidence and canonical detail");
  const seen = new Set<string>();
  return table.slice(1).map((cells) => {
    const id = cells[idIndex]?.trim();
    if (!id) {
      throw new ProtocolError("malformed-protocol", `Dashboard row in '${path}' has no ID`, { path });
    }
    if (seen.has(id)) {
      throw new ProtocolError("malformed-protocol", `Duplicate dashboard ID '${id}' in '${path}'`, { path });
    }
    seen.add(id);
    return {
      id,
      title: cells[titleIndex] ?? "",
      status: cells[statusIndex] ?? "",
      nextAction: nextActionIndex >= 0 ? cells[nextActionIndex] ?? "" : "",
      evidence: evidenceIndex >= 0 ? cells[evidenceIndex] ?? "" : "",
    };
  });
}

export function parseRunRecord(content: string, relativePath: string, sha256: string): ImmutableRunRecord {
  const stateMatch = content.match(/^state:\s*(success|blocked|failed-safe|no-op)\s*$/mu);
  return {
    relativePath,
    content,
    sha256,
    state: stateMatch?.[1] as "success" | "blocked" | "failed-safe" | "no-op" | undefined ?? null,
  };
}
