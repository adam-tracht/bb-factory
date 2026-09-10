import { repositoryConfigurationSchema, type RepositoryConfiguration } from "../contracts.js";
import { ProtocolError } from "./errors.js";
import { normalizeAbsolutePath, readTextFile, type ProtocolFiles } from "./files.js";

export interface RepositoryDiscoveryOptions {
  readonly files: ProtocolFiles;
  readonly factoryRoot: string;
  readonly connectedHostId: string;
  readonly mainRef?: string;
  readonly sourceRelativePath?: string;
  readonly signal?: AbortSignal;
}

function shellWords(line: string, path: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  for (const character of line) {
    if (comment) {
      break;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote && character === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (!quote && character === "#") {
      comment = true;
      continue;
    }
    if (!quote && /\s/u.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote || escaped) {
    throw new ProtocolError("discovery-failed", `Unterminated shell quoting in '${path}'`, { path });
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

export async function discoverRepositoryConfigurations(
  options: RepositoryDiscoveryOptions,
): Promise<readonly RepositoryConfiguration[]> {
  const factoryRoot = normalizeAbsolutePath(options.factoryRoot, "factoryRoot");
  if (!options.connectedHostId.trim()) {
    throw new ProtocolError("invalid-configuration", "connectedHostId must be non-empty", {
      details: { field: "connectedHostId" },
    });
  }
  const sourceRelativePath = options.sourceRelativePath ?? "merge-state.sh";
  const source = await readTextFile(options.files, {
    hostId: options.connectedHostId,
    rootPath: factoryRoot,
    relativePath: sourceRelativePath,
    signal: options.signal,
  });

  const configurations: RepositoryConfiguration[] = [];
  const keys = new Set<string>();
  const checkoutPaths = new Set<string>();
  for (const line of source.content.split(/\r?\n/u)) {
    const words = shellWords(line, source.relativePath);
    if (words[0] !== "report") {
      continue;
    }
    if (words.length !== 4) {
      throw new ProtocolError("discovery-failed", `Expected 'report <factory> <key> <main>' in '${sourceRelativePath}'`, {
        path: sourceRelativePath,
      });
    }
    const [, checkoutPath, repositoryKey, repositoryRoot] = words;
    if (!isAbsolute(checkoutPath) || !isAbsolute(repositoryRoot)) {
      throw new ProtocolError("discovery-failed", `Repository paths for '${repositoryKey}' must be absolute`, {
        path: sourceRelativePath,
      });
    }
    if (keys.has(repositoryKey)) {
      throw new ProtocolError("discovery-failed", `Repository key '${repositoryKey}' is listed more than once`, {
        path: sourceRelativePath,
      });
    }
    const configuration = repositoryConfigurationSchema.safeParse({
      repositoryKey,
      repositoryRoot: normalizeAbsolutePath(repositoryRoot, "repositoryRoot"),
      connectedHostId: options.connectedHostId,
      checkoutPath: normalizeAbsolutePath(checkoutPath, "checkoutPath"),
      factoryBranch: "factory",
      mainRef: options.mainRef ?? "origin/main",
    });
    if (!configuration.success) {
      throw new ProtocolError("discovery-failed", `Invalid discovered repository '${repositoryKey}'`, {
        path: sourceRelativePath,
        details: { issue: configuration.error.issues.map((issue) => issue.message).join("; ") },
      });
    }
    if (checkoutPaths.has(configuration.data.checkoutPath)) {
      throw new ProtocolError("discovery-failed", `Checkout '${configuration.data.checkoutPath}' is listed more than once`, {
        path: sourceRelativePath,
      });
    }
    keys.add(repositoryKey);
    checkoutPaths.add(configuration.data.checkoutPath);
    configurations.push(configuration.data);
  }

  if (configurations.length === 0) {
    throw new ProtocolError("discovery-failed", `No repository report entries found in '${sourceRelativePath}'`, {
      path: sourceRelativePath,
    });
  }
  return configurations;
}

export const discoverManagedRepositories = discoverRepositoryConfigurations;
