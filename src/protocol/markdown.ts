import type {
  DashboardRowProjection,
  ImmutableRunRecord,
} from "./types.js";
import { ProtocolError } from "./errors.js";

const HINTS = {
  dashboardColumns: "escape a literal pipe inside a cell as \\|",
  dashboardTable: "add the canonical dashboard table with id and status columns",
  dashboardId: "add a non-empty dashboard id to every row",
  duplicate: "keep each protocol id unique",
  fields: "add the required protocol fields to the section",
  fence: "close the Markdown code fence",
  questionHeading: "use Q<n> <YYYY-MM-DD> <blocking|assumption> <dashboard-id>",
  queueHeading: "use <id> <title> for the queue section heading",
  queueRisk: "set risk to low, medium, or high",
  priority: "set priority to an integer from 1 to 5",
  dependencies: "use none or a comma-separated list of unique dependency ids",
  requiredField: "add the required field with a non-empty value",
  currentState: "end the file with state: success, blocked, failed-safe, or no-op",
} as const;

interface MarkdownSection {
  readonly heading: string;
  readonly startLine: number;
  readonly lines: readonly string[];
}

export interface MarkdownParseOptions {
  readonly onError?: (error: ProtocolError) => void;
}

interface ParsedFields {
  readonly values: Map<string, string | string[]>;
  readonly lines: Map<string, number>;
}

function reportParseError(error: unknown, options: MarkdownParseOptions): void {
  if (error instanceof ProtocolError && options.onError) {
    options.onError(error);
    return;
  }
  throw error;
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
    throw new ProtocolError("malformed-protocol", "Unterminated Markdown fence", {
      path,
      line: lines.length,
      rule: "markdown-fence",
      hint: HINTS.fence,
    });
  }
  return sections;
}

function parseFields(lines: readonly string[], path: string, line: number): ParsedFields {
  const fields = new Map<string, string | string[]>();
  const fieldLines = new Map<string, number>();
  let activeList: string | undefined;
  let activeScalar: string | undefined;

  for (const [index, sourceLine] of lines.entries()) {
    const fieldLine = line + index + 1;
    const fieldMatch = sourceLine.match(/^([a-z][a-z_-]*)\s*:\s*(.*)$/u);
    if (fieldMatch) {
      const [, field, value] = fieldMatch;
      activeList = undefined;
      activeScalar = field;
      fields.set(field, value.trim());
      fieldLines.set(field, fieldLine);
      continue;
    }

    const bulletMatch = sourceLine.match(/^\s*-\s+(.*)$/u);
    if (bulletMatch && (activeScalar === "acceptance" || activeScalar === "validate")) {
      activeList = activeScalar;
      const existing = fields.get(activeList);
      const values = Array.isArray(existing) ? existing : [];
      values.push(bulletMatch[1].trim());
      fields.set(activeList, values);
      continue;
    }

    if (sourceLine.trim() && activeScalar && activeScalar !== "acceptance" && activeScalar !== "validate") {
      const existing = fields.get(activeScalar);
      if (typeof existing === "string") {
        fields.set(activeScalar, `${existing}\n${sourceLine.trim()}`.trim());
      }
    } else if (sourceLine.trim() && activeList) {
      const existing = fields.get(activeList);
      if (Array.isArray(existing) && existing.length > 0) {
        existing[existing.length - 1] = `${existing[existing.length - 1]}\n${sourceLine.trim()}`.trim();
      }
    }
  }

  if (fields.size === 0) {
    throw new ProtocolError("malformed-protocol", "Protocol section has no fields", {
      path,
      line,
      rule: "section-fields",
      hint: HINTS.fields,
    });
  }
  return { values: fields, lines: fieldLines };
}

function fieldLine(fields: ParsedFields, field: string, fallback: number): number {
  return fields.lines.get(field) ?? fallback;
}

function requiredString(fields: ParsedFields, field: string, path: string, line: number): string {
  const value = fields.values.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError("malformed-protocol", `Missing non-empty '${field}:'`, {
      path,
      line,
      rule: "required-field",
      hint: HINTS.requiredField,
      details: { field },
    });
  }
  return value.trim();
}

