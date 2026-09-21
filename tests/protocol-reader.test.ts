import { posix } from "node:path";

import { describe, expect, it } from "vitest";
import { protocolSnapshotSchema, type RepositoryConfiguration } from "../src/contracts.js";
import {
  confinedPath,
  digestText,
  parseCurrentState,
  parseDashboard,
  parseQueue,
  parseQuestions,
  readTextFile,
  RepositoryProtocolReader,
  staticMergeReader,
  type ProtocolFileReadArgs,
  type ProtocolFiles,
  type ProtocolPathListArgs,
  type ProtocolPathListResult,
} from "../src/protocol/index.js";

const checkoutPath = "/workspace/monorepo-factory";
const configuration: RepositoryConfiguration = {
  repositoryKey: "monorepo",
  repositoryRoot: "/workspace/monorepo",
  connectedHostId: "host-mac",
  checkoutPath,
  factoryBranch: "factory",
  mainRef: "origin/main",
};

const mergeProjection = {
  gitCommit: "abcdef1",
  factoryAhead: 2,
  mainBehind: 0,
  taskCommits: [{ sha: "1234567", subject: "Implement the eligible task" }],
  safeFastForward: true,
} as const;

const archiveTask = (id: string, status: string, dependsOn = "none") => `## ${id} Archive test task
status: ${status}
priority: 1
depends_on: ${dependsOn}
risk: low
plan: plans/tasks/archive.md
approved: explicit approval
acceptance:
- completed work stays visible
validate:
- pnpm test
`;

const archiveSource = {
  "plans/factory/foreman.md": "# Foreman\n",
  "plans/factory/repo.md": "# Repo\n",
  "plans/factory/queue.md": archiveTask("TASK-ready", "ready"),
  "plans/factory/questions.md": "# Questions\n",
  "plans/factory/current.md": "# Current\nstate: no-op\n",
  "plans/README.md": "| ID | Status |\n| --- | --- |\n",
};

const archiveReader = (source: Record<string, string>) => new RepositoryProtocolReader(makeFiles(source), {
  mergeReader: staticMergeReader(mergeProjection),
  now: () => new Date("2026-09-10T06:00:00Z"),
});

