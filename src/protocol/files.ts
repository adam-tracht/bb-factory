import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import { ProtocolError, asProtocolError } from "./errors.js";

export interface ProtocolFileReadArgs {
  readonly hostId?: string;
  readonly path: string;
  readonly rootPath?: string;
  readonly signal?: AbortSignal;
}

export interface ProtocolFileReadResult {
  readonly content: string;
  readonly contentEncoding: "base64" | "utf8";
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs?: number;
}

export interface ProtocolPathListArgs {
  readonly hostId?: string;
  readonly path: string;
  readonly includeFiles: boolean;
  readonly includeDirectories: boolean;
  readonly query?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ProtocolPathEntry {
  readonly kind: "file" | "directory";
  readonly name: string;
  readonly path: string;
}

export interface ProtocolPathListResult {
  readonly paths: readonly ProtocolPathEntry[];
  readonly truncated: boolean;
}

/** Structural subset of the public `bb.sdk.files` area used by this adapter. */
export interface ProtocolFiles {
  read(args: ProtocolFileReadArgs): Promise<ProtocolFileReadResult>;
  listPaths(args: ProtocolPathListArgs): Promise<ProtocolPathListResult>;
}

export interface TextFile {
  readonly relativePath: string;
  readonly content: string;
  readonly sha256: string;
  readonly modifiedAtMs?: number;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function pathApi(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value) ? win32 : posix;
}

function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === "..");
}

export function normalizeAbsolutePath(value: string, label: string): string {
  if (!value || value.includes("\0") || !isAbsolutePath(value)) {
    throw new ProtocolError("invalid-configuration", `${label} must be an absolute path`, {
      details: { field: label },
    });
  }
  if (hasParentSegment(value)) {
    throw new ProtocolError("path-traversal", `${label} cannot contain '..' path segments`, {
      path: value,
      details: { field: label },
    });
  }
  return pathApi(value).normalize(value);
}

export function confinedPath(rootPath: string, relativePath: string): string {
  const api = pathApi(rootPath);
  if (!relativePath || isAbsolutePath(relativePath) || relativePath.includes("\0") || hasParentSegment(relativePath)) {
    throw new ProtocolError("path-traversal", `Protocol path '${relativePath}' is not relative`, {
      path: relativePath,
    });
  }
  const candidate = api.resolve(rootPath, relativePath.replaceAll("/", api.sep));
  const root = api.resolve(rootPath);
  if (candidate !== root && !candidate.startsWith(`${root}${api.sep}`)) {
    throw new ProtocolError("path-traversal", `Protocol path '${relativePath}' escapes its checkout root`, {
      path: relativePath,
    });
  }
  return candidate;
}

export function relativePathFrom(rootPath: string, candidatePath: string): string {
  const api = pathApi(rootPath);
  const root = api.resolve(rootPath);
  const candidate = api.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${api.sep}`)) {
    throw new ProtocolError("path-traversal", `Host path '${candidatePath}' escapes its configured root`, {
      path: candidatePath,
    });
  }
  return api.relative(root, candidate).replaceAll(api.sep, "/");
}

export function digestText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function decodeFileContent(result: ProtocolFileReadResult, requestedPath: string): string {
  if (typeof result.content !== "string") {
    throw new ProtocolError("invalid-file-response", `File content for '${requestedPath}' is not text`, {
      path: requestedPath,
    });
  }
  if (result.contentEncoding === "utf8") {
    return result.content;
  }
  if (result.contentEncoding === "base64") {
    return Buffer.from(result.content, "base64").toString("utf8");
  }
  throw new ProtocolError("invalid-file-response", `Unsupported encoding for '${requestedPath}'`, {
    path: requestedPath,
  });
}

export async function readTextFile(
  files: ProtocolFiles,
  options: {
    readonly hostId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly signal?: AbortSignal;
    readonly repositoryKey?: string;
  },
): Promise<TextFile> {
  const absolutePath = confinedPath(options.rootPath, options.relativePath);
  let result: ProtocolFileReadResult;
  try {
    result = await files.read({
      hostId: options.hostId,
      path: absolutePath,
      rootPath: options.rootPath,
      signal: options.signal,
    });
  } catch (error) {
    throw asProtocolError(error, {
      path: options.relativePath,
      repositoryKey: options.repositoryKey,
    });
  }

  if (!SHA256_RE.test(result.sha256)) {
    throw new ProtocolError("invalid-file-response", `File digest for '${options.relativePath}' is invalid`, {
      path: options.relativePath,
      repositoryKey: options.repositoryKey,
    });
  }
  const content = decodeFileContent(result, options.relativePath);
  const sha256 = digestText(content);
  if (sha256 !== result.sha256) {
    throw new ProtocolError("invalid-file-response", `File digest for '${options.relativePath}' does not match its content`, {
      path: options.relativePath,
      repositoryKey: options.repositoryKey,
    });
  }
  return {
    relativePath: options.relativePath,
    content,
    sha256,
    modifiedAtMs: result.modifiedAtMs,
  };
}

export async function listFiles(
  files: ProtocolFiles,
  options: {
    readonly hostId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly signal?: AbortSignal;
    readonly repositoryKey?: string;
  },
): Promise<readonly string[]> {
  const absolutePath = confinedPath(options.rootPath, options.relativePath);
  let result: ProtocolPathListResult;
  try {
    result = await files.listPaths({
      hostId: options.hostId,
      path: absolutePath,
      includeFiles: true,
      includeDirectories: false,
      limit: 1000,
      signal: options.signal,
    });
  } catch (error) {
    throw asProtocolError(error, {
      path: options.relativePath,
      repositoryKey: options.repositoryKey,
    });
  }
  if (result.truncated) {
    throw new ProtocolError(
      "malformed-protocol",
      `The immutable run-record directory '${options.relativePath}' contains more than 1000 files`,
      { path: options.relativePath, repositoryKey: options.repositoryKey },
    );
  }

  const listedRoot = confinedPath(options.rootPath, options.relativePath);
  return result.paths
    .filter((entry) => entry.kind === "file")
    .map((entry) => {
      const requestedDirectory = options.relativePath.replace(/\/$/u, "");
      const relativeEntryPath = entry.path.replace(/^\.\/+/u, "");
      const entryPath = isAbsolutePath(entry.path)
        ? entry.path
        : relativeEntryPath === requestedDirectory || relativeEntryPath.startsWith(`${requestedDirectory}/`)
          ? confinedPath(options.rootPath, relativeEntryPath)
          : confinedPath(listedRoot, relativeEntryPath);
      const relative = relativePathFrom(options.rootPath, entryPath);
      const expectedPrefix = `${options.relativePath.replace(/\/$/u, "")}/`;
      if (!relative.startsWith(expectedPrefix)) {
        throw new ProtocolError("path-traversal", `Listed path '${entry.path}' is outside its requested directory`, {
          path: entry.path,
          repositoryKey: options.repositoryKey,
        });
      }
      return relative;
    });
}