function optionalString(fields: ParsedFields, field: string): string | null {
  const value = fields.values.get(field);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listField(fields: ParsedFields, field: string): string[] {
  const value = fields.values.get(field);
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
    throw new ProtocolError("malformed-protocol", "Queue heading must contain an id and title", {
      path,
      line: lineNumber,
      rule: "queue-heading",
      hint: HINTS.queueHeading,
    });
  }
  return { id: match[1], title: match[2].trim() };
}

function parseStatus(value: string):
  | { readonly kind: "ready" }
  | { readonly kind: "in-progress"; readonly detail: string }
  | { readonly kind: "done"; readonly detail?: string }
  | { readonly kind: "blocked-by"; readonly questionId: string; readonly detail?: string }
  | { readonly kind: "draft" }
  | { readonly kind: "unknown"; readonly raw: string } {
  const trimmed = value.trim();
  if (trimmed === "ready") {
    return { kind: "ready" };
  }
  if (trimmed === "draft") {
    return { kind: "draft" };
  }
  const inProgress = trimmed.match(/^in-progress(?:\s+(.+))?$/u);
  if (inProgress) {
    if (!inProgress[1]?.trim()) {
      return { kind: "unknown", raw: trimmed };
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
  return { kind: "unknown", raw: trimmed };
}

/** `blocked-by: Q13` (comma-separated ids allowed) gates an item on questions. */
function parseBlockedBy(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRisk(value: string, path: string, line: number): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new ProtocolError("malformed-protocol", `Unsupported queue risk '${value}'`, {
    path,
    line,
    rule: "queue-risk",
    hint: HINTS.queueRisk,
  });
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
  readonly line: number;
}

export function parseQuestions(
  content: string,
  path: string,
  options: MarkdownParseOptions = {},
): readonly ParsedQuestion[] {
  const output: ParsedQuestion[] = [];
  const seen = new Set<string>();
  for (const section of sectionsOutsideFences(content, path)) {
    try {
      const match = section.heading.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(blocking|assumption)\s+(\S+)$/u);
      if (!match) {
        if (/^Q\d+(?:\s|$)/u.test(section.heading)) {
          throw new ProtocolError("malformed-protocol", `Question heading '${section.heading}' is malformed; expected a single id`, {
            path,
            line: section.startLine,
            rule: "question-heading",
            hint: HINTS.questionHeading,
          });
        }
        continue;
      }
      const [, id, date, classification, dashboardId] = match;
      if (seen.has(id)) {
        throw new ProtocolError("malformed-protocol", `Duplicate question '${id}'`, {
          path,
          line: section.startLine,
          rule: "duplicate-id",
          hint: HINTS.duplicate,
        });
      }
      seen.add(id);
      const fields = parseFields(section.lines, path, section.startLine);
      const recommendedValue = fields.values.get("recommended");
      const questionBase = {
        id,
        date,
        classification: classification as "blocking" | "assumption",
        dashboardId,
        question: requiredString(fields, "question", path, fieldLine(fields, "question", section.startLine)),
        context: requiredString(fields, "context", path, fieldLine(fields, "context", section.startLine)),
        assumed: optionalString(fields, "assumed"),
        answer: optionalString(fields, "answer"),
      };
      if (recommendedValue !== undefined) {
        output.push({
          ...questionBase,
          recommended: typeof recommendedValue === "string" && recommendedValue.trim()
            ? recommendedValue.trim()
            : null,
          line: section.startLine,
        });
      } else {
        output.push({ ...questionBase, line: section.startLine });
      }
    } catch (error) {
      reportParseError(error, options);
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
    | { readonly kind: "blocked-by"; readonly questionId: string; readonly detail?: string }
    | { readonly kind: "draft" }
    | { readonly kind: "unknown"; readonly raw: string };
  readonly blockedBy: readonly string[];
  readonly priority: number;
  readonly dependsOn: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly planPath: string;
  readonly approved: { readonly kind: "explicit"; readonly text: string } | { readonly kind: "none" };
  readonly acceptance: readonly string[];
  readonly validate: readonly string[];
  readonly notes: string | null;
  readonly line: number;
  readonly path: string;
  readonly fieldLines: ReadonlyMap<string, number>;
}

function parsePriority(value: string, path: string, line: number): number {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new ProtocolError("malformed-protocol", `Queue priority '${value}' is not an integer from 1 to 5`, {
      path,
      line,
      rule: "queue-priority",
      hint: HINTS.priority,
    });
  }
  return priority;
}

function parseDependencies(value: string, path: string, line: number): readonly string[] {
  if (value.trim() === "none") {
    return [];
  }
  const dependencies = value.split(",").map((item) => item.trim());
  if (
    dependencies.some((dependency) => !dependency) ||
    dependencies.includes("none") ||
    new Set(dependencies).size !== dependencies.length
  ) {
    throw new ProtocolError("malformed-protocol", `Invalid dependency list '${value}'`, {
      path,
      line,
      rule: "queue-dependencies",
      hint: HINTS.dependencies,
    });
  }
  return dependencies;
}

export function parseQueue(
  content: string,
  path: string,
  options: MarkdownParseOptions = {},
): readonly ParsedQueueEntry[] {
  const output: ParsedQueueEntry[] = [];
  const seen = new Set<string>();
  for (const section of sectionsOutsideFences(content, path)) {
    try {
      if (section.heading.startsWith("<DASHBOARD-ID>")) {
        continue;
      }
      const hasProtocolField = section.lines.some((line) => /^[a-z][a-z_-]*\s*:/u.test(line));
      const looksLikeDashboardId = /^[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+(?:\s|$)/u.test(section.heading);
      if (!hasProtocolField && !looksLikeDashboardId) {
        continue;
      }
      const { id, title } = parseHeader(section.heading, path, section.startLine);
      if (seen.has(id)) {
        throw new ProtocolError("malformed-protocol", `Duplicate queue item '${id}'`, {
          path,
          line: section.startLine,
          rule: "duplicate-id",
          hint: HINTS.duplicate,
        });
      }
      seen.add(id);
      const fields = parseFields(section.lines, path, section.startLine);
      const statusLine = fieldLine(fields, "status", section.startLine);
      const statusValue = requiredString(fields, "status", path, statusLine);
      const status = parseStatus(statusValue);
      const approved = requiredString(fields, "approved", path, fieldLine(fields, "approved", section.startLine));
      output.push({
        id,
        title,
        status,
        blockedBy: parseBlockedBy(fields.values.get("blocked-by") ?? fields.values.get("blocked_by")),
        priority: parsePriority(
          requiredString(fields, "priority", path, fieldLine(fields, "priority", section.startLine)),
          path,
          fieldLine(fields, "priority", section.startLine),
        ),
        dependsOn: parseDependencies(
          requiredString(fields, "depends_on", path, fieldLine(fields, "depends_on", section.startLine)),
          path,
          fieldLine(fields, "depends_on", section.startLine),
        ),
        risk: parseRisk(
          requiredString(fields, "risk", path, fieldLine(fields, "risk", section.startLine)),
          path,
          fieldLine(fields, "risk", section.startLine),
        ),
        planPath: requiredString(fields, "plan", path, fieldLine(fields, "plan", section.startLine)),
        approved: approved.toLowerCase() === "none"
          ? { kind: "none" }
          : { kind: "explicit", text: approved },
        acceptance: listField(fields, "acceptance"),
        validate: listField(fields, "validate"),
        notes: optionalString(fields, "notes"),
        line: section.startLine,
        path,
        fieldLines: new Map(fields.lines),
      });
    } catch (error) {
      reportParseError(error, options);
    }
  }
  return output;
}

export function parseCurrentState(content: string, path: string): {
  readonly state: "success" | "blocked" | "failed-safe" | "no-op";
  readonly lastRunAt: string | null;
} {
  const lines = content.split(/\r?\n/u);
  const stateLineIndex = [...lines.keys()].reverse().find((index) => lines[index]?.trim());
  const stateLine = stateLineIndex === undefined ? null : lines[stateLineIndex];
  const stateMatch = stateLine?.match(/^state:\s*(success|blocked|failed-safe|no-op)\s*$/u);
  if (!stateMatch) {
    const found = stateLine?.match(/^state:\s*(.*?)\s*$/u)?.[1]?.trim() ?? stateLine?.trim() ?? "<missing>";
    throw new ProtocolError("malformed-protocol", `Current state '${found}' is invalid`, {
      path,
      ...(stateLineIndex === undefined ? {} : { line: stateLineIndex + 1 }),
      rule: "current-state",
      hint: HINTS.currentState,
    });
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

/** Returns the final non-empty line for diagnostics without weakening parsing. */
export function lastNonEmptyLine(content: string): string | null {
  return [...content.split(/\r?\n/u)].reverse().find((line) => line.trim())?.trim() ?? null;
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

interface MarkdownTableRow {
  readonly cells: readonly string[];
  readonly line: number;
}

interface MarkdownTable {
  readonly headers: readonly string[];
  readonly rows: readonly MarkdownTableRow[];
}

function markdownTableLines(content: string, path: string, options: MarkdownParseOptions): MarkdownTable {
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^\s*\|.*\|\s*$/u.test(lines[index]) || !/^\s*\|?\s*:?-{3,}/u.test(lines[index + 1])) {
      continue;
    }
    const headers = splitTableRow(lines[index]).map((header) => header.toLowerCase());
    if (!headers.includes("id") || !headers.includes("status")) {
      continue;
    }
    const rows: MarkdownTableRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (!/^\s*\|.*\|\s*$/u.test(lines[rowIndex])) {
        break;
      }
      const cells = splitTableRow(lines[rowIndex]);
      if (cells.some(Boolean)) {
        if (cells.length !== headers.length) {
          const error = new ProtocolError("malformed-protocol", `dashboard row has ${cells.length} columns, expected ${headers.length}`, {
            path,
            line: rowIndex + 1,
            rule: "dashboard-column-count",
            hint: HINTS.dashboardColumns,
          });
          if (options.onError) {
            options.onError(error);
            continue;
          }
          throw error;
        }
        rows.push({ cells, line: rowIndex + 1 });
      }
    }
    return { headers, rows };
  }
  throw new ProtocolError("malformed-protocol", "Canonical dashboard does not contain an ID/status table", {
    path,
    rule: "dashboard-table",
    hint: HINTS.dashboardTable,
  });
}

export function parseDashboard(
  content: string,
  path: string,
  options: MarkdownParseOptions = {},
): readonly DashboardRowProjection[] {
  const table = markdownTableLines(content, path, options);
  const headers = table.headers;
  const indexOf = (name: string) => headers.indexOf(name);
  const idIndex = indexOf("id");
  const statusIndex = indexOf("status");
  const titleIndex = headers.indexOf("work item");
  const nextActionIndex = headers.findIndex((header) => header.includes("next action"));
  const evidenceIndex = headers.indexOf("evidence and canonical detail");
  const seen = new Set<string>();
  const output: DashboardRowProjection[] = [];
  for (const { cells, line } of table.rows) {
    try {
      const id = cells[idIndex]?.trim();
      if (!id) {
        throw new ProtocolError("malformed-protocol", "Dashboard row has no ID", {
          path,
          line,
          rule: "dashboard-id",
          hint: HINTS.dashboardId,
        });
      }
      if (seen.has(id)) {
        throw new ProtocolError("malformed-protocol", `Duplicate dashboard ID '${id}'`, {
          path,
          line,
          rule: "duplicate-id",
          hint: HINTS.duplicate,
        });
      }
      seen.add(id);
      output.push({
        id,
        title: cells[titleIndex] ?? "",
        status: cells[statusIndex] ?? "",
        nextAction: nextActionIndex >= 0 ? cells[nextActionIndex] ?? "" : "",
        evidence: evidenceIndex >= 0 ? cells[evidenceIndex] ?? "" : "",
      });
    } catch (error) {
      reportParseError(error, options);
    }
  }
  return output;
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
