import { parseRepositoryPolicy } from "./dependencies.js";
import { ProtocolError } from "./errors.js";
import { PROTOCOL_PATHS } from "./paths.js";
import {
  parseCurrentState,
  parseDashboard,
  parseQueue,
  parseQuestions,
  type MarkdownParseOptions,
  type ParsedQueueEntry,
  type ParsedQuestion,
} from "./markdown.js";
import { deriveQueueEligibility, queueValue, questionValue } from "./schema.js";

export interface ProtocolFileContents {
  readonly repo: string;
  readonly queue: string;
  readonly done?: string;
  readonly questions: string;
  readonly current: string;
  readonly dashboard: string;
}

export interface ProtocolDiagnostic {
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
  readonly rule: string;
  readonly hint: string;
}

export interface ProtocolValidationOptions {
  /** The reader preserves tolerant rendering for unknown legacy queue statuses. */
  readonly strictQueueStatus?: boolean;
}

const FALLBACK_RULE = "protocol-file";
const FALLBACK_HINT = "fix the reported protocol error before committing";

function errorDiagnostic(error: unknown, fallbackPath: string): ProtocolDiagnostic {
  if (error instanceof ProtocolError) {
    const detail = error.details?.issue;
    return {
      path: error.path ?? fallbackPath,
      line: error.line ?? null,
      message: detail ? `${error.rawMessage}: ${detail}` : error.rawMessage,
      rule: error.rule ?? FALLBACK_RULE,
      hint: error.hint ?? FALLBACK_HINT,
    };
  }
  return {
    path: fallbackPath,
    line: null,
    message: error instanceof Error ? error.message : String(error),
    rule: FALLBACK_RULE,
    hint: FALLBACK_HINT,
  };
}

export function formatProtocolDiagnostic(diagnostic: ProtocolDiagnostic): string {
  return `${diagnostic.path}:${diagnostic.line ?? "?"}: ${diagnostic.message} (rule ${diagnostic.rule}). Fix: ${diagnostic.hint}`;
}

export function protocolErrorFromDiagnostic(diagnostic: ProtocolDiagnostic): ProtocolError {
  return new ProtocolError("malformed-protocol", diagnostic.message, {
    path: diagnostic.path,
    ...(diagnostic.line === null ? {} : { line: diagnostic.line }),
    rule: diagnostic.rule,
    hint: diagnostic.hint,
  });
}

function capture(
  diagnostics: ProtocolDiagnostic[],
  path: string,
  action: () => void,
): void {
  try {
    action();
  } catch (error) {
    diagnostics.push(errorDiagnostic(error, path));
  }
}

export function validateProtocolFiles(
  files: ProtocolFileContents,
  options: ProtocolValidationOptions = {},
): readonly ProtocolDiagnostic[] {
  const diagnostics: ProtocolDiagnostic[] = [];
  let questions: readonly ParsedQuestion[] = [];
  let queue: readonly ParsedQueueEntry[] = [];
  let done: readonly ParsedQueueEntry[] = [];
  const parseOptions = (path: string): MarkdownParseOptions => ({
    onError: (error) => diagnostics.push(errorDiagnostic(error, path)),
  });

  capture(diagnostics, PROTOCOL_PATHS.repo, () => {
    parseRepositoryPolicy(files.repo, PROTOCOL_PATHS.repo);
  });
  capture(diagnostics, PROTOCOL_PATHS.questions, () => {
    questions = parseQuestions(files.questions, PROTOCOL_PATHS.questions, parseOptions(PROTOCOL_PATHS.questions));
  });
  for (const question of questions) {
    capture(diagnostics, PROTOCOL_PATHS.questions, () => {
      questionValue(question);
    });
  }
  capture(diagnostics, PROTOCOL_PATHS.queue, () => {
    queue = parseQueue(files.queue, PROTOCOL_PATHS.queue, parseOptions(PROTOCOL_PATHS.queue));
  });
  for (const entry of queue) {
    capture(diagnostics, PROTOCOL_PATHS.queue, () => {
      if (options.strictQueueStatus !== false && entry.status.kind === "unknown") {
        throw new ProtocolError("malformed-protocol", `Queue item '${entry.id}' has unrecognized status '${entry.status.raw}'`, {
          path: entry.path,
          line: entry.fieldLines.get("status") ?? entry.line,
          rule: "queue-status",
          hint: "use draft, ready, in-progress <detail>, done <detail>, or blocked-by: Q<n>",
        });
      }
      queueValue(entry, deriveQueueEligibility(entry, questions));
    });
  }
  if (files.done !== undefined) {
    capture(diagnostics, PROTOCOL_PATHS.done, () => {
      done = parseQueue(files.done ?? "", PROTOCOL_PATHS.done, parseOptions(PROTOCOL_PATHS.done));
    });
    for (const entry of done) {
      capture(diagnostics, PROTOCOL_PATHS.done, () => {
        if (options.strictQueueStatus !== false && entry.status.kind === "unknown") {
          throw new ProtocolError("malformed-protocol", `Queue item '${entry.id}' has unrecognized status '${entry.status.raw}'`, {
            path: entry.path,
            line: entry.fieldLines.get("status") ?? entry.line,
            rule: "queue-status",
            hint: "use draft, ready, in-progress <detail>, done <detail>, or blocked-by: Q<n>",
          });
        }
        queueValue(entry, deriveQueueEligibility(entry, questions));
      });
    }
  }
  const queueIds = new Set(queue.map((entry) => entry.id));
  for (const entry of done) {
    if (queueIds.has(entry.id)) {
      diagnostics.push({
        path: PROTOCOL_PATHS.done,
        line: entry.line,
        message: `Duplicate queue item '${entry.id}' across queue.md and done.md`,
        rule: "duplicate-id",
        hint: "keep each queue item id in only one of queue.md or done.md",
      });
    }
  }
  capture(diagnostics, PROTOCOL_PATHS.current, () => {
    parseCurrentState(files.current, PROTOCOL_PATHS.current);
  });
  capture(diagnostics, PROTOCOL_PATHS.dashboard, () => {
    parseDashboard(files.dashboard, PROTOCOL_PATHS.dashboard, parseOptions(PROTOCOL_PATHS.dashboard));
  });
  return diagnostics;
}
