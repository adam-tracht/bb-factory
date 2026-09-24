import { createHash } from "node:crypto";

import {
  protocolSnapshotSchema,
  repositoryConfigurationSchema,
  type ProtocolSnapshot,
  type QueueEntry,
  type RepositoryConfiguration,
  type RepositoryRevision,
} from "../contracts.js";
import type { ProtocolReader } from "../ports.js";
import { ProtocolError } from "./errors.js";
import { parseQualifiedDependency, parseRepositoryPolicy } from "./dependencies.js";
import { PROTOCOL_PATHS } from "./paths.js";
import {
  confinedPath,
  digestText,
  listFiles,
  normalizeAbsolutePath,
  readTextFile,
  relativePathFrom,
  type ProtocolFiles,
  type TextFile,
} from "./files.js";
import {
  parseCurrentState,
  parseDashboard,
  parseQueue,
  parseQuestions,
  parseRunRecord,
  type ParsedQueueEntry,
  type ParsedQuestion,
} from "./markdown.js";
import { protocolErrorFromDiagnostic, validateProtocolFiles } from "./validation.js";
import { deriveQueueEligibility, queueValue, questionValue } from "./schema.js";
import type {
  CanonicalDashboardProjection,
  ImmutableRunRecord,
  ProtocolDependencyResolver,
  ProtocolMergeProjection,
  ProtocolMergeReader,
  ProtocolProjection,
  ProtocolRepositoryPolicy,
  ProtocolReaderOptions,
} from "./types.js";

