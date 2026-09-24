export type ProtocolErrorCode =
  | "invalid-configuration"
  | "path-traversal"
  | "host-unavailable"
  | "file-not-found"
  | "malformed-protocol"
  | "invalid-file-response"
  | "discovery-failed"
  | "merge-state-unavailable";

export interface ProtocolErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
  readonly line?: number;
  readonly rule?: string;
  readonly hint?: string;
  readonly repositoryKey?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly path: string | undefined;
  readonly line: number | undefined;
  readonly rule: string | undefined;
  readonly hint: string | undefined;
  readonly repositoryKey: string | undefined;
  readonly details: Readonly<Record<string, string>> | undefined;
  readonly rawMessage: string;

  constructor(code: ProtocolErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    const location = options.path === undefined
      ? ""
      : `${options.path}${options.line === undefined ? "" : `:${options.line}`}: `;
    const rule = options.rule === undefined ? "" : ` (rule ${options.rule})`;
    const hint = options.hint === undefined ? "" : `. Fix: ${options.hint}`;
    super(`${location}${message}${rule}${hint}`, { cause: options.cause });
    this.name = "ProtocolError";
    this.code = code;
    this.path = options.path;
    this.line = options.line;
    this.rule = options.rule;
    this.hint = options.hint;
    this.repositoryKey = options.repositoryKey;
    this.details = options.details;
    this.rawMessage = message;
  }
}

interface RpcFailure {
  readonly code: string;
  readonly message: string;
}

const MISSING_PATH_ERROR_RE = /^HTTP\s+404\s*:\s*Path does not exist:\s*\S.*$/iu;

function rpcFailure(error: unknown): RpcFailure | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const envelope = error as { readonly ok?: unknown; readonly error?: unknown };
  if (envelope.ok !== false || typeof envelope.error !== "object" || envelope.error === null) {
    return null;
  }
  const detail = envelope.error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof detail.code !== "string" || typeof detail.message !== "string") {
    return null;
  }
  return { code: detail.code, message: detail.message };
}

export function asProtocolError(
  error: unknown,
  context: { readonly path?: string; readonly repositoryKey?: string } = {},
): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }

  const rpcError = rpcFailure(error);
  const message = rpcError?.message ?? (error instanceof Error ? error.message : String(error));
  const normalized = message.toLowerCase();
  const rawMissingPathError = error instanceof Error && MISSING_PATH_ERROR_RE.test(message);
  let code: ProtocolErrorCode = "invalid-file-response";
  if (rpcError) {
    if (rpcError.code === "handler_error" && MISSING_PATH_ERROR_RE.test(message)) {
      code = "file-not-found";
    }
  } else if (rawMissingPathError) {
    code = "file-not-found";
  } else if (
    normalized.includes("offline") ||
    normalized.includes("disconnected") ||
    normalized.includes("unavailable") ||
    normalized.includes("host") ||
    normalized.includes("enotfound")
  ) {
    code = "host-unavailable";
  } else if (
    normalized.includes("not found") ||
    normalized.includes("no such file") ||
    normalized.includes("path_not_found")
  ) {
    code = "file-not-found";
  }

  return new ProtocolError(code, message, {
    cause: error,
    path: context.path,
    repositoryKey: context.repositoryKey,
  });
}
