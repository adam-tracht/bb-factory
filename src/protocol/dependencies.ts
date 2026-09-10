import type { RepositoryConfiguration } from "../contracts.js";
import { discoverRepositoryConfigurations } from "./discovery.js";
import { ProtocolError } from "./errors.js";
import { readTextFile, type ProtocolFiles } from "./files.js";
import { parseDashboard, parseQueue } from "./markdown.js";
import type {
  ConnectedHostDependencyResolverOptions,
  ProtocolDependencyResolver,
  ProtocolDependencyResolverInput,
  ProtocolRepositoryPolicy,
} from "./types.js";

const SIBLING_QUEUE_PATH = "plans/factory/queue.md";
const SIBLING_DASHBOARD_PATH = "plans/README.md";
const POLICY_LINE_MARKER = "queue entries may list";
const QUALIFIED_DEPENDENCY_RE =
  /depends_on\s*:\s*([a-z0-9][a-z0-9._-]{0,63}):([A-Za-z0-9][A-Za-z0-9._-]*)/u;
const NAMED_DELIVERABLE_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/gu;
const MARKDOWN_WRAPPER_CHAR_RE = /[\x60*[\](){}<>]/gu;

function policyError(message: string, path: string): ProtocolError {
  return new ProtocolError("malformed-protocol", message, { path });
}

export function parseRepositoryPolicy(content: string, path: string): ProtocolRepositoryPolicy {
  const qualifiedDependencies: ProtocolRepositoryPolicy["qualifiedDependencies"][number][] = [];
  const seenRepositoryKeys = new Set<string>();

  for (const line of content.split(/\r?\n/u)) {
    if (!line.toLowerCase().includes(POLICY_LINE_MARKER)) {
      continue;
    }
    const match = line.match(QUALIFIED_DEPENDENCY_RE);
    if (!match) {
      throw policyError("Cross-repository dependency policy is malformed in '" + path + "'", path);
    }
    const repositoryKey = match[1];
    if (seenRepositoryKeys.has(repositoryKey)) {
      throw policyError("Cross-repository policy repeats repository '" + repositoryKey + "' in '" + path + "'", path);
    }
    seenRepositoryKeys.add(repositoryKey);
    const lowerLine = line.toLowerCase();
    qualifiedDependencies.push({
      repositoryKey,
      dashboardRequirement: lowerLine.includes("with evidence") ? "done-with-evidence" : "done",
      allowNamedDeliverableEvidence:
        lowerLine.includes("specific deliverable named in our entry") &&
        lowerLine.includes("evidence"),
    });
  }

  return { qualifiedDependencies };
}

export function parseQualifiedDependency(value: string): { repositoryKey: string; itemId: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(":", separator + 1) >= 0) {
    return null;
  }
  return {
    repositoryKey: value.slice(0, separator),
    itemId: value.slice(separator + 1),
  };
}

function namedDeliverables(input: ProtocolDependencyResolverInput): readonly string[] {
  const sourceText = [
    input.sourceEntry.title,
    ...input.sourceEntry.acceptance,
    ...input.sourceEntry.validate,
    input.sourceEntry.notes ?? "",
  ].join("\n");
  return [...new Set(sourceText.match(NAMED_DELIVERABLE_RE) ?? [])];
}

/**
 * The monorepo exception recognizes only an explicit assertion:
 * target shipped, target is shipped, target has been shipped, or
 * Shipped: target. Markdown wrapper characters are removed, then the
 * complete bounded clause must match one of those forms. A terminal period
 * or exclamation mark is allowed; every other wording fails closed as the
 * queue item's unmet-dependency reason.
 */
function isAffirmativeShippedAssertion(clause: string, deliverable: string): boolean {
  const normalized = clause.replace(MARKDOWN_WRAPPER_CHAR_RE, "").replace(/\s+/gu, " ").trim();
  const target = "(?<![A-Za-z0-9_-])" + deliverable + "(?![A-Za-z0-9_-])";
  const shipped = "[Ss]hipped";
  const is = "[Ii]s";
  const has = "[Hh]as";
  const been = "[Bb]een";
  const assertion = new RegExp(
    "^(?:" +
      target + "\\s+" + shipped +
      "|" + target + "\\s+" + is + "\\s+" + shipped +
      "|" + target + "\\s+" + has + "\\s+" + been + "\\s+" + shipped +
      "|" + shipped + "\\s*:\\s*" + target +
      ")[.!]?$",
    "u",
  );
  const match = assertion.exec(normalized);
  return match !== null && match[0] === normalized;
}