describe("repository protocol reader", () => {
  it("preserves the legacy snapshot when done.md is missing", async () => {
    const snapshot = await archiveReader(archiveSource).loadSnapshot(configuration);
    const fileDigests = Object.fromEntries(Object.entries(archiveSource).map(([path, content]) => [path, digestText(content)]));
    const revision = {
      gitCommit: mergeProjection.gitCommit,
      protocolDigest: digestText(Object.entries(fileDigests).map(([path, sha256]) => `${path}\0${sha256}`).sort().join("\n")),
      fileDigests,
    };
    expect(snapshot).toEqual({
      repository: configuration,
      revision,
      capturedAt: "2026-09-10T06:00:00.000Z",
      foremanTemplate: {
        authority: "repository-protocol",
        relativePath: "plans/factory/foreman.md",
        contentSha256: fileDigests["plans/factory/foreman.md"],
        repositoryRevision: revision,
      },
      queue: [{
        id: "TASK-ready", title: "Archive test task", status: { kind: "ready" },
        priority: 1, dependsOn: [], risk: "low", planPath: "plans/tasks/archive.md",
        approved: { kind: "explicit", source: "queue.approved", text: "explicit approval" },
        acceptance: ["completed work stays visible"], validate: ["pnpm test"], notes: null,
        blockingQuestionIds: [], staleBlockingQuestionIds: [], blockedBy: [], eligible: true, eligibilityReasons: [],
      }],
      questions: [],
      dashboard: {
        canonicalPath: "plans/README.md", factoryBranch: "factory", mainRef: configuration.mainRef,
        factoryAhead: 2, mainBehind: 0, taskCommits: mergeProjection.taskCommits,
        safeFastForward: true, canonicalDashboardUrl: null,
      },
      currentRun: { state: "no-op", lastRunAt: null, currentPath: "plans/factory/current.md", latestRunPath: null },
    });
  });

  it("unions archived done tasks after queue tasks and satisfies their dependencies", async () => {
    const snapshot = await archiveReader({
      ...archiveSource,
      "plans/factory/queue.md": archiveTask("TASK-ready", "ready", "TASK-done"),
      "plans/factory/done.md": archiveTask("TASK-done", "done (run 20260910T053015Z)"),
    }).loadSnapshot(configuration);
    expect(snapshot.queue.map((entry) => entry.id)).toEqual(["TASK-ready", "TASK-done"]);
    expect(snapshot.queue[0]).toMatchObject({ eligible: true, eligibilityReasons: [], dependsOn: ["TASK-done"] });
    expect(snapshot.queue[1]).toMatchObject({
      status: { kind: "done", detail: "(run 20260910T053015Z)" },
      eligible: false, eligibilityReasons: ["not-ready"],
    });
  });

  it("rejects duplicate queue ids across queue.md and done.md", async () => {
    await expect(archiveReader({
      ...archiveSource,
      "plans/factory/done.md": archiveTask("TASK-ready", "done (run 20260910T053015Z)"),
    }).loadSnapshot(configuration)).rejects.toMatchObject({
      code: "malformed-protocol",
      message: "Duplicate queue item 'TASK-ready' across queue.md and done.md",
    });
  });

  it("includes done.md in file digests and the protocol digest when present", async () => {
    const done = archiveTask("TASK-done", "done (run 20260910T053015Z)");
    const snapshot = await archiveReader({ ...archiveSource, "plans/factory/done.md": done }).loadSnapshot(configuration);
    expect(snapshot.revision.fileDigests["plans/factory/done.md"]).toBe(digestText(done));
    const expectedDigest = digestText(Object.entries({ ...archiveSource, "plans/factory/done.md": done })
      .map(([path, content]) => `${path}\0${digestText(content)}`).sort().join("\n"));
    expect(snapshot.revision.protocolDigest).toBe(expectedDigest);
    const withoutDone = await archiveReader(archiveSource).loadSnapshot(configuration);
    expect(snapshot.revision.protocolDigest).not.toBe(withoutDone.revision.protocolDigest);
  });
  it("discovers the repository protocol without rewriting custom source forms", async () => {
    const files = makeFiles({
      "plans/factory/foreman.md": "# Repository foreman\nUse the repository workflow.\n",
      "plans/factory/repo.md": "# Repository policy\nCustom repository checks remain authoritative.\n",
      "plans/factory/queue.md": `# Queue

~~~markdown
## <DASHBOARD-ID> Template item
status: ready
~~~

## TASK-ready Eligible task
status: ready
priority: 1
depends_on: none
risk: medium
plan: plans/tasks/ready.md
approved: approved by the operator for this task
acceptance:
- behavior is correct
validate:
- pnpm test
notes: Keep the source wording intact.

## TASK-blocked Needs a question
status: ready
priority: 2
depends_on: none
risk: low
plan: plans/tasks/blocked.md
approved: none
acceptance:
- question is resolved
validate:
- pnpm test

## TASK-dependent Depends on blocked work
status: ready
priority: 3
depends_on: TASK-blocked
risk: low
plan: plans/tasks/dependent.md
approved: explicit approval
acceptance:
- dependency is complete
validate:
- pnpm test
`,
      "plans/factory/questions.md": `# Questions

~~~markdown
## <ID> <DATE> <classification> <dashboard-id>
question: template text
~~~

## Q1 2026-09-10 blocking TASK-blocked
question: Which data source is authoritative?
context: The queue item has two candidate sources.
assumed: null
answer:

## Q2 2026-09-10 assumption TASK-ready
question: Is the existing fixture sufficient?
context: This is an explicit assumption, not a blocker.
answer: yes
`,
      "plans/factory/current.md": "# Latest run\nRun 20260910T053015Z was blocked.\nstate: blocked\n",
      "plans/README.md": `# Dashboard

| ID | Work item | Status | Next action or remaining outcome | Evidence and canonical detail |
| --- | --- | --- | --- | --- |
| TASK-ready | [Eligible task](factory/tasks/ready.md) | ready | Run when selected | [queue](plans/factory/queue.md) |
| TASK-blocked | Needs a question | blocked | Answer Q1 | [question](plans/factory/questions.md#q1) |
`,
      "plans/factory/runs/20260910T053015Z-run-a.md": "# Immutable run record\nstate: blocked\nOriginal run content.\n",
    }, {
      ok: false,
      error: {
        code: "handler_error",
        message: `HTTP 404: Path does not exist: ${checkoutPath}/plans/factory/lock`,
      },
    }, "plans/factory/lock");
    const reader = new RepositoryProtocolReader(files, {
      mergeReader: staticMergeReader(mergeProjection),
      now: () => new Date("2026-09-10T06:00:00Z"),
    });

    const projection = await reader.loadProjection(configuration);
    const snapshot = protocolSnapshotSchema.parse(projection.snapshot);
    const ready = snapshot.queue.find((entry) => entry.id === "TASK-ready");
    const blocked = snapshot.queue.find((entry) => entry.id === "TASK-blocked");
    const dependent = snapshot.queue.find((entry) => entry.id === "TASK-dependent");

    expect(snapshot.foremanTemplate).toMatchObject({
      authority: "repository-protocol",
      relativePath: "plans/factory/foreman.md",
      contentSha256: digestText("# Repository foreman\nUse the repository workflow.\n"),
    });
    expect(snapshot.foremanTemplate.repositoryRevision).toEqual(snapshot.revision);
    expect(snapshot.revision.gitCommit).toBe("abcdef1");
    expect(snapshot.revision.fileDigests["plans/factory/repo.md"]).toBe(
      digestText("# Repository policy\nCustom repository checks remain authoritative.\n"),
    );
    expect(ready).toMatchObject({
      eligible: true,
      eligibilityReasons: [],
      approved: { kind: "explicit", source: "queue.approved", text: "approved by the operator for this task" },
    });
    expect(blocked).toMatchObject({
      eligible: false,
      eligibilityReasons: ["blocking-question", "missing-authorization"],
      blockingQuestionIds: ["Q1"],
    });
    expect(dependent).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.questions.find((question) => question.id === "Q1")).not.toHaveProperty("recommended");
    expect(snapshot.questions.find((question) => question.id === "Q2")).toMatchObject({ answer: "yes" });
    expect(snapshot.currentRun).toEqual({
      state: "blocked",
      lastRunAt: "2026-09-10T05:30:15Z",
      currentPath: "plans/factory/current.md",
      latestRunPath: "plans/factory/runs/20260910T053015Z-run-a.md",
    });
    expect(snapshot.dashboard).toMatchObject({
      canonicalPath: "plans/README.md",
      factoryAhead: 2,
      mainBehind: 0,
      safeFastForward: true,
    });
    expect(projection.dashboard.rows).toHaveLength(2);
    expect(projection.dashboard.content).toContain("Evidence and canonical detail");
    expect(projection.runRecords[0]).toMatchObject({
      relativePath: "plans/factory/runs/20260910T053015Z-run-a.md",
      state: "blocked",
      content: "# Immutable run record\nstate: blocked\nOriginal run content.\n",
    });
    expect(projection.lock).toBeNull();
    expect(files.readCalls).toContainEqual(
      expect.objectContaining({ path: `${checkoutPath}/plans/factory/lock` }),
    );

    const rawMissingLockFiles: ProtocolFiles = {
      async read(args) {
        if (args.path === `${checkoutPath}/plans/factory/lock`) {
          throw new Error(`HTTP 404: Path does not exist: ${checkoutPath}/plans/factory/lock`);
        }
        return files.read(args);
      },
      async listPaths(args) {
        return files.listPaths(args);
      },
    };
    const rawProjection = await new RepositoryProtocolReader(rawMissingLockFiles, {
      mergeReader: staticMergeReader(mergeProjection),
      now: () => new Date("2026-09-10T06:00:00Z"),
    }).loadProjection(configuration);
    expect(rawProjection.lock).toBeNull();

    expect(files.readCalls.every((call) => call.hostId === "host-mac" && call.rootPath === checkoutPath)).toBe(true);
    expect(files.listCalls).toHaveLength(2);
    expect(files.listCalls).toEqual([
      expect.objectContaining({ hostId: "host-mac", includeFiles: true, includeDirectories: false }),
      expect.objectContaining({ hostId: "host-mac", includeFiles: true, includeDirectories: false }),
    ]);
  });

  it("returns actionable typed errors for malformed files, host loss, and confinement violations", async () => {
    expect(() => confinedPath("/workspace/repo", "../outside.md")).toThrowError(
      expect.objectContaining({ code: "path-traversal" }),
    );
    expect(() => parseQueue("## TASK-1 bad\nstatus: ready\n", "plans/factory/queue.md")).toThrowError(
      expect.objectContaining({ code: "malformed-protocol" }),
    );
    expect(() => parseQuestions("## Q1 2026-09-10 blocking TASK-1\nquestion: missing context\n", "plans/factory/questions.md"))
      .toThrowError(expect.objectContaining({ code: "malformed-protocol" }));
    expect(() => parseQuestions(
      "## Q1 2026-09-10 blocking TASK-1 and TASK-2\nquestion: q\ncontext: c\n",
      "plans/factory/questions.md",
    )).toThrowError(expect.objectContaining({
      code: "malformed-protocol",
      message: expect.stringContaining("single id"),
    }));
    expect(() => parseCurrentState("# run\nstate: unknown\n", "plans/factory/current.md")).toThrowError(
      expect.objectContaining({ code: "malformed-protocol" }),
    );
    expect(() => parseCurrentState("# run\n  state: success\n", "plans/factory/current.md")).toThrowError(
      expect.objectContaining({ code: "malformed-protocol" }),
    );
    expect(() => parseDashboard("# dashboard\n\n| Name | Status |\n| --- | --- |\n| x | ready |\n", "plans/README.md"))
      .toThrowError(expect.objectContaining({ code: "malformed-protocol" }));

    const files = makeFiles({}, "host offline");
    const reader = new RepositoryProtocolReader(files, { mergeReader: staticMergeReader(mergeProjection) });
    await expect(reader.loadSnapshot(configuration)).rejects.toMatchObject({
      code: "host-unavailable",
      repositoryKey: "monorepo",
      path: "plans/factory/foreman.md",
    });

    const permissionFiles = makeFiles({}, {
      ok: false,
      error: {
        code: "handler_error",
        message: `HTTP 404: Permission denied: ${checkoutPath}/plans/factory/lock`,
      },
    }, "plans/factory/lock");
    await expect(readTextFile(permissionFiles, {
      hostId: "host-mac",
      rootPath: checkoutPath,
      relativePath: "plans/factory/lock",
    })).rejects.toMatchObject({
      code: "invalid-file-response",
      path: "plans/factory/lock",
    });

    const permissionPathNotFoundFiles = makeFiles({}, {
      ok: false,
      error: {
        code: "permission_denied",
        message: "path_not_found",
      },
    }, "plans/factory/lock");
    await expect(readTextFile(permissionPathNotFoundFiles, {
      hostId: "host-mac",
      rootPath: checkoutPath,
      relativePath: "plans/factory/lock",
    })).rejects.toMatchObject({
      code: "invalid-file-response",
      path: "plans/factory/lock",
    });
  });

  it("tolerates a blocked-by field and unknown statuses instead of failing the queue", async () => {
    const parsed = parseQueue(`# Queue

## DATA-0009.01 July close-roll plug
status: ready
blocked-by: Q13
priority: 1
depends_on: none
risk: high
plan: docs/close/inventory-close-findings.md (the 2026-09-06 plug entry); artifacts/july-freight-gap-ask.md
approved: none
acceptance:
- done
validate:
- bq query
notes: Do not start until Finance answers Q3.

## DATA-0064 Drifted row
status: frobnicate
priority: 2
depends_on: none
risk: low
plan: plans/x.md
approved: none
acceptance:
- done
validate:
- pnpm test

## DATA-0099 Proposed row
status: draft
priority: 3
depends_on: none
risk: low
plan: plans/y.md
approved: none
acceptance:
- done
validate:
- pnpm test
`, "plans/factory/queue.md");
    expect(parsed[0]?.status).toEqual({ kind: "ready" });
    expect(parsed[0]?.blockedBy).toEqual(["Q13"]);
    expect(parsed[1]?.status).toEqual({ kind: "unknown", raw: "frobnicate" });
    expect(parsed[2]?.status).toEqual({ kind: "draft" });

    const files = makeFiles({
      "plans/factory/foreman.md": "# Foreman\n",
      "plans/factory/repo.md": "# Repo\n",
      "plans/factory/queue.md": `# Queue

## DATA-0009.01 July close-roll plug
status: ready
blocked-by: Q13
priority: 1
depends_on: none
risk: high
plan: docs/close/inventory-close-findings.md (the 2026-09-06 plug entry); artifacts/july-freight-gap-ask.md
approved: none
acceptance:
- done
validate:
- bq query

## DATA-0064 Drifted row
status: frobnicate
priority: 2
depends_on: none
risk: low
plan: plans/x.md
approved: none
acceptance:
- done
validate:
- pnpm test

## DATA-0099 Proposed row
status: draft
priority: 3
depends_on: none
risk: low
plan: plans/y.md
approved: none
acceptance:
- done
validate:
- pnpm test
`,
      "plans/factory/questions.md": `# Questions

## Q13 2026-09-10 blocking DATA-0009.01
question: Which plug approach is accepted?
context: Two options are on the table.
answer:
`,
      "plans/factory/current.md": "# Latest\nstate: no-op\n",
      "plans/README.md": "| id | work item | status | next action | evidence |\n|---|---|---|---|---|\n| DATA-0009.01 | plug | ready | run | queue |\n",
    });
    const snapshot = await new RepositoryProtocolReader(files, {
      mergeReader: staticMergeReader(mergeProjection),
    }).loadSnapshot(configuration);
    const gated = snapshot.queue.find((entry) => entry.id === "DATA-0009.01");
    const drifted = snapshot.queue.find((entry) => entry.id === "DATA-0064");
    expect(gated).toMatchObject({
      status: { kind: "ready" },
      blockedBy: ["Q13"],
      blockingQuestionIds: ["Q13"],
      eligible: false,
    });
    expect(gated?.eligibilityReasons).toContain("blocking-question");
    expect(gated?.eligibilityReasons).toContain("high-risk-approval-missing");
    expect(drifted).toMatchObject({
      status: { kind: "unknown", raw: "frobnicate" },
      eligible: false,
    });
    expect(drifted?.eligibilityReasons).toContain("not-ready");
    const proposed = snapshot.queue.find((entry) => entry.id === "DATA-0099");
    expect(proposed).toMatchObject({
      status: { kind: "draft" },
      eligible: false,
    });
    expect(proposed?.eligibilityReasons).toEqual(["not-ready"]);
  });

  it("flags a blocked-by status whose question is answered or missing as a stale gate", async () => {
    const files = makeFiles({
      "plans/factory/foreman.md": "# Foreman\n",
      "plans/factory/repo.md": "# Repo\n",
      "plans/factory/queue.md": `# Queue

## DATA-0007.04 Answered gate
status: blocked-by: Q6 (BigQuery pipe creation outstanding)
priority: 2
depends_on: none
risk: medium
plan: plans/x.md
approved: none
acceptance:
- done
validate:
- pnpm test

## DATA-0007.05 Missing gate
status: blocked-by: Q99
priority: 2
depends_on: none
risk: low
plan: plans/y.md
approved: none
acceptance:
- done
validate:
- pnpm test

## DATA-0007.06 Open gate
status: blocked-by: Q13
priority: 2
depends_on: none
risk: low
plan: plans/z.md
approved: none
acceptance:
- done
validate:
- pnpm test
`,
      "plans/factory/questions.md": `# Questions

## Q6 2026-09-05 blocking DATA-0007.04
question: Which property and pipe?
context: Half answered by observation.
answer: The property is 251473810; the pipe still needs a human.

## Q13 2026-09-10 blocking DATA-0007.06
question: Still open?
context: Waiting on the human.
answer:
`,
      "plans/factory/current.md": "# Latest\nstate: no-op\n",
      "plans/README.md": "| id | work item | status | next action | evidence |\n|---|---|---|---|---|\n| DATA-0007.04 | gate | blocked | run | queue |\n",
    });
    const snapshot = await new RepositoryProtocolReader(files, {
      mergeReader: staticMergeReader(mergeProjection),
    }).loadSnapshot(configuration);

    const answered = snapshot.queue.find((entry) => entry.id === "DATA-0007.04");
    expect(answered).toMatchObject({
      status: { kind: "blocked-by", questionId: "Q6", detail: "(BigQuery pipe creation outstanding)" },
      blockingQuestionIds: [],
      staleBlockingQuestionIds: ["Q6"],
      blockedBy: ["Q6"],
      eligible: false,
    });
    expect(answered?.eligibilityReasons).toContain("stale-question-gate");
    expect(answered?.eligibilityReasons).not.toContain("blocking-question");

    const missing = snapshot.queue.find((entry) => entry.id === "DATA-0007.05");
    expect(missing).toMatchObject({
      status: { kind: "blocked-by", questionId: "Q99" },
      blockingQuestionIds: [],
      staleBlockingQuestionIds: ["Q99"],
      eligible: false,
    });
    expect(missing?.eligibilityReasons).toContain("stale-question-gate");

    const open = snapshot.queue.find((entry) => entry.id === "DATA-0007.06");
    expect(open).toMatchObject({
      status: { kind: "blocked-by", questionId: "Q13" },
      blockingQuestionIds: ["Q13"],
      staleBlockingQuestionIds: [],
      eligible: false,
    });
    expect(open?.eligibilityReasons).toContain("blocking-question");
    expect(open?.eligibilityReasons).not.toContain("stale-question-gate");
  });

  it("supports base64 file responses and compact or colonized run timestamps", async () => {
    const content = "# A UTF-8 protocol file\n";
    const files: ProtocolFiles = {
      async read(args) {
        return {
          content: Buffer.from(content, "utf8").toString("base64"),
          contentEncoding: "base64",
          path: args.path,
          sha256: digestText(content),
          sizeBytes: Buffer.byteLength(content),
        };
      },
      async listPaths(args) {
        void args;
        return { paths: [], truncated: false };
      },
    };
    await expect(readTextFile(files, {
      hostId: "host-mac",
      rootPath: checkoutPath,
      relativePath: "plans/factory/foreman.md",
    })).resolves.toMatchObject({ content, sha256: digestText(content) });
    expect(parseCurrentState("Run 2026-09-10T05:30:15Z\nstate: no-op\n", "plans/factory/current.md")).toEqual({
      state: "no-op",
      lastRunAt: "2026-09-10T05:30:15Z",
    });
    expect(parseDashboard(
      "| ID | Work Item | Status |\n| --- | --- | --- |\n| A-1 | Work | ready |\n",
      "plans/README.md",
    )).toEqual([{ id: "A-1", title: "Work", status: "ready", nextAction: "", evidence: "" }]);
  });
});

