import { describe, expect, it, vi } from "vitest";
import { createLiveHealthReader } from "../src/services/live-health.js";
import type { RepositoryRegistryEntry } from "../src/contracts.js";

const entry: RepositoryRegistryEntry = {
  configuration: {
    repositoryKey: "demo",
    repositoryRoot: "/work/demo",
    connectedHostId: "host-1",
    checkoutPath: "/work/demo",
    factoryBranch: "factory",
    mainRef: "origin/main",
  },
  projectId: "project-1",
  environmentId: "environment-1",
};

function sdkFixture() {
  return {
    providers: {
      list: vi.fn().mockResolvedValue([
        { id: "codex", available: true },
        { id: "claude-code", available: false },
      ]),
      models: vi.fn(({ providerId }: { providerId: string }) => Promise.resolve(
        providerId === "codex"
          ? {
              modelLoadError: null,
              providers: [{ id: "codex", available: true }],
              models: [
                { routeProviderId: "codex", model: "gpt-5", defaultReasoningEffort: "medium", isDefault: true },
              ],
              selectedOnlyModels: [
                { routeProviderId: "codex", model: "gpt-5", defaultReasoningEffort: "medium", isDefault: true },
              ],
            }
          : { modelLoadError: null, providers: [], models: [], selectedOnlyModels: [] },
      )),
    },
    threads: {
      count: vi.fn(({ status }: { status: "starting" | "active" }) => Promise.resolve(
        status === "starting"
          ? { total: 1, groups: [{ key: "codex", count: 1 }, { key: "claude-code", count: 1 }] }
          : { total: 2, groups: [{ key: "codex", count: 2 }] },
      )),
    },
    hosts: {
      get: vi.fn().mockResolvedValue({ id: "host-1", status: "connected" }),
      list: vi.fn().mockResolvedValue([{ id: "host-1", status: "connected" }]),
    },
    environments: {
      get: vi.fn().mockResolvedValue({
        id: "environment-1",
        projectId: "project-1",
        hostId: "host-1",
        path: "/work/demo",
      }),
      status: vi.fn().mockResolvedValue({
        outcome: "available",
        workspace: { branch: { currentBranch: "factory" } },
      }),
    },
    system: {
      providerStates: vi.fn().mockResolvedValue({
        providers: [
          { providerId: "codex", status: "ready", statusMessage: null },
          { providerId: "claude-code", status: "unauthenticated", statusMessage: "Sign-in required." },
        ],
      }),
      usageLimits: vi.fn().mockResolvedValue({
        codex: { status: "ok", windows: [] },
        "claude-code": { status: "unauthenticated" },
      }),
    },
  } as unknown;
}

