import { posix } from "node:path";

import { describe, expect, it } from "vitest";
import type { RepositoryConfiguration } from "../src/contracts.js";
import {
  createConnectedHostDependencyResolver,
  digestText,
  parseRepositoryPolicy,
  RepositoryProtocolReader,
  staticMergeReader,
  type ProtocolFileReadArgs,
  type ProtocolFiles,
  type ProtocolPathListArgs,
  type ProtocolPathListResult,
} from "../src/protocol/index.js";

const monorepoConfiguration: RepositoryConfiguration = {
  repositoryKey: "monorepo",
  repositoryRoot: "/workspace/monorepo",
  connectedHostId: "host-mac",
  checkoutPath: "/workspace/monorepo-factory",
  factoryBranch: "factory",
  mainRef: "origin/main",
};
const dataConfiguration: RepositoryConfiguration = {
  repositoryKey: "diggs-data-platform",
  repositoryRoot: "/workspace/diggs-data-platform",
  connectedHostId: "host-mac",
  checkoutPath: "/workspace/diggs-data-platform-factory",
  factoryBranch: "factory",
  mainRef: "origin/main",
};
const mergeProjection = {
  gitCommit: "abcdef1",
  factoryAhead: 1,
  mainBehind: 0,
  taskCommits: [{ sha: "1234567", subject: "Protocol fixture" }],
  safeFastForward: true,
} as const;

