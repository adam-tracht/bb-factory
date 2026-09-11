import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { PluginStorage } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  type FactorySettings,
  type RepositoryConfiguration,
  type RepositoryRegistryEntry,
} from "../src/contracts.js";
import type { ProtocolReader } from "../src/ports.js";
import {
  createProtocolReader,
  staticDependencyResolver,
  staticMergeReader,
  type ProtocolMergeProjection,
} from "../src/protocol/index.js";
import { digestText, type ProtocolFiles } from "../src/protocol/files.js";
import { initializeOperationalStorage, type OperationalStateStore } from "../src/storage/index.js";

export const CHECKOUT = "/repo";

export function makeConfiguration(): RepositoryConfiguration {
  return {
    repositoryKey: "monorepo",
    repositoryRoot: CHECKOUT,
    connectedHostId: "host-1",
    checkoutPath: CHECKOUT,
    factoryBranch: "factory",
    mainRef: "origin/main",
  };
}

export function makeRegistryEntry(): RepositoryRegistryEntry {
  return {
    configuration: makeConfiguration(),
    projectId: "project-1",
    environmentId: "environment-1",
  };
}

export function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  return factorySettingsSchema.parse({
    repositoryKey: "monorepo",
    repositoryRegistry: {
      repositories: [makeRegistryEntry()],
      defaultRepositoryKey: "monorepo",
    },
    dispatchMode: "enabled",
    ...overrides,
  });
}

export const DEFAULT_MERGE: ProtocolMergeProjection = {
  gitCommit: "abc1234",
  factoryAhead: 0,
  mainBehind: 0,
  taskCommits: [],
  safeFastForward: true,
};

export const FOREMAN_MD = "# Foreman\n\nFollow the protocol.\n";
export const REPO_MD = "# Repo rules\n\nNothing extra.\n";
export const CURRENT_MD = "# Latest run\n\nstate: no-op\n";
export const DASHBOARD_MD = [
  "# Dashboard",
  "",
  "| id | work item | status | next action | evidence and canonical detail |",
  "|---|---|---|---|---|",
  "| T1 | Sample task | open | run the task | queue |",
  "",
].join("\n");
export const QUESTIONS_MD = [
  "# Questions",
  "",
  "## Q6 2026-09-10 blocking T1",
  "question: Which provider should run this?",
  "context: The plan needs a choice.",
  "answer:",
  "",
].join("\n");
export const QUEUE_MD = [
  "# Queue",
  "",
  "## T1 Sample task",
  "status: blocked-by: Q6",
  "priority: 2",
  "depends_on: none",
  "risk: low",
  "plan: plans/factory/plan-t1.md",
  "approved: none",
  "acceptance:",
  "- the task is done",
  "validate:",
  "- pnpm test",
  "notes: none",
  "",
].join("\n");

/** In-memory stand-in for the confined host file API. */
export class FakeFileSystem {
  private readonly files = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  public writes: Array<{ path: string; expectedSha256?: string | null }> = [];
  public writeHook: ((path: string, content: string) => void) | null = null;

  seed(relativePath: string, content: string, rootPath = CHECKOUT, mtime?: number): void {
    const path = posix.join(rootPath, relativePath);
    this.files.set(path, content);
    if (mtime !== undefined) this.mtimes.set(path, mtime);
  }

  seedProtocol(overrides: Record<string, string> = {}): void {
    const defaults: Record<string, string> = {
      "plans/factory/foreman.md": FOREMAN_MD,
      "plans/factory/repo.md": REPO_MD,
      "plans/factory/current.md": CURRENT_MD,
      "plans/factory/questions.md": QUESTIONS_MD,
      "plans/factory/queue.md": QUEUE_MD,
      "plans/README.md": DASHBOARD_MD,
    };
    for (const [path, content] of Object.entries({ ...defaults, ...overrides })) {
      this.seed(path, content);
    }
  }

  content(relativePath: string, rootPath = CHECKOUT): string | undefined {
    return this.files.get(posix.join(rootPath, relativePath));
  }

  /** True when the absolute path is a seeded file or a directory containing one. */
  hasPath(absolutePath: string): boolean {
    if (this.files.has(absolutePath)) return true;
    const prefix = absolutePath.endsWith("/") ? absolutePath : `${absolutePath}/`;
    return [...this.files.keys()].some((key) => key.startsWith(prefix));
  }

  put(absolutePath: string, content: string, mtime?: number): void {
    this.files.set(absolutePath, content);
    if (mtime !== undefined) this.mtimes.set(absolutePath, mtime);
  }

  async read(args: { path: string; hostId?: string; rootPath?: string }) {
    const content = this.files.get(args.path);
    if (content === undefined) {
      throw new Error(`no such file: ${args.path}`);
    }
    const modifiedAtMs = this.mtimes.get(args.path);
    return {
      path: args.path,
      content,
      contentEncoding: "utf8" as const,
      sha256: digestText(content),
      sizeBytes: Buffer.byteLength(content),
      ...(modifiedAtMs === undefined ? {} : { modifiedAtMs }),
    };
  }

  async write(args: { path: string; content: string; expectedSha256?: string | null; createParents?: boolean }) {
    this.writes.push({ path: args.path, expectedSha256: args.expectedSha256 });
    this.writeHook?.(args.path, args.content);
    const existing = this.files.get(args.path);
    if (args.expectedSha256 === null && existing !== undefined) {
      // null means create-only: any existing content is a conflict.
      return { outcome: "conflict" as const, currentSha256: digestText(existing) };
    }
    if (args.expectedSha256 !== undefined && args.expectedSha256 !== null) {
      const current = existing === undefined ? null : digestText(existing);
      if (current !== args.expectedSha256) {
        return { outcome: "conflict" as const, currentSha256: current };
      }
    }
    this.files.set(args.path, args.content);
    return {
      outcome: "written" as const,
      sha256: digestText(args.content),
      sizeBytes: Buffer.byteLength(args.content),
    };
  }