describe("live health reader", () => {
  it("binds provider counts and host preflight to the configured registry entry", async () => {
    const sdk = sdkFixture();
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: (repositoryKey) => repositoryKey === "demo" ? entry : null,
    });

    await expect(reader.listProviderStatus("demo")).resolves.toEqual([
      {
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        availability: "available",
        limitedUntil: null,
        activeThreadCount: 3,
        lastError: null,
      },
      {
        providerId: "claude-code",
        model: "unavailable",
        reasoningLevel: "none",
        availability: "unavailable",
        limitedUntil: null,
        activeThreadCount: 1,
        lastError: "Sign-in required.",
      },
    ]);
    expect((sdk as { threads: { count: ReturnType<typeof vi.fn> } }).threads.count).toHaveBeenCalledWith({
      groupBy: "provider",
      hostId: "host-1",
      status: "starting",
    });
    expect((sdk as { threads: { count: ReturnType<typeof vi.fn> } }).threads.count).toHaveBeenCalledWith({
      groupBy: "provider",
      hostId: "host-1",
      status: "active",
    });
    await expect(reader.getHostPreflight("demo")).resolves.toMatchObject({
      hostId: "host-1",
      status: "online",
      checkoutExists: true,
      branch: "factory",
      ok: true,
    });
    expect((sdk as { environments: { get: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } }).environments.get)
      .toHaveBeenCalledWith({ environmentId: "environment-1" });
    expect((sdk as { environments: { status: ReturnType<typeof vi.fn> } }).environments.status)
      .toHaveBeenCalledWith({ environmentId: "environment-1" });
  });

  it("carries host permission modes onto provider status", async () => {
    const sdk = sdkFixture() as {
      providers: { list: ReturnType<typeof vi.fn> };
    };
    sdk.providers.list.mockResolvedValue([
      { id: "codex", available: true, capabilities: { permissionModes: ["auto"] } },
    ]);
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => entry,
    });

    const statuses = await reader.listProviderStatus("demo");
    expect(statuses.find((status) => status.providerId === "codex")?.permissionModes).toEqual(["auto"]);
    expect(statuses.find((status) => status.providerId === "claude-code")).not.toHaveProperty("permissionModes");
  });

  it("reports disconnected hosts and branch drift without inventing tool availability", async () => {
    const sdk = sdkFixture() as {
      hosts: { get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
      environments: { get: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
    };
    sdk.hosts.get.mockResolvedValue({ id: "host-1", status: "disconnected" });
    sdk.hosts.list.mockResolvedValue([{ id: "host-1", status: "disconnected" }]);
    sdk.environments.status.mockResolvedValue({
      outcome: "available",
      workspace: { branch: { currentBranch: "main" } },
    });
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => entry,
    });

    const result = await reader.getHostPreflight("demo");
    expect(result).toMatchObject({ status: "offline", checkoutExists: false, branch: "main", ok: false });
    expect(result.requiredTools).toEqual({});
    expect(result.browserAvailable).toBeNull();
    expect(result.dbtStudioAvailable).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining([
      "BB host 'host-1' is disconnected.",
      "Configured checkout is on 'main', expected 'factory'. If the 'factory' branch does not exist yet, initialize the factory protocol and create it first (the protocol scaffolder action covers both).",
    ]));
  });

  it("reports quota exhaustion from SDK usage windows", async () => {
    const sdk = sdkFixture() as {
      system: { usageLimits: ReturnType<typeof vi.fn> };
    };
    sdk.system.usageLimits.mockResolvedValue({
      codex: {
        status: "ok",
        windows: [{ label: "hour", usedPercent: 100, resetsAt: "2026-09-10T12:00:00Z" }],
      },
      "claude-code": { status: "unauthenticated" },
    });
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => entry,
    });

    await expect(reader.listProviderStatus("demo")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "codex",
        availability: "limited",
        limitedUntil: "2026-09-10T12:00:00.000Z",
      }),
    ]));
  });

  it("probes the checkout through host files when the entry has no environment id", async () => {
    const sdk = sdkFixture() as {
      environments: { get: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
      hosts: { pathsExist: ReturnType<typeof vi.fn> } & Record<string, unknown>;
      files: { read: ReturnType<typeof vi.fn> };
    };
    sdk.hosts.pathsExist = vi.fn().mockResolvedValue({
      existence: {
        "/work/demo": true,
        "/work/demo/.git": true,
        "/work/demo/plans/factory": true,
      },
    });
    sdk.files = {
      read: vi.fn(async ({ path }: { path: string }) => {
        if (path === "/work/demo/.git/HEAD") {
          return { content: "ref: refs/heads/factory\n" };
        }
        throw new Error(`no such file: ${path}`);
      }),
    };
    const unmanagedEntry: RepositoryRegistryEntry = { ...entry, environmentId: undefined };
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => unmanagedEntry,
    });

    const result = await reader.getHostPreflight("demo");
    expect(result).toMatchObject({ status: "online", checkoutExists: true, branch: "factory", ok: true });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "No BB environment is registered for this checkout; the first dispatch registers one for the configured path.",
    ]));
    expect(sdk.environments.get).not.toHaveBeenCalled();
    expect(sdk.environments.status).not.toHaveBeenCalled();
    expect(sdk.hosts.pathsExist).toHaveBeenCalledWith({
      hostId: "host-1",
      paths: ["/work/demo", "/work/demo/.git", "/work/demo/plans/factory"],
    });
  });

  it("names the scaffolder remedy when an unmanaged checkout is not on the factory branch", async () => {
    const sdk = sdkFixture() as {
      hosts: { pathsExist: ReturnType<typeof vi.fn> } & Record<string, unknown>;
      files: { read: ReturnType<typeof vi.fn> };
    };
    sdk.hosts.pathsExist = vi.fn().mockResolvedValue({
      existence: {
        "/work/demo": true,
        "/work/demo/.git": true,
        "/work/demo/plans/factory": false,
      },
    });
    sdk.files = {
      read: vi.fn(async ({ path }: { path: string }) => {
        if (path === "/work/demo/.git") {
          return { content: "gitdir: /work/main/.git/worktrees/demo\n" };
        }
        if (path === "/work/main/.git/worktrees/demo/HEAD") {
          return { content: "ref: refs/heads/main\n" };
        }
        throw new Error(`no such file: ${path}`);
      }),
    };
    const unmanagedEntry: RepositoryRegistryEntry = { ...entry, environmentId: undefined };
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => unmanagedEntry,
    });

    const result = await reader.getHostPreflight("demo");
    expect(result.ok).toBe(false);
    expect(result.branch).toBe("main");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "Configured checkout is on 'main', expected 'factory'. If the 'factory' branch does not exist yet, initialize the factory protocol and create it first (the protocol scaffolder action covers both).",
    ]));
    expect(result.reasons.some((reason) => reason.includes("protocol scaffolder"))).toBe(true);
  });

  it("does not query checkout status when the configured environment scope is wrong", async () => {
    const sdk = sdkFixture() as {
      environments: { get: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
    };
    sdk.environments.get.mockResolvedValue({
      id: "environment-1",
      projectId: "different-project",
      hostId: "host-1",
      path: "/work/demo",
    });
    const reader = createLiveHealthReader({
      sdk: sdk as never,
      repositoryLookup: () => entry,
    });

    const result = await reader.getHostPreflight("demo");
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "Could not inspect the configured checkout: Configured environment 'environment-1' belongs to project 'different-project', expected 'project-1'.",
    ]));
    expect(sdk.environments.status).not.toHaveBeenCalled();
  });
});
