import { afterEach, describe, expect, it } from "vitest";
import { provisionCheckoutActionRequestSchema, type ProvisionCheckoutActionRequest } from "../src/contracts.js";
import { createProvisionCheckoutActionExecutor, parseWorktreeList } from "../src/actions/provision.js";
import {
  CHECKOUT,
  FakeFileSystem,
  cleanupStorages,
  makeHostTerminals,
  makeHostsProbe,
  makeRegistryEntry,
  makeStore,
} from "./fakes.js";

afterEach(cleanupStorages);

const ROOT = CHECKOUT;
const WORKTREE = `${ROOT}-factory`;
const GITDIR = `${ROOT}/.git/worktrees/repo-factory`;

/** Porcelain list for a checkout on main with no factory worktree. */
const LIST_MAIN_ONLY = `worktree ${ROOT}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\n`;
const LIST_WITH_FACTORY_WORKTREE =
  LIST_MAIN_ONLY + `worktree ${WORKTREE}\nHEAD ${"b".repeat(40)}\nbranch refs/heads/factory\n\n`;
const LIST_FACTORY_ELSEWHERE =
  `worktree ${ROOT}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\n` +
  `worktree /elsewhere\nHEAD ${"c".repeat(40)}\nbranch refs/heads/factory\n\n`;

/** Seeds the .git pointer pair a fresh worktree add would create. */
function seedProvisionedWorktree(files: FakeFileSystem): void {
  files.put(`${WORKTREE}/.git`, `gitdir: ${GITDIR}\n`);
  files.put(`${GITDIR}/HEAD`, `ref: refs/heads/factory\n`);
}

function seedGitRoot(files: FakeFileSystem, branch = "main"): void {
  files.seed(".git/HEAD", `ref: refs/heads/${branch}\n`);
}

interface HarnessOptions {
  readonly files?: FakeFileSystem;
  readonly terminals?: ReturnType<typeof makeHostTerminals>;
  readonly configured?: boolean;
}

function makeExecutor(options: HarnessOptions = {}) {
  const files = options.files ?? new FakeFileSystem();
  const terminals = options.terminals ?? makeHostTerminals();
  const hosts = makeHostsProbe(files);
  const store = makeStore();
  const entry = makeRegistryEntry();
  const configured = options.configured ?? true;
  const executor = createProvisionCheckoutActionExecutor({
    sdk: { files, terminals, hosts } as never,
    store,
    repositoryLookup: (key) => (configured && key === "monorepo" ? entry : null),
  });
  return { files, terminals, hosts, store, executor };
}

let uuidCounter = 0;
function provisionRequest(overrides: {
  mode?: "worktree" | "direct";
  repositoryKey?: string;
  explicitTarget?: boolean;
} = {}): ProvisionCheckoutActionRequest {
  uuidCounter += 1;
  const repositoryKey = overrides.repositoryKey ?? "monorepo";
  const explicitTarget = overrides.explicitTarget ?? true;
  return provisionCheckoutActionRequestSchema.parse({
    repositoryKey,
    action: {
      kind: "provision-checkout",
      mode: overrides.mode ?? "worktree",
      ...(explicitTarget ? { hostId: "host-1", repositoryRoot: ROOT } : {}),
    },
    idempotencyKey: `bbf:v1:${repositoryKey}:provision-checkout:${String(uuidCounter).padStart(8, "0")}-0000-4000-8000-000000000000`,
  });
}