function hasNamedDeliverableEvidence(
  input: ProtocolDependencyResolverInput,
  evidence: string,
): boolean {
  const clauses = evidence.split(/[.;,\n]+|\b(?:but|however|while)\b/iu);
  return namedDeliverables(input).some((deliverable) =>
    clauses.some((clause) => isAffirmativeShippedAssertion(clause, deliverable)),
  );
}

async function readSiblingStatus(
  files: ProtocolFiles,
  configuration: RepositoryConfiguration,
  dependency: { repositoryKey: string; itemId: string },
  signal?: AbortSignal,
): Promise<{ queueDone: boolean; dashboardStatus: string; dashboardEvidence: string } | null> {
  const [queue, dashboard] = await Promise.all([
    readTextFile(files, {
      hostId: configuration.connectedHostId,
      rootPath: configuration.checkoutPath,
      relativePath: SIBLING_QUEUE_PATH,
      repositoryKey: configuration.repositoryKey,
      signal,
    }),
    readTextFile(files, {
      hostId: configuration.connectedHostId,
      rootPath: configuration.checkoutPath,
      relativePath: SIBLING_DASHBOARD_PATH,
      repositoryKey: configuration.repositoryKey,
      signal,
    }),
  ]);
  const queueEntry = parseQueue(queue.content, SIBLING_QUEUE_PATH).find((entry) => entry.id === dependency.itemId);
  const dashboardRow = parseDashboard(dashboard.content, SIBLING_DASHBOARD_PATH).find(
    (row) => row.id === dependency.itemId,
  );
  if (!queueEntry || !dashboardRow) {
    return null;
  }
  return {
    queueDone: queueEntry.status.kind === "done",
    dashboardStatus: dashboardRow.status,
    dashboardEvidence: dashboardRow.evidence,
  };
}

async function findSiblingConfiguration(
  options: ConnectedHostDependencyResolverOptions,
  repositoryKey: string,
): Promise<RepositoryConfiguration | null> {
  if (options.repositoryLookup) {
    return options.repositoryLookup(repositoryKey);
  }
  if (options.repositoryRegistry) {
    const repositories = await options.repositoryRegistry.listRepositories();
    return repositories.find((configuration) => configuration.repositoryKey === repositoryKey) ?? null;
  }
  if (options.repositoryDiscovery) {
    const configurations = await discoverRepositoryConfigurations(options.repositoryDiscovery);
    return configurations.find((configuration) => configuration.repositoryKey === repositoryKey) ?? null;
  }
  return null;
}

export function createConnectedHostDependencyResolver(
  options: ConnectedHostDependencyResolverOptions,
): ProtocolDependencyResolver {
  return {
    async resolveDependency(input) {
      const dependency = parseQualifiedDependency(input.dependency);
      if (!dependency) {
        return false;
      }
      const rule = input.policy.qualifiedDependencies.find(
        (candidate) => candidate.repositoryKey === dependency.repositoryKey,
      );
      if (!rule) {
        return false;
      }

      try {
        const sibling = await findSiblingConfiguration(options, dependency.repositoryKey);
        if (!sibling) {
          return false;
        }
        const status = await readSiblingStatus(
          options.files,
          sibling,
          dependency,
          options.signal ?? options.repositoryDiscovery?.signal,
        );
        if (!status || !status.queueDone) {
          return false;
        }
        if (rule.dashboardRequirement === "done-with-evidence") {
          return status.dashboardStatus === "Done" && Boolean(status.dashboardEvidence.trim());
        }
        if (status.dashboardStatus === "Done") {
          return true;
        }
        return rule.allowNamedDeliverableEvidence && hasNamedDeliverableEvidence(input, status.dashboardEvidence);
      } catch {
        // A disconnected, malformed, or inaccessible sibling only makes this
        // dependency unmet. The source queue item remains independently visible.
        return false;
      }
    },
  };
}

export function staticDependencyResolver(
  results: Readonly<Record<string, boolean>>,
): ProtocolDependencyResolver {
  return {
    async resolveDependency(input) {
      return results[input.dependency] ?? false;
    },
  };
}