describe("qualified repository dependencies", () => {
  it("uses repo.md policy, requires the sibling queue, and supports the named-deliverable exception", async () => {
    const files = makeFiles({
      ...repositoryFiles(monorepoConfiguration, [
        queueItem("MON-ready", "Ready cross-repository item", "diggs-data-platform:DATA-0007.01"),
        queueItem(
          "MON-exception",
          "Named deliverable cross-repository item",
          "diggs-data-platform:DATA-0007.02",
          ["cost_coverage_materiality_threshold"],
        ),
        queueItem(
          "MON-negative-pending",
          "Pending named deliverable",
          "diggs-data-platform:DATA-0007.03",
          ["foo_bar"],
        ),
        queueItem(
          "MON-negative-negated",
          "Negated named deliverable",
          "diggs-data-platform:DATA-0007.04",
          ["foo_bar"],
        ),
        queueItem(
          "MON-boundary",
          "Similar named deliverable",
          "diggs-data-platform:DATA-0007.05",
          ["foo_bar"],
        ),
        queueItem("MON-ascii-isnt", "ASCII is not shipped", "diggs-data-platform:DATA-0007.06", ["foo_bar"]),
        queueItem("MON-ascii-hasnt", "ASCII has not shipped", "diggs-data-platform:DATA-0007.07", ["foo_bar"]),
        queueItem("MON-curly-isnt", "Curly is not shipped", "diggs-data-platform:DATA-0007.08", ["foo_bar"]),
        queueItem("MON-curly-hasnt", "Curly has not shipped", "diggs-data-platform:DATA-0007.09", ["foo_bar"]),
        queueItem("MON-affirmative-is", "Explicit is shipped", "diggs-data-platform:DATA-0007.10", ["foo_bar"]),
        queueItem("MON-affirmative-has", "Explicit has been shipped", "diggs-data-platform:DATA-0007.11", ["foo_bar"]),
        queueItem("MON-affirmative-prefix", "Explicit shipped prefix", "diggs-data-platform:DATA-0007.12", ["foo_bar"]),
        queueItem("MON-leading-qualifier", "Leading qualifier", "diggs-data-platform:DATA-0007.13", ["foo_bar"]),
        queueItem("MON-question", "Question assertion", "diggs-data-platform:DATA-0007.14", ["foo_bar"]),
        queueItem("MON-conditional", "Conditional assertion", "diggs-data-platform:DATA-0007.15", ["foo_bar"]),
        queueItem("MON-modal", "Modal assertion", "diggs-data-platform:DATA-0007.16", ["foo_bar"]),
        queueItem("MON-unresolved", "Missing sibling item", "diggs-data-platform:DATA-missing"),
        queueItem("MON-local-done", "Local completed item", "none", [], "done"),
        queueItem("MON-local-dependent", "Local dependent item", "MON-local-done"),
      ].join("\n"), [
        "Queue entries may list depends_on: diggs-data-platform:DATA-NNNN.",
        "Before treating such a dependency as met, read the sibling queue and dashboard.",
        "The dashboard row must be Done, or the specific deliverable named in our entry must be listed as shipped in the row's evidence.",
      ].join(" "), [], "Queue entries may list depends_on: unsupported:ITEM-NNNN."),
      ...repositoryFiles(dataConfiguration, [
        queueItem("DATA-0007.01", "Published data contract", "none", [], "done"),
        queueItem("DATA-0007.02", "Published threshold field", "none", [], "done"),
        queueItem("DATA-0007.03", "Pending field", "none", [], "done"),
        queueItem("DATA-0007.04", "Negated field", "none", [], "done"),
        queueItem("DATA-0007.05", "Similar field", "none", [], "done"),
        queueItem("DATA-0007.06", "ASCII is not shipped", "none", [], "done"),
        queueItem("DATA-0007.07", "ASCII has not shipped", "none", [], "done"),
        queueItem("DATA-0007.08", "Curly is not shipped", "none", [], "done"),
        queueItem("DATA-0007.09", "Curly has not shipped", "none", [], "done"),
        queueItem("DATA-0007.10", "Explicit is shipped", "none", [], "done"),
        queueItem("DATA-0007.11", "Explicit has been shipped", "none", [], "done"),
        queueItem("DATA-0007.12", "Explicit shipped prefix", "none", [], "done"),
        queueItem("DATA-0007.13", "Leading qualifier", "none", [], "done"),
        queueItem("DATA-0007.14", "Question assertion", "none", [], "done"),
        queueItem("DATA-0007.15", "Conditional assertion", "none", [], "done"),
        queueItem("DATA-0007.16", "Modal assertion", "none", [], "done"),
      ].join("\n"), "", [
        ["DATA-0007.01", "Done", "mart_pnl_weekly.cost_coverage_materiality_threshold shipped"],
        ["DATA-0007.02", "Active", "cost_coverage_materiality_threshold shipped"],
        ["DATA-0007.03", "Active", "foo_bar pending; baz shipped"],
        ["DATA-0007.04", "Active", "foo_bar not shipped"],
        ["DATA-0007.05", "Active", "foo_bar_extra shipped"],
        ["DATA-0007.06", "Active", "foo_bar isn't shipped"],
        ["DATA-0007.07", "Active", "foo_bar hasn't shipped"],
        ["DATA-0007.08", "Active", "foo_bar isn’t shipped"],
        ["DATA-0007.09", "Active", "foo_bar hasn’t shipped"],
        ["DATA-0007.10", "Active", "foo_bar is shipped"],
        ["DATA-0007.11", "Active", "foo_bar has been shipped"],
        ["DATA-0007.12", "Active", "Shipped: foo_bar"],
        ["DATA-0007.13", "Active", "Maybe foo_bar shipped"],
        ["DATA-0007.14", "Active", "foo_bar shipped?"],
        ["DATA-0007.15", "Active", "foo_bar shipped only if validation passes"],
        ["DATA-0007.16", "Active", "foo_bar may be shipped"],
      ]),
    });
    const reader = makeReader(files);

    const snapshot = await reader.loadSnapshot(monorepoConfiguration);
    expect(snapshot.queue.find((entry) => entry.id === "MON-ready")).toMatchObject({
      eligible: true,
      eligibilityReasons: [],
      dependsOn: ["diggs-data-platform:DATA-0007.01"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "MON-exception")).toMatchObject({
      eligible: true,
      eligibilityReasons: [],
    });
    expect(snapshot.queue.find((entry) => entry.id === "MON-negative-pending")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "MON-negative-negated")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "MON-boundary")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    for (const id of ["MON-ascii-isnt", "MON-ascii-hasnt", "MON-curly-isnt", "MON-curly-hasnt"]) {
      expect(snapshot.queue.find((entry) => entry.id === id)).toMatchObject({
        eligible: false,
        eligibilityReasons: ["unmet-dependency"],
      });
    }
    for (const id of ["MON-affirmative-is", "MON-affirmative-has", "MON-affirmative-prefix"]) {
      expect(snapshot.queue.find((entry) => entry.id === id)).toMatchObject({
        eligible: true,
        eligibilityReasons: [],
      });
    }
    for (const id of ["MON-leading-qualifier", "MON-question", "MON-conditional", "MON-modal"]) {
      expect(snapshot.queue.find((entry) => entry.id === id)).toMatchObject({
        eligible: false,
        eligibilityReasons: ["unmet-dependency"],
      });
    }
    expect(snapshot.queue.find((entry) => entry.id === "MON-unresolved")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "MON-local-dependent")).toMatchObject({
      eligible: true,
      eligibilityReasons: [],
    });
    expect(files.readCalls.some((call) => call.path.endsWith("/merge-state.sh"))).toBe(false);
    expect(parseRepositoryPolicy(
      files.content[monorepoConfiguration.checkoutPath + "/plans/factory/repo.md"],
      "plans/factory/repo.md",
    )).toEqual({
      qualifiedDependencies: [{
        repositoryKey: "diggs-data-platform",
        dashboardRequirement: "done",
        allowNamedDeliverableEvidence: true,
      }],
    });
  });

  it("requires Done with evidence for data-platform dependencies and keeps other statuses unmet", async () => {
    const files = makeFiles({
      ...repositoryFiles(dataConfiguration, [
        queueItem("DATA-empty-evidence", "Missing dashboard evidence", "monorepo:MON-done-empty"),
        queueItem("DATA-active", "Sibling is still active", "monorepo:MON-active"),
        queueItem("DATA-satisfied", "Sibling is complete", "monorepo:MON-done-evidence"),
      ].join("\n"), [
        "Queue entries may list depends_on: monorepo:MON-NNNN.",
        "Before treating such a dependency as met, read the sibling queue and plans/README.md.",
        "Confirm the ID status is Done (with evidence). Any other status means the dependency is unmet.",
      ].join(" ")),
      ...repositoryFiles(monorepoConfiguration, [
        queueItem("MON-done-empty", "Done without evidence", "none", [], "done"),
        queueItem("MON-active", "Not complete", "none", [], "in-progress work"),
        queueItem("MON-done-evidence", "Done with evidence", "none", [], "done"),
      ].join("\n"), "", [
        ["MON-done-empty", "Done", ""],
        ["MON-active", "Active", "shipped evidence"],
        ["MON-done-evidence", "Done", "Shipped in the canonical dashboard evidence."],
      ]),
    });
    const reader = makeReader(files);

    const snapshot = await reader.loadSnapshot(dataConfiguration);
    expect(snapshot.queue.find((entry) => entry.id === "DATA-empty-evidence")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "DATA-active")).toMatchObject({
      eligible: false,
      eligibilityReasons: ["unmet-dependency"],
    });
    expect(snapshot.queue.find((entry) => entry.id === "DATA-satisfied")).toMatchObject({
      eligible: true,
      eligibilityReasons: [],
    });
  });
});

