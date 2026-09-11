import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scaffoldProtocolActionRequestSchema, type ScaffoldProtocolActionRequest } from "../src/contracts.js";
import { createScaffoldProtocolActionExecutor } from "../src/actions/scaffold.js";
import { loadProtocolTemplates } from "../src/scaffold/templates.js";
import {
  CHECKOUT,
  FakeFileSystem,
  cleanupStorages,
  makeRegistryEntry,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

const HEAD_SHA = "f".repeat(40);

function makeTerminals(
  options: { exitCode?: number; output?: string; status?: "exited" | "running" } = {},
  files?: FakeFileSystem,
) {
  const session = {
    id: "term-1",
    hostId: "host-1",
    environmentId: null,
    threadId: null,
    status: options.status ?? ("exited" as const),
    exitCode: options.exitCode ?? 0,
    cols: 120,
    rows: 30,
    title: "factory scaffold commit",
    createdAt: 0,
    updatedAt: 0,
    initialCwd: CHECKOUT,
    lastUserInputAt: null,
    closeReason: null,
  };
  const outputText = options.output ?? `[factory ${HEAD_SHA.slice(0, 7)}] ${"factory: scaffold protocol"}\n 7 files changed\n${HEAD_SHA}\n`;
  return {
    create: vi.fn<(args: Record<string, unknown>) => Promise<typeof session>>(async (args) => {
      const command = (args.start as { command?: string } | undefined)?.command ?? "";
      const outPath = />\s+'([^']+)'\s+2>&1/.exec(command)?.[1];
      if (files !== undefined && outPath !== undefined) files.put(outPath, outputText);
      return session;
    }),
    get: vi.fn(async () => session),
    close: vi.fn(async () => session),
  };
}

function makeExecutor(files = new FakeFileSystem(), terminals?: ReturnType<typeof makeTerminals>, branch = "factory") {
  terminals ??= makeTerminals({}, files);
  if (files.content(".git/HEAD") === undefined) files.seed(".git/HEAD", `ref: refs/heads/${branch}\n`);
  const store = makeStore();
  const entry = makeRegistryEntry();
  const executor = createScaffoldProtocolActionExecutor({
    sdk: { files, terminals } as never,
    store,
    repositoryLookup: (key) => (key === "monorepo" ? entry : null),
  });
  return { files, terminals, store, executor };
}

function scaffoldRequest(overrides: Partial<ScaffoldProtocolActionRequest> = {}): ScaffoldProtocolActionRequest {
  return scaffoldProtocolActionRequestSchema.parse({
    repositoryKey: "monorepo",
    action: { kind: "scaffold-protocol" },
    idempotencyKey: "bbf:v1:monorepo:scaffold-protocol:723e4567-e89b-12d3-a456-426614174000",
    ...overrides,
  });
}

const TARGETS = [
  "plans/factory/foreman.md",
  "plans/factory/repo.md",
  "plans/factory/queue.md",
  "plans/factory/questions.md",
  "plans/factory/current.md",
  "plans/README.md",
  "plans/factory/runs/.gitkeep",
];