function protocolDigest(files: readonly TextFile[]): string {
  const digests = files
    .map((file) => `${file.relativePath}\0${file.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(digests, "utf8").digest("hex");
}

async function dependencyIsSatisfied(
  dependency: string,
  parsed: ParsedQueueEntry,
  allEntries: readonly ParsedQueueEntry[],
  configuration: RepositoryConfiguration,
  policy: ProtocolRepositoryPolicy,
  dependencyResolver: ProtocolDependencyResolver | undefined,
): Promise<boolean> {
  const localEntry = allEntries.find((entry) => entry.id === dependency);
  if (localEntry) {
    return localEntry.status.kind === "done";
  }
  const qualified = parseQualifiedDependency(dependency);
  if (!qualified || !dependencyResolver) {
    return false;
  }
  if (!policy.qualifiedDependencies.some((rule) => rule.repositoryKey === qualified.repositoryKey)) {
    return false;
  }
  try {
    return await dependencyResolver.resolveDependency({
      sourceConfiguration: configuration,
      sourceEntry: parsed,
      dependency,
      policy,
    });
  } catch {
    return false;
  }
}

async function queueEntry(
  parsed: ParsedQueueEntry,
  allEntries: readonly ParsedQueueEntry[],
  questions: readonly ParsedQuestion[],
  configuration: RepositoryConfiguration,
  policy: ProtocolRepositoryPolicy,
  dependencyResolver: ProtocolDependencyResolver | undefined,
): Promise<QueueEntry> {
  const dependenciesSatisfied = await Promise.all(
    parsed.dependsOn.map((dependency) =>
      dependencyIsSatisfied(
        dependency,
        parsed,
        allEntries,
        configuration,
        policy,
        dependencyResolver,
      ),
    ),
  );
  return queueValue(parsed, deriveQueueEligibility(parsed, questions, dependenciesSatisfied));
}

function validateMergeProjection(projection: ProtocolMergeProjection, repositoryKey: string): ProtocolMergeProjection {
  if (
    !Number.isInteger(projection.factoryAhead) ||
    projection.factoryAhead < 0 ||
    !Number.isInteger(projection.mainBehind) ||
    projection.mainBehind < 0 ||
    (projection.mainBehind > 0 && projection.safeFastForward)
  ) {
    throw new ProtocolError("malformed-protocol", "Merge projection contains invalid ancestry counts", {
      path: PROTOCOL_PATHS.dashboard,
      rule: "merge-projection",
      hint: "refresh the read-only merge projection from the configured checkout",
      repositoryKey,
      details: { field: "mergeProjection" },
    });
  }
  if (
    projection.gitCommit !== null &&
    !/^[0-9a-f]{7,64}$/u.test(projection.gitCommit)
  ) {
    throw new ProtocolError("malformed-protocol", "Merge projection has an invalid Git commit", {
      path: PROTOCOL_PATHS.dashboard,
      rule: "merge-projection",
      hint: "refresh the read-only merge projection from the configured checkout",
      repositoryKey,
      details: { field: "gitCommit" },
    });
  }
  for (const commit of projection.taskCommits) {
    if (!/^[0-9a-f]{7,64}$/u.test(commit.sha) || !commit.subject.trim()) {
      throw new ProtocolError("malformed-protocol", "Merge projection has an invalid task commit", {
        path: PROTOCOL_PATHS.dashboard,
        rule: "merge-projection",
        hint: "refresh the read-only merge projection from the configured checkout",
        repositoryKey,
        details: { field: "taskCommits" },
      });
    }
  }
  return projection;
}

function unavailableMergeReader(): ProtocolMergeReader {
  return {
    async readMergeProjection(configuration) {
      throw new ProtocolError(
        "merge-state-unavailable",
        `No read-only merge projection was supplied for '${configuration.repositoryKey}'`,
        { repositoryKey: configuration.repositoryKey, path: PROTOCOL_PATHS.dashboard },
      );
    },
  };
}

export class RepositoryProtocolReader implements ProtocolReader {
  private readonly options: Required<Pick<ProtocolReaderOptions, "canonicalDashboardUrl" | "now">> &
    Pick<ProtocolReaderOptions, "mergeReader" | "dependencyResolver">;

  constructor(private readonly files: ProtocolFiles, options: ProtocolReaderOptions = {}) {
    this.options = {
      mergeReader: options.mergeReader,
      dependencyResolver: options.dependencyResolver,
      canonicalDashboardUrl: options.canonicalDashboardUrl ?? null,
      now: options.now ?? (() => new Date()),
    };
  }

  async loadSnapshot(configuration: RepositoryConfiguration): Promise<ProtocolSnapshot> {
    return (await this.loadProjection(configuration)).snapshot;
  }

  async loadRevision(configuration: RepositoryConfiguration): Promise<RepositoryRevision> {
    const normalizedConfiguration = this.validateConfiguration(configuration);
    const foreman = await this.read(normalizedConfiguration, PROTOCOL_PATHS.foreman);
    const repo = await this.read(normalizedConfiguration, PROTOCOL_PATHS.repo);
    const [queue, done, questions, current, dashboard, lock] = await Promise.all([
      this.read(normalizedConfiguration, PROTOCOL_PATHS.queue),
      this.readOptionalDone(normalizedConfiguration),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.questions),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.current),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.dashboard),
      this.readOptionalLock(normalizedConfiguration),
    ]);
    const allFiles = [foreman, repo, queue, ...(done ? [done] : []), questions, current, dashboard, ...(lock ? [{
      relativePath: PROTOCOL_PATHS.lock,
      content: lock.content,
      sha256: lock.sha256,
    }] : [])];
    const mergeReader = this.options.mergeReader ?? unavailableMergeReader();
    const merge = validateMergeProjection(
      await mergeReader.readMergeProjection(normalizedConfiguration),
      normalizedConfiguration.repositoryKey,
    );
    return {
      gitCommit: merge.gitCommit,
      protocolDigest: protocolDigest(allFiles),
      fileDigests: Object.fromEntries(allFiles.map((file) => [file.relativePath, file.sha256])),
    };
  }

  async loadProjection(configuration: RepositoryConfiguration): Promise<ProtocolProjection> {
    const normalizedConfiguration = this.validateConfiguration(configuration);
    const foreman = await this.read(normalizedConfiguration, PROTOCOL_PATHS.foreman);
    const repo = await this.read(normalizedConfiguration, PROTOCOL_PATHS.repo);
    const [queue, done, questions, current, dashboard] = await Promise.all([
      this.read(normalizedConfiguration, PROTOCOL_PATHS.queue),
      this.readOptionalDone(normalizedConfiguration),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.questions),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.current),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.dashboard),
    ]);
    const validationError = validateProtocolFiles({
      repo: repo.content,
      queue: queue.content,
      ...(done ? { done: done.content } : {}),
      questions: questions.content,
      current: current.content,
      dashboard: dashboard.content,
    }, { strictQueueStatus: false })[0];
    if (validationError) {
      throw protocolErrorFromDiagnostic(validationError);
    }
    // Repository-specific qualified dependency rules come from repo.md.
    const repositoryPolicy = parseRepositoryPolicy(repo.content, PROTOCOL_PATHS.repo);
    const parsedQuestions = parseQuestions(questions.content, PROTOCOL_PATHS.questions);
    const queueEntries = parseQueue(queue.content, PROTOCOL_PATHS.queue);
    const doneEntries = done ? parseQueue(done.content, PROTOCOL_PATHS.done) : [];
    const queueIds = new Set(queueEntries.map((entry) => entry.id));
    for (const entry of doneEntries) {
      if (queueIds.has(entry.id)) {
        throw new ProtocolError("malformed-protocol", `Duplicate queue item '${entry.id}' across queue.md and done.md`, {
          path: PROTOCOL_PATHS.done,
          line: entry.line,
          rule: "duplicate-id",
          hint: "keep each queue item id in only one of queue.md or done.md",
        });
      }
    }
    const parsedQueue = [...queueEntries, ...doneEntries];
    const questionsForSnapshot = parsedQuestions.map(questionValue);
    const queueForSnapshot = await Promise.all(
      parsedQueue.map((entry) =>
        queueEntry(
          entry,
          parsedQueue,
          parsedQuestions,
          normalizedConfiguration,
          repositoryPolicy,
          this.options.dependencyResolver,
        ),
      ),
    );
    const currentState = parseCurrentState(current.content, PROTOCOL_PATHS.current);
    const runRecords = await this.readRunRecords(normalizedConfiguration);
    const lock = await this.readOptionalLock(normalizedConfiguration);
    const allFiles = [foreman, repo, queue, ...(done ? [done] : []), questions, current, dashboard, ...runRecords.map((record) => ({
      relativePath: record.relativePath,
      content: record.content,
      sha256: record.sha256,
    })), ...(lock ? [{
      relativePath: PROTOCOL_PATHS.lock,
      content: lock.content,
      sha256: lock.sha256,
    }] : [])];
    const revision = {
      gitCommit: null as string | null,
      protocolDigest: protocolDigest(allFiles),
      fileDigests: Object.fromEntries(allFiles.map((file) => [file.relativePath, file.sha256])),
    };
    const mergeReader = this.options.mergeReader ?? unavailableMergeReader();
    const merge = validateMergeProjection(await mergeReader.readMergeProjection(normalizedConfiguration), normalizedConfiguration.repositoryKey);
    revision.gitCommit = merge.gitCommit;

    const dashboardRows = parseDashboard(dashboard.content, PROTOCOL_PATHS.dashboard);
    const dashboardProjection: CanonicalDashboardProjection = {
      relativePath: PROTOCOL_PATHS.dashboard,
      content: dashboard.content,
      sha256: dashboard.sha256,
      rows: dashboardRows,
      url: this.options.canonicalDashboardUrl,
    };
    const dashboardSummary = {
      canonicalPath: PROTOCOL_PATHS.dashboard,
      factoryBranch: "factory" as const,
      mainRef: normalizedConfiguration.mainRef,
      factoryAhead: merge.factoryAhead,
      mainBehind: merge.mainBehind,
      taskCommits: merge.taskCommits,
      safeFastForward: merge.safeFastForward,
      canonicalDashboardUrl: this.options.canonicalDashboardUrl,
    };
    const snapshotValue = {
      repository: normalizedConfiguration,
      revision,
      capturedAt: this.options.now().toISOString(),
      foremanTemplate: {
        authority: "repository-protocol" as const,
        relativePath: PROTOCOL_PATHS.foreman,
        contentSha256: foreman.sha256,
        repositoryRevision: revision,
      },
      queue: queueForSnapshot,
      questions: questionsForSnapshot,
      dashboard: dashboardSummary,
      currentRun: {
        state: currentState.state,
        lastRunAt: currentState.lastRunAt,
        currentPath: PROTOCOL_PATHS.current,
        latestRunPath: runRecords[0]?.relativePath ?? null,
      },
    };
    const parsedSnapshot = protocolSnapshotSchema.safeParse(snapshotValue);
    if (!parsedSnapshot.success) {
      throw new ProtocolError("malformed-protocol", "Assembled protocol snapshot failed the frozen schema", {
        path: PROTOCOL_PATHS.dashboard,
        rule: "protocol-snapshot-schema",
        hint: "correct the protocol fields that failed the frozen snapshot schema",
        repositoryKey: normalizedConfiguration.repositoryKey,
        details: { issue: parsedSnapshot.error.issues.map((issue) => issue.message).join("; ") },
      });
    }
    return {
      snapshot: parsedSnapshot.data,
      dashboard: dashboardProjection,
      runRecords,
      lock,
    };
  }

  async loadRunRecords(configuration: RepositoryConfiguration): Promise<readonly ImmutableRunRecord[]> {
    return (await this.loadProjection(configuration)).runRecords;
  }

  async loadDashboard(configuration: RepositoryConfiguration): Promise<CanonicalDashboardProjection> {
    return (await this.loadProjection(configuration)).dashboard;
  }

  private validateConfiguration(configuration: RepositoryConfiguration): RepositoryConfiguration {
    const parsed = repositoryConfigurationSchema.safeParse(configuration);
    if (!parsed.success) {
      throw new ProtocolError("invalid-configuration", "Repository configuration failed validation", {
        details: { issue: parsed.error.issues.map((issue) => issue.message).join("; ") },
      });
    }
    return {
      ...parsed.data,
      repositoryRoot: normalizeAbsolutePath(parsed.data.repositoryRoot, "repositoryRoot"),
      checkoutPath: normalizeAbsolutePath(parsed.data.checkoutPath, "checkoutPath"),
    };
  }

  private async read(configuration: RepositoryConfiguration, relativePath: string): Promise<TextFile> {
    return readTextFile(this.files, {
      hostId: configuration.connectedHostId,
      rootPath: configuration.checkoutPath,
      relativePath,
      repositoryKey: configuration.repositoryKey,
    });
  }

  private async readRunRecords(configuration: RepositoryConfiguration): Promise<readonly ImmutableRunRecord[]> {
    let relativePaths: readonly string[];
    try {
      relativePaths = await listFiles(this.files, {
        hostId: configuration.connectedHostId,
        rootPath: configuration.checkoutPath,
        relativePath: PROTOCOL_PATHS.runs,
        repositoryKey: configuration.repositoryKey,
      });
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "file-not-found") {
        return [];
      }
      throw error;
    }
    const runPaths = relativePaths
      .filter((relativePath) => relativePath.endsWith(".md") && !relativePath.endsWith("/.gitkeep"))
      .sort((left, right) => right.localeCompare(left));
    const records: ImmutableRunRecord[] = [];
    for (const relativePath of runPaths) {
      const file = await this.read(configuration, relativePath);
      records.push(parseRunRecord(file.content, relativePath, file.sha256));
    }
    return records;
  }

  private async readOptionalDone(configuration: RepositoryConfiguration): Promise<TextFile | null> {
    try {
      return await this.read(configuration, PROTOCOL_PATHS.done);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "file-not-found") {
        return null;
      }
      throw error;
    }
  }

  private async readOptionalLock(configuration: RepositoryConfiguration): Promise<{ content: string; sha256: string } | null> {
    try {
      const file = await this.read(configuration, PROTOCOL_PATHS.lock);
      return { content: file.content, sha256: file.sha256 };
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "file-not-found") {
        return null;
      }
      throw error;
    }
  }
}

export function createProtocolReader(files: ProtocolFiles, options: ProtocolReaderOptions = {}): ProtocolReader {
  return new RepositoryProtocolReader(files, options);
}

export function staticMergeReader(projection: ProtocolMergeProjection): ProtocolMergeReader {
  return {
    async readMergeProjection() {
      return projection;
    },
  };
}

export function relativeProtocolPath(checkoutPath: string, absolutePath: string): string {
  return relativePathFrom(normalizeAbsolutePath(checkoutPath, "checkoutPath"), absolutePath);
}

export function protocolPath(checkoutPath: string, relativePath: string): string {
  return confinedPath(normalizeAbsolutePath(checkoutPath, "checkoutPath"), relativePath);
}

export { digestText };