describe("merge-state.sh discovery gating", () => {
  const discoveredSibling: RepositoryConfiguration = {
    repositoryKey: "sibling",
    repositoryRoot: "/sibling",
    connectedHostId: "host-mac",
    checkoutPath: "/sibling-factory",
    factoryBranch: "factory",
    mainRef: "origin/main",
  };

  const dependencyInput = (dependency: string, repositoryKey: string) => ({
    sourceConfiguration: monorepoConfiguration,
    sourceEntry: {
      id: "MON-1",
      title: "Source item",
      planPath: "plans/tasks/mon-1.md",
      acceptance: [],
      validate: [],
      notes: null,
    },
    dependency,
    policy: {
      qualifiedDependencies: [{
        repositoryKey,
        dashboardRequirement: "done" as const,
        allowNamedDeliverableEvidence: false,
      }],
    },
  });

  const siblingFiles = () => repositoryFiles(discoveredSibling, [
    queueItem("SIB-1", "Sibling item", "none", [], "done"),
  ].join("\n"), "", [["SIB-1", "Done", "Shipped in the sibling dashboard."]]);

  it("prefers the configured registry and never reads merge-state.sh", async () => {
    const files = makeFiles(siblingFiles());
    const resolver = createConnectedHostDependencyResolver({
      files,
      repositoryRegistry: {
        listRepositories: () => [monorepoConfiguration, discoveredSibling],
      },
      repositoryDiscovery: {
        files,
        factoryRoot: "/factory-without-merge-state",
        connectedHostId: "host-mac",
      },
    });

    await expect(resolver.resolveDependency(dependencyInput("sibling:SIB-1", "sibling"))).resolves.toBe(true);
    expect(files.readCalls.some((call) => call.path.endsWith("/merge-state.sh"))).toBe(false);
  });

  it("treats a missing merge-state.sh as an unmet dependency without surfacing an error", async () => {
    const files = makeFiles(siblingFiles());
    const resolver = createConnectedHostDependencyResolver({
      files,
      repositoryDiscovery: {
        files,
        factoryRoot: "/factory",
        connectedHostId: "host-mac",
      },
    });

    await expect(resolver.resolveDependency(dependencyInput("sibling:SIB-1", "sibling"))).resolves.toBe(false);
    expect(files.readCalls.some((call) => call.path === "/factory/merge-state.sh")).toBe(true);
  });

  it("resolves through merge-state.sh discovery when the configured file exists", async () => {
    const files = makeFiles({
      ...siblingFiles(),
      "/factory/merge-state.sh": "#!/bin/sh\nreport /sibling-factory sibling /sibling\n",
    });
    const resolver = createConnectedHostDependencyResolver({
      files,
      repositoryDiscovery: {
        files,
        factoryRoot: "/factory",
        connectedHostId: "host-mac",
      },
    });

    await expect(resolver.resolveDependency(dependencyInput("sibling:SIB-1", "sibling"))).resolves.toBe(true);
    expect(files.readCalls.some((call) => call.path === "/factory/merge-state.sh")).toBe(true);
  });
});

