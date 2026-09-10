import { createHash } from "node:crypto";

import {
  protocolSnapshotSchema,
  queueEntrySchema,
  questionSchema,
  repositoryConfigurationSchema,
  type ProtocolSnapshot,
  type QueueEntry,
  type Question,
  type RepositoryConfiguration,
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

function asQuestion(question: ParsedQuestion): Question {
  const value = {
    id: question.id,
    date: question.date,
    classification: question.classification,
    dashboardId: question.dashboardId,
    question: question.question,
    context: question.context,
    assumed: question.assumed,
    ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
    answer: question.answer,
  };
  const parsed = questionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolError("malformed-protocol", `Question '${question.id}' failed the frozen schema`, {
      path: PROTOCOL_PATHS.questions,
      details: { issue: parsed.error.issues.map((issue) => issue.message).join("; ") },
    });
  }
  return parsed.data;
}

function questionIsOpen(question: ParsedQuestion): boolean {
  return question.classification === "blocking" && question.answer === null;
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
  const referencedQuestionIds = new Set<string>();
  if (parsed.status.kind === "blocked-by") {
    referencedQuestionIds.add(parsed.status.questionId);
  }
  for (const question of questions) {
    if (question.dashboardId === parsed.id && questionIsOpen(question)) {
      referencedQuestionIds.add(question.id);
    }
  }

  const eligibilityReasons: QueueEntry["eligibilityReasons"] = [];
  if (parsed.status.kind !== "ready") {
    eligibilityReasons.push("not-ready");
  }
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
  if (dependenciesSatisfied.some((satisfied) => !satisfied)) {
    eligibilityReasons.push("unmet-dependency");
  }
  const openQuestions = questions.filter(
    (question) => referencedQuestionIds.has(question.id) && questionIsOpen(question),
  );
  if (openQuestions.length > 0) {
    eligibilityReasons.push("blocking-question");
  }
  if (parsed.approved.kind === "none" && parsed.status.kind === "ready") {
    eligibilityReasons.push(parsed.risk === "high" ? "high-risk-approval-missing" : "missing-authorization");
  }

  const status = parsed.status.kind === "ready"
    ? { kind: "ready" as const }
    : parsed.status.kind === "in-progress"
      ? { kind: "in-progress" as const, detail: parsed.status.detail }
      : parsed.status.kind === "done"
        ? { kind: "done" as const, ...(parsed.status.detail ? { detail: parsed.status.detail } : {}) }
        : {
            kind: "blocked-by" as const,
            questionId: parsed.status.questionId,
            ...(parsed.status.detail ? { detail: parsed.status.detail } : {}),
          };
  const value = {
    id: parsed.id,
    title: parsed.title,
    status,
    priority: parsed.priority,
    dependsOn: [...parsed.dependsOn],
    risk: parsed.risk,
    planPath: parsed.planPath,
    approved: parsed.approved.kind === "none"
      ? { kind: "none" as const, source: "none" as const }
      : { kind: "explicit" as const, source: "queue.approved" as const, text: parsed.approved.text },
    acceptance: [...parsed.acceptance],
    validate: [...parsed.validate],
    notes: parsed.notes,
    blockingQuestionIds: [...referencedQuestionIds].filter((id) => openQuestions.some((question) => question.id === id)),
    eligible: eligibilityReasons.length === 0,
    eligibilityReasons,
  };
  const result = queueEntrySchema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError("malformed-protocol", `Queue item '${parsed.id}' failed the frozen schema`, {
      path: PROTOCOL_PATHS.queue,
      details: { issue: result.error.issues.map((issue) => issue.message).join("; ") },
    });
  }
  return result.data;
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
      repositoryKey,
      details: { field: "mergeProjection" },
    });
  }
  if (
    projection.gitCommit !== null &&
    !/^[0-9a-f]{7,64}$/u.test(projection.gitCommit)
  ) {
    throw new ProtocolError("malformed-protocol", "Merge projection has an invalid Git commit", {
      repositoryKey,
      details: { field: "gitCommit" },
    });
  }
  for (const commit of projection.taskCommits) {
    if (!/^[0-9a-f]{7,64}$/u.test(commit.sha) || !commit.subject.trim()) {
      throw new ProtocolError("malformed-protocol", "Merge projection has an invalid task commit", {
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

  async loadProjection(configuration: RepositoryConfiguration): Promise<ProtocolProjection> {
    const normalizedConfiguration = this.validateConfiguration(configuration);
    const foreman = await this.read(normalizedConfiguration, PROTOCOL_PATHS.foreman);
    const repo = await this.read(normalizedConfiguration, PROTOCOL_PATHS.repo);
    const [queue, questions, current, dashboard] = await Promise.all([
      this.read(normalizedConfiguration, PROTOCOL_PATHS.queue),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.questions),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.current),
      this.read(normalizedConfiguration, PROTOCOL_PATHS.dashboard),
    ]);
    // Repository-specific qualified dependency rules come from repo.md.
    const repositoryPolicy = parseRepositoryPolicy(repo.content, PROTOCOL_PATHS.repo);
    const parsedQuestions = parseQuestions(questions.content, PROTOCOL_PATHS.questions);
    const parsedQueue = parseQueue(queue.content, PROTOCOL_PATHS.queue);
    const questionsForSnapshot = parsedQuestions.map(asQuestion);
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
    const allFiles = [foreman, repo, queue, questions, current, dashboard, ...runRecords.map((record) => ({
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
