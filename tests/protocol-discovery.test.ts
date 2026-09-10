import { describe, expect, it } from "vitest";
import {
  digestText,
  discoverRepositoryConfigurations,
  type ProtocolFileReadArgs,
  type ProtocolFiles,
  type ProtocolPathListArgs,
  type ProtocolPathListResult,
} from "../src/protocol/index.js";

describe("managed repository discovery", () => {
  it("reads both quoted and unquoted report entries through the connected host boundary", async () => {
    const files = new DiscoveryFiles({
      "merge-state.sh": `#!/bin/sh
# The merge helper is the checked-in discovery source.
report "/Users/adamtracht/Desktop/Code/monorepo-factory" monorepo "/Users/adamtracht/Desktop/Code/monorepo"
report '/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory' diggs-data-platform '/Users/adamtracht/Documents/GitHub/diggs-data-platform'
`,
    });

    await expect(discoverRepositoryConfigurations({
      files,
      factoryRoot: "/Users/adamtracht/.bb/factory",
      connectedHostId: "host-mac",
    })).resolves.toEqual([
      {
        repositoryKey: "monorepo",
        repositoryRoot: "/Users/adamtracht/Desktop/Code/monorepo",
        connectedHostId: "host-mac",
        checkoutPath: "/Users/adamtracht/Desktop/Code/monorepo-factory",
        factoryBranch: "factory",
        mainRef: "origin/main",
      },
      {
        repositoryKey: "diggs-data-platform",
        repositoryRoot: "/Users/adamtracht/Documents/GitHub/diggs-data-platform",
        connectedHostId: "host-mac",
        checkoutPath: "/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory",
        factoryBranch: "factory",
        mainRef: "origin/main",
      },
    ]);
    expect(files.readArgs).toEqual({
      hostId: "host-mac",
      path: "/Users/adamtracht/.bb/factory/merge-state.sh",
      rootPath: "/Users/adamtracht/.bb/factory",
    });
  });

  it("rejects malformed discovery records and traversal before creating configurations", async () => {
    await expect(discoverRepositoryConfigurations({
      files: new DiscoveryFiles({ "merge-state.sh": "report /checkout only-two-fields\n" }),
      factoryRoot: "/factory",
      connectedHostId: "host-mac",
    })).rejects.toMatchObject({ code: "discovery-failed", path: "merge-state.sh" });

    await expect(discoverRepositoryConfigurations({
      files: new DiscoveryFiles({ "merge-state.sh": "report /checkout repo /main\nreport /checkout repo /main-2\n" }),
      factoryRoot: "/factory",
      connectedHostId: "host-mac",
    })).rejects.toMatchObject({ code: "discovery-failed", path: "merge-state.sh" });

    await expect(discoverRepositoryConfigurations({
      files: new DiscoveryFiles({ "merge-state.sh": "report /checkout repo /Users/../main\n" }),
      factoryRoot: "/factory",
      connectedHostId: "host-mac",
    })).rejects.toMatchObject({ code: "path-traversal", path: "/Users/../main" });

    await expect(discoverRepositoryConfigurations({
      files: new DiscoveryFiles({ "merge-state.sh": "report \"/checkout repo /main\n" }),
      factoryRoot: "/factory",
      connectedHostId: "host-mac",
    })).rejects.toMatchObject({ code: "discovery-failed", path: "merge-state.sh" });
  });
});

class DiscoveryFiles implements ProtocolFiles {
  readArgs: ProtocolFileReadArgs | undefined;

  constructor(private readonly source: Readonly<Record<string, string>>) {}

  async read(args: ProtocolFileReadArgs) {
    this.readArgs = args;
    const rootPath = args.rootPath ?? "/factory";
    const relativePath = args.path.slice(rootPath.length + 1);
    const content = this.source[relativePath];
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
    void args;
    return { paths: [], truncated: false };
  }
}