  async listPaths(args: { path: string; includeFiles?: boolean }) {
    const prefix = args.path.endsWith("/") ? args.path : `${args.path}/`;
    const paths = [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ kind: "file" as const, name: posix.basename(key), path: key }));
    return { paths, truncated: false };
  }
}

/** A hosts-area stand-in whose pathsExist answers from the fake file system. */
export function makeHostsProbe(files: FakeFileSystem) {
  return {
    pathsExist: async (args: { hostId?: string; paths: readonly string[] }) => ({
      existence: Object.fromEntries(args.paths.map((path) => [path, files.hasPath(path)])),
    }),
  };
}

export interface FakeTerminalResponse {
  readonly status?: "exited" | "running" | "disconnected" | "starting";
  readonly exitCode?: number | null;
  readonly output?: string;
  /** Runs when a matching command is created; simulates host side effects. */
  readonly sideEffect?: () => void;
}

export interface FakeTerminalRule {
  /** Substring or pattern matched against the terminal's command. */
  readonly match: string | RegExp;
  readonly response: FakeTerminalResponse;
}

/**
 * Command-mode terminal stand-in for host-command tests: create() picks the
 * first rule whose matcher appears in the command (falling back to a clean
 * exit), sessions report "exited" immediately, and output() replays the
 * rule's text as base64 chunks. Every created command is recorded in `runs`.
 */
export function makeHostTerminals(rules: readonly FakeTerminalRule[] = [], fallback: FakeTerminalResponse = {}) {
  let counter = 0;
  const sessions = new Map<string, { session: Record<string, unknown>; output: string }>();
  const runs: string[] = [];
  const pick = (command: string): FakeTerminalResponse => {
    const rule = rules.find((candidate) =>
      typeof candidate.match === "string" ? command.includes(candidate.match) : candidate.match.test(command));
    return rule?.response ?? fallback;
  };
  return {
    runs,
    create: async (args: { start?: { command?: string }; title?: string; scope: unknown }) => {
      const command = args.start?.command ?? "";
      runs.push(command);
      const response = pick(command);
      response.sideEffect?.();
      counter += 1;
      const session = {
        id: `term-${counter}`,
        hostId: "host-1",
        environmentId: null,
        threadId: null,
        status: response.status ?? "exited",
        exitCode: response.exitCode ?? 0,
        cols: 120,
        rows: 30,
        title: args.title ?? "test",
        createdAt: 0,
        updatedAt: 0,
        initialCwd: "/repo",
        lastUserInputAt: null,
        closeReason: null,
      };
      sessions.set(session.id, { session, output: response.output ?? "" });
      return session;
    },
    get: async (args: { terminalId: string }) => sessions.get(args.terminalId)!.session,
    output: async (args: { terminalId: string }) => ({
      chunks: [{ dataBase64: Buffer.from(sessions.get(args.terminalId)!.output).toString("base64"), seq: 1 }],
      nextSeq: 2,
      truncated: false,
    }),
    close: async (args: { terminalId: string }) => sessions.get(args.terminalId)!.session,
  };
}

export function makeProtocolReader(files: FakeFileSystem): ProtocolReader {
  return createProtocolReader(files as unknown as ProtocolFiles, {
    mergeReader: staticMergeReader(DEFAULT_MERGE),
    dependencyResolver: staticDependencyResolver({}),
  });
}

export interface TestStorage {
  readonly db: Database.Database;
  readonly directory: string;
  readonly kv: PluginStorage["kv"];
  database(): Database.Database;
  migrate(database: Database.Database, statements: readonly string[]): void;
  close(): void;
}

const storages: TestStorage[] = [];

export function cleanupStorages(): void {
  while (storages.length > 0) storages.pop()!.close();
}

export function makeStorage(directory = mkdtempSync(join(tmpdir(), "bb-factory-test-"))): TestStorage {
  let handle = new Database(join(directory, "data.db"));
  // Match the host contract: database() reopens after the handle is closed.
  const open = (): Database.Database => {
    if (!handle.open) handle = new Database(join(directory, "data.db"));
    return handle;
  };
  const storage: TestStorage = {
    get db() {
      return open();
    },
    directory,
    kv: {
      async get<T>(): Promise<T | undefined> {
        return undefined;
      },
      async set(): Promise<void> {},
      async delete(): Promise<void> {},
      async list(): Promise<string[]> {
        return [];
      },
    },
    database: open,
    migrate: (database, statements) => {
      database.exec(`CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)`);
      statements.forEach((statement, id) => {
        const applied = database.prepare<unknown[], { hash: string }>(`SELECT hash FROM _bb_migrations WHERE id = ?`).get(id);
        if (applied === undefined) {
          database.exec(statement);
          database.prepare(`INSERT INTO _bb_migrations (id, hash) VALUES (?, ?)`).run(id, createHash("sha256").update(statement).digest("hex"));
        }
      });
    },
    close: () => {
      if (handle.open) handle.close();
    },
  };
  storages.push(storage);
  return storage;
}

export function makeStore(): OperationalStateStore {
  return initializeOperationalStorage(makeStorage() as unknown as PluginStorage);
}
