import { describe, expect, it } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { runFactoryValidate } from "../src/cli.js";
import { digestText } from "../src/protocol/files.js";

const checkout = "/remote/checkout";
const protocol = {
  "plans/factory/foreman.md": "# Foreman\n",
  "plans/factory/repo.md": "# Repository\n",
  "plans/factory/queue.md": "# Queue\n",
  "plans/factory/questions.md": "# Questions\n",
  "plans/factory/current.md": "# Current\nstate: no-op\n",
  "plans/README.md": "# Dashboard\n\n| id | work item | status | next action | evidence and canonical detail |\n|---|---|---|---|---|\n",
};

function makeSdk(overrides: Partial<typeof protocol> = {}) {
  const source = { ...protocol, ...overrides };
  const reads: Array<{ hostId?: string; path: string; rootPath?: string }> = [];
  const sdk = {
    threads: {
      get: async () => ({ environmentId: "environment-1" }),
    },
    environments: {
      get: async () => ({ hostId: "host-1", path: checkout }),
    },
    files: {
      read: async (args: { hostId?: string; path: string; rootPath?: string }) => {
        reads.push(args);
        const relativePath = args.path.slice(`${checkout}/`.length);
        const content = source[relativePath as keyof typeof source];
        if (content === undefined) throw new Error(`HTTP 404: Path does not exist: ${args.path}`);
        return {
          ...args,
          content,
          contentEncoding: "utf8" as const,
          sha256: digestText(content),
          sizeBytes: Buffer.byteLength(content),
        };
      },
    },
    reads,
  };
  return sdk;
}

describe("factory validate CLI handler", () => {
  it("resolves the thread environment, reads through the host files port, and reports all findings", async () => {
    const sdk = makeSdk({
      "plans/factory/current.md": "# Current\nstate: idle\n",
      "plans/README.md": "# Dashboard\n\n| id | work item | status | next action | evidence and canonical detail |\n|---|---|---|---|---|\n| TASK-1 | Task | Done | none | first | second |\n",
    });
    const result = await runFactoryValidate(sdk as never, { json: false }, { threadId: "thread-1" });

    expect(result).toEqual({
      exitCode: 1,
      stdout: [
        "plans/factory/current.md:2: Current state 'idle' is invalid (rule current-state). Fix: end the file with state: success, blocked, failed-safe, or no-op",
        "plans/README.md:5: dashboard row has 6 columns, expected 5 (rule dashboard-column-count). Fix: escape a literal pipe inside a cell as \\|",
        "",
      ].join("\n"),
    });
    expect(sdk.reads).toHaveLength(7);
    expect(sdk.reads.every((read) => read.hostId === "host-1" && read.rootPath === checkout)).toBe(true);
  });

  it("returns protocol ok for a clean checkout and structured JSON when requested", async () => {
    const sdk = makeSdk();
    await expect(runFactoryValidate(sdk as never, { json: false }, { threadId: "thread-1" })).resolves.toEqual({
      exitCode: 0,
      stdout: "protocol ok\n",
    });
    await expect(runFactoryValidate(sdk as never, { json: true }, { threadId: "thread-1" })).resolves.toEqual({
      exitCode: 0,
      stdout: '{"ok":true,"diagnostics":[]}',
    });
  });

  it("keeps oversized JSON diagnostics valid and reports omitted entries", async () => {
    const rows = Array.from({ length: 12_000 }, (_, index) =>
      `| TASK-${index} | Task | Done | none | first | second |`,
    ).join("\n");
    const sdk = makeSdk({
      "plans/README.md": [
        "# Dashboard",
        "",
        "| id | work item | status | next action | evidence and canonical detail |",
        "|---|---|---|---|---|",
        rows,
        "",
      ].join("\n"),
    });

    const result = await runFactoryValidate(sdk as never, { json: true }, { threadId: "thread-1" });
    const payload = JSON.parse(result.stdout ?? "");
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics.length).toBeGreaterThan(0);
    expect(payload.truncatedCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThanOrEqual(PLUGIN_CLI_OUTPUT_MAX_BYTES);
  });
});
