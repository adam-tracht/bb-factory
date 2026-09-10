import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";

const registry = {
  repositories: [{
    configuration: {
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "host-1",
      checkoutPath: "/workspace/monorepo/.factory",
      factoryBranch: "factory" as const,
      mainRef: "origin/main",
    },
    projectId: "project-monorepo",
    environmentId: "environment-monorepo",
  }],
  defaultRepositoryKey: "monorepo",
};

let dispose: (() => Promise<void>) | null = null;

afterEach(async () => {
  await dispose?.();
  dispose = null;
});

describe("factory RPC serialization", () => {
  it("omits absent optional SDK settings fields at the RPC boundary", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-factory",
      settings: {
        repositoryKey: "monorepo",
        repositoryRegistry: JSON.stringify(registry),
      },
    });
    dispose = harness.lifecycle.dispose;

    await plugin(bb);

    const projection = await harness.behavior.callRpc("factory_settings", { repositoryKey: "monorepo" }) as {
      settings: Record<string, unknown>;
    };
    expect(projection.settings).toMatchObject({
      repositoryKey: "monorepo",
      repositoryRegistry: registry,
      timeZone: "server-local",
      nightWindowEndHour: 6,
      runtimeCapSeconds: 10_800,
      minimumStartGapSeconds: 3600,
      concurrencyLimit: 1,
      dispatchMode: "paused",
    });
    expect(projection.settings).not.toHaveProperty("repositoryRoot");
    expect(projection.settings).not.toHaveProperty("connectedHostId");
    expect(projection.settings).not.toHaveProperty("checkoutPath");
    expect(projection.settings).not.toHaveProperty("projectId");
    expect(projection.settings).not.toHaveProperty("environmentId");
    expect(projection.settings).not.toHaveProperty("scheduleCron");
    expect(projection.settings).not.toHaveProperty("providerPreference");
  });
});