describe("parseWorktreeList", () => {
  it("parses worktree, branch, detached, and bare records", () => {
    const porcelain = [
      `worktree ${ROOT}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "",
      `worktree ${WORKTREE}`,
      `HEAD ${"b".repeat(40)}`,
      "branch refs/heads/factory",
      "",
      "worktree /detached",
      `HEAD ${"c".repeat(40)}`,
      "detached",
      "",
      "worktree /bare-repo",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: ROOT, branch: "main" },
      { path: WORKTREE, branch: "factory" },
      { path: "/detached", branch: null },
      { path: "/bare-repo", branch: null },
    ]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("provision-checkout executor (worktree mode)", () => {
  it("creates the worktree on a new factory branch based on origin/HEAD", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 1, output: "" } },
      { match: "symbolic-ref", response: { output: "origin/main\n" } },
      { match: "worktree add", response: { output: "", sideEffect: () => seedProvisionedWorktree(files) } },
    ]);
    const { executor, store } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const result = await executor.execute(request);
    expect(result).toMatchObject({
      ok: true,
      result: {
        action: "provision-checkout",
        status: "accepted",
        outcome: "provisioned",
        mode: "worktree",
        checkoutPath: WORKTREE,
        branch: "factory",
        branchCreated: true,
        branchExisted: false,
        baseRef: "origin/main",
      },
    });
    const add = terminals.runs.find((command) => command.includes("worktree add"));
    expect(add).toContain(`worktree add -b factory '${WORKTREE}' 'origin/main'`);
    const record = store.getPendingActionIntent(request.idempotencyKey);
    expect(record?.status).toBe("completed");
    expect(record?.result).toEqual(result);
  });

  it("adds the existing factory branch without -b when it already exists", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 0, output: `${"f".repeat(40)} refs/heads/factory\n` } },
      { match: "worktree add", response: { output: "", sideEffect: () => seedProvisionedWorktree(files) } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({
      ok: true,
      result: { outcome: "provisioned", branchCreated: false, branchExisted: true, baseRef: null },
    });
    const add = terminals.runs.find((command) => command.includes("worktree add"));
    expect(add).toContain(`worktree add '${WORKTREE}' factory`);
    expect(add).not.toContain("-b");
    expect(terminals.runs.some((command) => command.includes("symbolic-ref"))).toBe(false);
  });

  it("falls back to a plain -b factory on HEAD when no remote default is identifiable", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 1, output: "" } },
      { match: "symbolic-ref", response: { exitCode: 1, output: "" } },
      { match: "worktree add", response: { output: "", sideEffect: () => seedProvisionedWorktree(files) } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({
      ok: true,
      result: { outcome: "provisioned", branchCreated: true, branchExisted: false, baseRef: null },
    });
    const add = terminals.runs.find((command) => command.includes("worktree add"));
    expect(add).toContain(`worktree add -b factory '${WORKTREE}'`);
    expect(add).not.toContain("origin/");
    expect(result.ok && result.result.message).toContain("current HEAD");
  });

  it("treats an existing worktree on factory as already-applied without running the add", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    seedProvisionedWorktree(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_WITH_FACTORY_WORKTREE } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "already-applied",
        outcome: "already-provisioned",
        checkoutPath: WORKTREE,
        branch: "factory",
      },
    });
    expect(terminals.runs.some((command) => command.includes("worktree add"))).toBe(false);
  });

  it("returns a structured branch-in-use outcome when factory is checked out elsewhere", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_FACTORY_ELSEWHERE } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const result = await executor.execute(request);
    expect(result).toMatchObject({
      ok: true,
      result: {
        action: "provision-checkout",
        status: "preview",
        outcome: "branch-in-use",
        blockingWorktreePath: "/elsewhere",
        checkoutPath: WORKTREE,
      },
    });
    expect(terminals.runs.some((command) => command.includes("worktree add"))).toBe(false);
  });

  it("does not record an intent for the pre-claim branch-in-use result", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_FACTORY_ELSEWHERE } },
    ]);
    const { executor, store } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    await executor.execute(request);
    expect(store.getPendingActionIntent(request.idempotencyKey)).toBeNull();
  });

  it("refuses a root that is not a git repository without claiming an intent", async () => {
    const files = new FakeFileSystem();
    files.seed("some-file.txt", "not a repo\n");
    const terminals = makeHostTerminals();
    const { executor, store } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const result = await executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "checkout-invalid" } });
    if (!result.ok) expect(result.error.message).toContain("not a Git checkout");
    expect(terminals.runs).toHaveLength(0);
    expect(store.getPendingActionIntent(request.idempotencyKey)).toBeNull();
  });

  it("refuses a root that does not exist on the host", async () => {
    const files = new FakeFileSystem();
    const { executor } = makeExecutor({ files, terminals: makeHostTerminals() });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "checkout-invalid" } });
    if (!result.ok) expect(result.error.message).toContain("does not exist");
  });

  it("rejects the request when the target worktree path is occupied by an unregistered directory", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    files.put(`${WORKTREE}/stray.txt`, "leftover\n");
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!result.ok) expect(result.error.message).toContain("not a registered worktree");
  });

  it("rejects when the target worktree path is registered on another branch", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const list =
      LIST_MAIN_ONLY + `worktree ${WORKTREE}\nHEAD ${"d".repeat(40)}\nbranch refs/heads/topic\n\n`;
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: list } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest());
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!result.ok) expect(result.error.message).toContain("'topic'");
  });

  it("marks the intent for reconciliation when the worktree add cannot be observed", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 0, output: `${"f".repeat(40)} refs/heads/factory\n` } },
      { match: "worktree add", response: { status: "disconnected", exitCode: null, output: "" } },
    ]);
    const { executor, store } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const result = await executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "conflict" } });
    if (!result.ok) expect(result.error.message).toContain("reconciliation");
    expect(store.getPendingActionIntent(request.idempotencyKey)?.status).toBe("reconciliation-required");
  });

  it("completes with the terminal output when the worktree add fails", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 0, output: `${"f".repeat(40)} refs/heads/factory\n` } },
      { match: "worktree add", response: { exitCode: 128, output: "fatal: 'factory' is already used by worktree\n" } },
    ]);
    const { executor, store } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const result = await executor.execute(request);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    if (!result.ok) expect(result.error.message).toContain("already used by worktree");
    expect(store.getPendingActionIntent(request.idempotencyKey)?.status).toBe("completed");
  });

  it("replays the recorded result for an idempotent retry without rerunning host commands", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_MAIN_ONLY } },
      { match: "show-ref", response: { exitCode: 0, output: `${"f".repeat(40)} refs/heads/factory\n` } },
      { match: "worktree add", response: { output: "", sideEffect: () => seedProvisionedWorktree(files) } },
    ]);
    const { executor } = makeExecutor({ files, terminals });
    const request = provisionRequest();
    const first = await executor.execute(request);
    const runCount = terminals.runs.length;
    const second = await executor.execute(request);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(terminals.runs).toHaveLength(runCount);
  });

  it("provisions for an unconfigured repositoryKey when host and root are explicit", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files);
    const terminals = makeHostTerminals([
      { match: "worktree list", response: { output: LIST_WITH_FACTORY_WORKTREE } },
    ]);
    const { executor } = makeExecutor({ files, terminals, configured: false });
    const result = await executor.execute(provisionRequest({ repositoryKey: "newrepo" }));
    expect(result).toMatchObject({ ok: true, result: { outcome: "already-provisioned" } });
  });

  it("requires a configured entry when no explicit host and root are given", async () => {
    const { executor } = makeExecutor({ configured: false });
    const result = await executor.execute(provisionRequest({ repositoryKey: "newrepo", explicitTarget: false }));
    expect(result).toMatchObject({ ok: false, error: { category: "not-found" } });
  });
});

describe("provision-checkout executor (direct mode)", () => {
  it("verifies a root already on the factory branch", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files, "factory");
    const terminals = makeHostTerminals();
    const { executor } = makeExecutor({ files, terminals });
    const result = await executor.execute(provisionRequest({ mode: "direct" }));
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "preview",
        outcome: "verified",
        mode: "direct",
        checkoutPath: ROOT,
        branch: "factory",
      },
    });
    expect(terminals.runs).toHaveLength(0);
  });

  it("reports an off-branch root without switching it", async () => {
    const files = new FakeFileSystem();
    seedGitRoot(files, "main");
    const { executor } = makeExecutor({ files, terminals: makeHostTerminals() });
    const result = await executor.execute(provisionRequest({ mode: "direct" }));
    expect(result).toMatchObject({
      ok: true,
      result: { outcome: "off-branch", checkoutPath: ROOT, branch: "main" },
    });
    if (result.ok) {
      expect(result.result.message).toContain("'main'");
      expect(result.result.message).toContain("never creates or switches branches");
    }
  });

  it("refuses a non-git root in direct mode too", async () => {
    const files = new FakeFileSystem();
    files.seed("readme.md", "hello\n");
    const { executor } = makeExecutor({ files, terminals: makeHostTerminals() });
    const result = await executor.execute(provisionRequest({ mode: "direct" }));
    expect(result).toMatchObject({ ok: false, error: { category: "checkout-invalid" } });
  });
});

describe("provisionCheckoutActionRequestSchema", () => {
  it("rejects a hostId without repositoryRoot", () => {
    expect(() =>
      provisionCheckoutActionRequestSchema.parse({
        repositoryKey: "monorepo",
        action: { kind: "provision-checkout", mode: "worktree", hostId: "host-1" },
        idempotencyKey: "bbf:v1:monorepo:provision-checkout:923e4567-e89b-42d3-8456-426614174000",
      }),
    ).toThrow(/provided together/);
  });

  it("rejects an idempotency key whose action segment does not match", () => {
    expect(() =>
      provisionCheckoutActionRequestSchema.parse({
        repositoryKey: "monorepo",
        action: { kind: "provision-checkout", mode: "direct" },
        idempotencyKey: "bbf:v1:monorepo:scaffold-protocol:923e4567-e89b-42d3-8456-426614174000",
      }),
    ).toThrow();
  });
});