describe("scaffold protocol executor", () => {
  it("writes every missing template inside the checkout with create-only CAS and commits on factory", async () => {
    const { files, terminals, executor } = makeExecutor();
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        action: "scaffold-protocol",
        written: TARGETS,
        skipped: [],
        commitSha: HEAD_SHA,
      },
    });
    expect(files.writes).toHaveLength(TARGETS.length);
    for (const write of files.writes) {
      expect(write.expectedSha256).toBeNull();
    }
    expect(terminals.create).toHaveBeenCalledTimes(1);
    const createArgs = terminals.create.mock.calls[0]![0] as unknown as { scope: { kind: string; hostId: string }; start: { command: string } };
    expect(createArgs.scope).toMatchObject({ kind: "host_path", hostId: "host-1" });
    expect(createArgs.start.command).toContain("git add plans");
    expect(createArgs.start.command).toContain('git commit -m "factory: scaffold protocol"');
    expect(files.content("plans/factory/foreman.md")).toBe(readFileSync(fileURLToPath(new URL("../templates/foreman.md", import.meta.url)), "utf8"));
    expect(files.content("plans/factory/runs/.gitkeep")).toBe("");
  });

  it("skips every existing file and never runs the commit", async () => {
    const files = new FakeFileSystem();
    for (const target of TARGETS) files.seed(target, "# existing\n");
    const { terminals, executor } = makeExecutor(files);
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({
      ok: true,
      result: { status: "already-applied", written: [], skipped: TARGETS, commitSha: null },
    });
    expect(files.writes).toHaveLength(0);
    expect(terminals.create).not.toHaveBeenCalled();
  });

  it("writes only the missing files in a partially scaffolded checkout", async () => {
    const files = new FakeFileSystem();
    files.seed("plans/factory/foreman.md", "# existing\n");
    files.seed("plans/README.md", "# existing\n");
    const { terminals, executor } = makeExecutor(files);
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        skipped: ["plans/factory/foreman.md", "plans/README.md"],
        commitSha: HEAD_SHA,
      },
    });
    if (result.ok) {
      expect(result.result).toMatchObject({
        written: [
          "plans/factory/repo.md",
          "plans/factory/queue.md",
          "plans/factory/questions.md",
          "plans/factory/current.md",
          "plans/factory/runs/.gitkeep",
        ],
      });
    }
    expect(files.writes).toHaveLength(5);
    expect(terminals.create).toHaveBeenCalledTimes(1);
  });

  it("treats a create-only CAS conflict as a skip, never an overwrite", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor(files);
    // A concurrent creator lands repo.md between the existence read and the write.
    files.writeHook = (path) => {
      if (path === "/repo/plans/factory/repo.md") files.put(path, "# raced\n");
    };
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        written: TARGETS.filter((target) => target !== "plans/factory/repo.md"),
        skipped: ["plans/factory/repo.md"],
      },
    });
    expect(files.content("plans/factory/repo.md")).toBe("# raced\n");
  });

  it("refuses to scaffold when the checkout is not on the factory branch", async () => {
    const { files, terminals, executor } = makeExecutor(new FakeFileSystem(), makeTerminals(), "main");
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "checkout-invalid" } });
    if (!result.ok) {
      expect(result.error.message).toContain("'main'");
      expect(result.error.message).toContain("never creates or switches branches");
    }
    expect(files.writes).toHaveLength(0);
    expect(terminals.create).not.toHaveBeenCalled();
  });

  it("refuses when the checkout branch cannot be read at all", async () => {
    const files = new FakeFileSystem();
    const terminals = makeTerminals();
    const store = makeStore();
    const entry = makeRegistryEntry();
    const executor = createScaffoldProtocolActionExecutor({
      sdk: { files, terminals } as never,
      store,
      repositoryLookup: (key) => (key === "monorepo" ? entry : null),
    });
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "checkout-invalid" } });
    if (!result.ok) expect(result.error.message).toContain("no branch");
    expect(terminals.create).not.toHaveBeenCalled();
  });

  it("surfaces the terminal output when the scaffold commit fails", async () => {
    const files = new FakeFileSystem();
    const terminals = makeTerminals({ exitCode: 1, output: "Author identity unknown\nfatal: unable to auto-detect email address\n" }, files);
    const { executor, store } = makeExecutor(files, terminals);
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    if (!result.ok) expect(result.error.message).toContain("unable to auto-detect email");
    expect(files.writes).toHaveLength(TARGETS.length);
    const record = store.getPendingActionIntent("bbf:v1:monorepo:scaffold-protocol:723e4567-e89b-12d3-a456-426614174000");
    expect(record?.status).toBe("completed");
  });

  it("marks the intent for reconciliation when the commit result cannot be verified", async () => {
    const files = new FakeFileSystem();
    const terminals = makeTerminals({ status: "running" }, files);
    terminals.get.mockRejectedValue(new Error("host connection dropped"));
    const { executor, store } = makeExecutor(files, terminals);
    const result = await executor.execute(scaffoldRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!result.ok) expect(result.error.message).toContain("reconciliation");
    const record = store.getPendingActionIntent("bbf:v1:monorepo:scaffold-protocol:723e4567-e89b-12d3-a456-426614174000");
    expect(record?.status).toBe("reconciliation-required");
  });

  it("replays the recorded result for an idempotent retry without rewriting", async () => {
    const { files, terminals, executor } = makeExecutor();
    const request = scaffoldRequest();
    const first = await executor.execute(request);
    const second = await executor.execute(request);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(files.writes).toHaveLength(TARGETS.length);
    expect(terminals.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a checkout outside the configured root via path confinement", async () => {
    const { files, executor } = makeExecutor();
    const result = await executor.execute(scaffoldRequest());
    expect(result.ok).toBe(true);
    for (const write of files.writes) {
      expect(write.path.startsWith(`${CHECKOUT}/`)).toBe(true);
    }
  });
});

describe("protocol template manifest", () => {
  it("loads every manifest entry and verifies each recorded digest", () => {
    const templates = loadProtocolTemplates();
    expect(templates.map((template) => template.target)).toEqual(TARGETS);
    for (const template of templates) {
      expect(createHash("sha256").update(template.content, "utf8").digest("hex")).toBe(template.sha256);
    }
  });

  it("keeps MANIFEST.json digests in sync with the template files", () => {
    const root = fileURLToPath(new URL("../templates", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")) as {
      files: { template: string; target: string; sha256: string }[];
    };
    expect(manifest.files.map((entry) => entry.target)).toEqual(TARGETS);
    for (const entry of manifest.files) {
      const content = readFileSync(join(root, entry.template), "utf8");
      expect(createHash("sha256").update(content, "utf8").digest("hex")).toBe(entry.sha256);
    }
  });
});