class MemoryProtocolFiles implements ProtocolFiles {
  readonly readCalls: ProtocolFileReadArgs[] = [];
  readonly listCalls: ProtocolPathListArgs[] = [];

  constructor(
    private readonly source: Readonly<Record<string, string>>,
    private readonly readFailure?: unknown,
    private readonly readFailurePath?: string,
  ) {}

  async read(args: ProtocolFileReadArgs) {
    this.readCalls.push(args);
    const relativePath = posix.relative(args.rootPath ?? checkoutPath, args.path);
    if (this.readFailure !== undefined &&
      (this.readFailurePath === undefined || relativePath === this.readFailurePath)) {
      throw typeof this.readFailure === "string" ? new Error(this.readFailure) : this.readFailure;
    }
    const content = this.source[relativePath];
    if (content === undefined) {
      throw new Error("ENOENT: no such file or directory");
    }
    return {
      content,
      contentEncoding: "utf8" as const,
      path: args.path,
      sha256: digestText(content),
      sizeBytes: Buffer.byteLength(content),
    };
  }

  async listPaths(args: ProtocolPathListArgs): Promise<ProtocolPathListResult> {
    this.listCalls.push(args);
    const relativeDirectory = posix.relative(checkoutPath, args.path).replace(/\/$/u, "");
    const prefix = `${relativeDirectory}/`;
    const paths = Object.keys(this.source)
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map((path) => ({ kind: "file" as const, name: posix.basename(path), path }));
    if (paths.length === 0) {
      throw new Error("ENOENT: no such file or directory");
    }
    return { paths, truncated: false };
  }
}

function makeFiles(
  source: Readonly<Record<string, string>>,
  readFailure?: unknown,
  readFailurePath?: string,
): MemoryProtocolFiles {
  return new MemoryProtocolFiles(source, readFailure, readFailurePath);
}