function makeReader(files: ProtocolFiles): RepositoryProtocolReader {
  return new RepositoryProtocolReader(files, {
    mergeReader: staticMergeReader(mergeProjection),
    dependencyResolver: createConnectedHostDependencyResolver({
      files,
      repositoryRegistry: {
        async listRepositories() {
          return [monorepoConfiguration, dataConfiguration];
        },
      },
    }),
    now: () => new Date("2026-09-10T06:00:00Z"),
  });
}

function queueItem(
  id: string,
  title: string,
  dependsOn: string,
  acceptance: readonly string[] = [],
  status = "ready",
): string {
  return [
    "## " + id + " " + title,
    "status: " + status,
    "priority: 1",
    "depends_on: " + dependsOn,
    "risk: low",
    "plan: plans/tasks/" + id.toLowerCase() + ".md",
    "approved: approved by test fixture",
    "acceptance:",
    ...(acceptance.length > 0 ? acceptance.map((item) => "- " + item) : ["- fixture is valid"]),
    "validate:",
    "- pnpm test",
  ].join("\n");
}

function repositoryFiles(
  configuration: RepositoryConfiguration,
  queue: string,
  policy: string,
  dashboardRows: readonly [string, string, string][] = [],
  foremanPolicy = "",
): Record<string, string> {
  const prefix = configuration.checkoutPath;
  const dashboard = [
    "# Dashboard",
    "",
    "| ID | Work Item | Status | Next action or remaining outcome | Evidence and canonical detail |",
    "| --- | --- | --- | --- | --- |",
    ...dashboardRows.map(([id, status, evidence]) =>
      "| " + id + " | Fixture | " + status + " | Review | " + evidence + " |",
    ),
  ].join("\n") + "\n";
  return {
    [prefix + "/plans/factory/foreman.md"]: "Repository foreman instructions.\n" + foremanPolicy + "\n",
    [prefix + "/plans/factory/repo.md"]: policy ? "# Repository policy\n\n" + policy + "\n" : "# Repository policy\n",
    [prefix + "/plans/factory/queue.md"]: "# Queue\n\n" + queue + "\n",
    [prefix + "/plans/factory/questions.md"]: "# Questions\n",
    [prefix + "/plans/factory/current.md"]: "state: no-op\n",
    [prefix + "/plans/README.md"]: dashboard,
  };
}

class MemoryProtocolFiles implements ProtocolFiles {
  readonly content: Readonly<Record<string, string>>;
  readonly readCalls: ProtocolFileReadArgs[] = [];
  readonly listCalls: ProtocolPathListArgs[] = [];

  constructor(content: Readonly<Record<string, string>>) {
    this.content = content;
  }

  async read(args: ProtocolFileReadArgs) {
    this.readCalls.push(args);
    const content = this.content[args.path];
    if (content === undefined) {
      throw new Error("ENOENT: no such file or directory");
    }
    return {
      content,
      contentEncoding: "utf8" as const,
      path: args.path,
      sha256: digestText(content),
      sizeBytes: Buffer.byteLength(content),
    };
  }

  async listPaths(args: ProtocolPathListArgs): Promise<ProtocolPathListResult> {
    this.listCalls.push(args);
    const prefix = args.path.endsWith("/") ? args.path : args.path + "/";
    const paths = Object.keys(this.content)
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map((path) => ({
        kind: "file" as const,
        name: posix.basename(path),
        path,
      }));
    if (paths.length === 0) {
      throw new Error("ENOENT: no such file or directory");
    }
    return { paths, truncated: false };
  }
}

function makeFiles(content: Readonly<Record<string, string>>): MemoryProtocolFiles {
  return new MemoryProtocolFiles(content);
}
