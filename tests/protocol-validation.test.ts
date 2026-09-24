import { describe, expect, it } from "vitest";
import { formatProtocolDiagnostic, validateProtocolFiles, type ProtocolFileContents } from "../src/protocol/index.js";

const validFiles = (overrides: Partial<ProtocolFileContents> = {}): ProtocolFileContents => ({
  repo: "# Repository rules\n",
  queue: [
    "# Queue",
    "",
    "## TASK-1 Sample task",
    "status: done",
    "priority: 2",
    "depends_on: none",
    "risk: low",
    "plan: plans/task.md",
    "approved: none",
    "acceptance:",
    "- complete",
    "validate:",
    "- pnpm test",
    "notes: none",
    "",
  ].join("\n"),
  questions: "# Questions\n",
  current: "# Current\nstate: no-op\n",
  dashboard: [
    "# Dashboard",
    "",
    "| id | work item | status | next action | evidence and canonical detail |",
    "|---|---|---|---|---|",
    "| TASK-1 | Sample task | Done | none | complete |",
    "",
  ].join("\n"),
  ...overrides,
});

describe("protocol validation diagnostics", () => {
  it.each([
    ["a literal pipe in evidence", "| TASK-1 | Sample task | Done | none | first|second |", "dashboard-column-count", 5],
    ["a sentence separator in evidence", "| TASK-1 | Sample task | Done | none | first | second |", "dashboard-column-count", 5],
  ])("reports %s with its dashboard location", (_name, row, rule, line) => {
    const diagnostics = validateProtocolFiles(validFiles({
      dashboard: [
        "# Dashboard",
        "",
        "| id | work item | status | next action | evidence and canonical detail |",
        "|---|---|---|---|---|",
        row,
        "",
      ].join("\n"),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      path: "plans/README.md",
      line,
      rule,
      hint: "escape a literal pipe inside a cell as \\|",
    }));
    expect(formatProtocolDiagnostic(diagnostics[0]!)).toBe(
      "plans/README.md:5: dashboard row has 6 columns, expected 5 (rule dashboard-column-count). Fix: escape a literal pipe inside a cell as \\|",
    );
  });

  it("reports the invalid current state and all valid values", () => {
    const diagnostics = validateProtocolFiles(validFiles({ current: "# Current\nsummary\nstate: idle\n" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      path: "plans/factory/current.md",
      line: 3,
      rule: "current-state",
    }));
    expect(formatProtocolDiagnostic(diagnostics[0]!)).toBe(
      "plans/factory/current.md:3: Current state 'idle' is invalid (rule current-state). Fix: end the file with state: success, blocked, failed-safe, or no-op",
    );
  });

  it("collects problems across protocol files in one pass", () => {
    const diagnostics = validateProtocolFiles(validFiles({
      queue: "# Queue\n\n## TASK-1 Sample task\nstatus: idle\npriority: 2\ndepends_on: none\nrisk: low\nplan: plans/task.md\napproved: none\n",
      current: "# Current\nstate: idle\n",
      dashboard: "# Dashboard\n\n| id | work item | status | next action | evidence and canonical detail |\n|---|---|---|---|---|\n| TASK-1 | Sample | Done | none | first | second |\n",
    }));
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
      "queue-status",
      "current-state",
      "dashboard-column-count",
    ]);
    expect(diagnostics[0]?.line).toBe(4);
  });

  it("collects every malformed queue entry and dashboard row in each file", () => {
    const diagnostics = validateProtocolFiles(validFiles({
      queue: [
        "# Queue",
        "",
        "## TASK-1 First task",
        "status: idle",
        "priority: 2",
        "depends_on: none",
        "risk: low",
        "plan: plans/task-1.md",
        "approved: none",
        "",
        "## TASK-2 Second task",
        "status: waiting",
        "priority: 2",
        "depends_on: none",
        "risk: low",
        "plan: plans/task-2.md",
        "approved: none",
        "",
      ].join("\n"),
      dashboard: [
        "# Dashboard",
        "",
        "| id | work item | status | next action | evidence and canonical detail |",
        "|---|---|---|---|---|",
        "| TASK-1 | First | Done | none | first | second |",
        "| TASK-2 | Second | Done | none | third | fourth |",
        "",
      ].join("\n"),
    }));

    expect(diagnostics.map(({ path, line, rule }) => ({ path, line, rule }))).toEqual([
      { path: "plans/factory/queue.md", line: 4, rule: "queue-status" },
      { path: "plans/factory/queue.md", line: 12, rule: "queue-status" },
      { path: "plans/README.md", line: 5, rule: "dashboard-column-count" },
      { path: "plans/README.md", line: 6, rule: "dashboard-column-count" },
    ]);
  });

  it("continues through every malformed question section in one file", () => {
    const diagnostics = validateProtocolFiles(validFiles({
      questions: [
        "# Questions",
        "",
        "## Q1 2026-09-24 blocking TASK-1",
        "question: first question",
        "",
        "## Q2 2026-09-24 blocking TASK-2",
        "context: second context",
        "",
      ].join("\n"),
    }));

    expect(diagnostics.map(({ path, line, rule }) => ({ path, line, rule }))).toEqual([
      { path: "plans/factory/questions.md", line: 3, rule: "required-field" },
      { path: "plans/factory/questions.md", line: 6, rule: "required-field" },
    ]);
  });

  it("accepts a valid fixture repository", () => {
    expect(validateProtocolFiles(validFiles())).toEqual([]);
  });
});
