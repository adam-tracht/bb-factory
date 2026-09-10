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
  readonly repositoryKey?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly path: string | undefined;
  readonly repositoryKey: string | undefined;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(code: ProtocolErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ProtocolError";
    this.code = code;
    this.path = options.path;
    this.repositoryKey = options.repositoryKey;
    this.details = options.details;
  }
}

export function asProtocolError(
  error: unknown,
  context: { readonly path?: string; readonly repositoryKey?: string } = {},
): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  let code: ProtocolErrorCode = "invalid-file-response";
  if (
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
