import { describe, expect, it, vi } from "vitest";
import { factorySettingsSchema, type RepositoryRegistryEntry } from "../src/contracts.js";
import { createFactoryReadRpcHandlers } from "../src/rpc/read-router.js";
import { createReadComposition, filterTaskCommits } from "../src/services/read-composition.js";
import type { ReadComposition } from "../src/services/read-composition.js";

const revision = {
  gitCommit: "abcdef1234567",
  protocolDigest: "a".repeat(64),
  fileDigests: {},
} as const;

const entries: RepositoryRegistryEntry[] = [
  {
    configuration: {
      repositoryKey: "monorepo",
      repositoryRoot: "/Users/adamtracht/Desktop/Code/monorepo-factory",
      connectedHostId: "host_mpvbhvugjr",
      checkoutPath: "/Users/adamtracht/Desktop/Code/monorepo-factory",
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    projectId: "project-monorepo",
    environmentId: "environment-monorepo",
  },
  {
    configuration: {
      repositoryKey: "data-platform",
      repositoryRoot: "/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory",
      connectedHostId: "host_mpvbhvugjr",
      checkoutPath: "/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory",
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    projectId: "project-data-platform",
    environmentId: "environment-data-platform",
    displayName: "Data platform",
  },
];

const sdk = {
  files: { read: vi.fn(), listPaths: vi.fn() },
  providers: { list: vi.fn(), models: vi.fn() },
  threads: { list: vi.fn(), count: vi.fn(), interactions: { list: vi.fn() } },
  hosts: { get: vi.fn(), list: vi.fn() },
  environments: { status: vi.fn(), get: vi.fn() },
  system: {
    executionOptions: vi.fn(),
    providerStates: vi.fn(),
    usageLimits: vi.fn(),
  },
} as unknown;

function operationalState() {
  return {
    listRuns: vi.fn().mockResolvedValue({
      runs: [{ status: "started" }],
      nextCursor: null,
    }),
    getRun: vi.fn().mockResolvedValue({ run: null }),
  };
}

describe("P1 read integration", () => {
  it("selects both configured repositories and reports the concurrency limit", async () => {
    const settings = factorySettingsSchema.parse({
      repositoryKey: "data-platform",
      repositoryRegistry: { repositories: entries, defaultRepositoryKey: "monorepo" },
      dispatchMode: "enabled",
    });
    const composition = createReadComposition({
      sdk: sdk as never,
      settings,
      operationalState: operationalState(),
    });

    const selection = composition.listRepositories();
    expect(selection.repositories.map((repository) => repository.configuration.repositoryKey)).toEqual([
      "monorepo",
      "data-platform",
    ]);
    expect(selection.selectedRepositoryKey).toBe("data-platform");
    expect(selection.repositories[1]).toMatchObject({ displayName: "Data platform" });
    expect(selection.repositories[1]?.configuration).not.toHaveProperty("displayName");
    const dataSettings = await composition.getSettingsProjection("data-platform");
    expect(dataSettings).toMatchObject({
      settings: {
        repositoryKey: "data-platform",
        repositoryRoot: "/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory",
        connectedHostId: "host_mpvbhvugjr",
        checkoutPath: "/Users/adamtracht/Documents/GitHub/diggs-data-platform-factory",
        projectId: "project-data-platform",
        environmentId: "environment-data-platform",
        dispatchMode: "enabled",
      },
      dispatch: {
        mode: "enabled",
        acceptingNewRuns: false,
        activeRunCount: 1,
        reason: "The concurrency limit is reached.",
      },
    });

    const monorepoSettings = await composition.getSettingsProjection("monorepo");
    expect(monorepoSettings.settings).toMatchObject({
      repositoryKey: "monorepo",
      repositoryRoot: "/Users/adamtracht/Desktop/Code/monorepo-factory",
      connectedHostId: "host_mpvbhvugjr",
      checkoutPath: "/Users/adamtracht/Desktop/Code/monorepo-factory",
      projectId: "project-monorepo",
      environmentId: "environment-monorepo",
      dispatchMode: "enabled",
    });
    expect(settings.repositoryRoot).toBeUndefined();
    expect(settings.projectId).toBeUndefined();
  });

  it("returns an empty selection for an explicit empty registry", () => {
    const settings = factorySettingsSchema.parse({
      repositoryRegistry: { repositories: [], defaultRepositoryKey: null },
    });
    const composition = createReadComposition({
      sdk: sdk as never,
      settings,
      operationalState: operationalState(),
    });
    expect(composition.listRepositories()).toEqual({ repositories: [], selectedRepositoryKey: null });
  });

  it("preserves disabled resolution reasons for status reporting", () => {
    const incomplete = createReadComposition({
      sdk: sdk as never,
      settings: factorySettingsSchema.parse({ repositoryKey: "monorepo" }),
      operationalState: operationalState(),
    });
    expect(incomplete.resolution).toMatchObject({ status: "disabled", reason: "legacy-incomplete" });
    expect(incomplete.listRepositories()).toEqual({ repositories: [], selectedRepositoryKey: null });

    const absent = createReadComposition({
      sdk: sdk as never,
      settings: factorySettingsSchema.parse({}),
      operationalState: operationalState(),
    });
    expect(absent.resolution).toMatchObject({ status: "disabled", reason: "not-configured" });
  });

  it("keeps task commits while excluding factory administrative history", () => {
    expect(filterTaskCommits([
      { sha: "1", subject: "factory: claim MON-1" },
      { sha: "2", subject: "factory: release MON-1 blocked by Q1" },
      { sha: "3", subject: "factory: run record 2026-09-10T00:00:00Z" },
      { sha: "4", subject: "factory: MON-1 implement read projection" },
    ])).toEqual([
      { sha: "4", subject: "factory: MON-1 implement read projection" },
    ]);
  });

  it("routes reads and returns an explicit guarded-action error", async () => {
    const readOnlyAction = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        status: "preview",
        message: "Preview loaded.",
        revision,
        runId: null,
        leaseId: null,
        queueItemId: null,
        action: "preview",
      },
      revision,
    });
    const runReader = vi.fn().mockResolvedValue({ runs: [], nextCursor: null });
    const composition = {
      getRepositoryEntry: (repositoryKey: string) => repositoryKey === "demo" ? { configuration: entries[0]!.configuration } : null,
      readOnlyActionExecutor: { execute: readOnlyAction },
      operationalState: { listRuns: runReader },
    } as unknown as ReadComposition;
    const handlers = createFactoryReadRpcHandlers(() => composition);

    await expect(handlers.factory_action({
      repositoryKey: "demo",
      action: { kind: "preview" },
      idempotencyKey: "bbf:v1:demo:preview:123e4567-e89b-12d3-a456-426614174000",
    })).resolves.toMatchObject({ ok: true, result: { action: "preview" } });
    expect(readOnlyAction).toHaveBeenCalledOnce();

    await expect(handlers.factory_action({
      repositoryKey: "demo",
      action: { kind: "run-now" },
      idempotencyKey: "bbf:v1:demo:run-now:123e4567-e89b-12d3-a456-426614174001",
      expectedRevision: revision,
    })).resolves.toMatchObject({
      ok: false,
      error: { category: "unsupported" },
    });
    expect(readOnlyAction).toHaveBeenCalledOnce();

    await expect(handlers.factory_runs({ repositoryKey: "demo", limit: 50 })).resolves.toEqual({ runs: [], nextCursor: null });
    expect(runReader).toHaveBeenCalledWith({ repositoryKey: "demo", limit: 50 });
  });

  it("keeps an offline host preflight when provider health fails", async () => {
    const host = {
      hostId: "host-1",
      status: "offline" as const,
      checkoutExists: false,
      branch: "factory",
      requiredTools: {},
      browserAvailable: null,
      dbtStudioAvailable: null,
      ok: false,
      reasons: ["BB host 'host-1' is disconnected."],
    };
    const providerFailure = vi.fn().mockRejectedValue(new Error("provider endpoint unavailable"));
    const getHostPreflight = vi.fn().mockResolvedValue(host);
    const composition = {
      getRepositoryEntry: () => ({ configuration: entries[0]!.configuration }),
      healthReader: { listProviderStatus: providerFailure, getHostPreflight },
    } as unknown as ReadComposition;
    const handlers = createFactoryReadRpcHandlers(() => composition);

    await expect(handlers.factory_health({ repositoryKey: "demo" })).resolves.toEqual({
      repositoryKey: "demo",
      providers: [{
        providerId: "unknown",
        model: "unavailable",
        reasoningLevel: "none",
        availability: "unknown",
        limitedUntil: null,
        activeThreadCount: 0,
        lastError: "Could not read live provider health: provider endpoint unavailable",
      }],
      host,
    });
    expect(getHostPreflight).toHaveBeenCalledWith("demo");
  });

  it("keeps provider health when host preflight fails", async () => {
    const providers = [{
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium" as const,
      availability: "available" as const,
      limitedUntil: null,
      activeThreadCount: 1,
      lastError: null,
    }];
    const listProviderStatus = vi.fn().mockResolvedValue(providers);
    const getHostPreflight = vi.fn().mockRejectedValue(new Error("host daemon unavailable"));
    const composition = {
      getRepositoryEntry: () => ({ configuration: entries[0]!.configuration }),
      healthReader: { listProviderStatus, getHostPreflight },
    } as unknown as ReadComposition;
    const handlers = createFactoryReadRpcHandlers(() => composition);

    await expect(handlers.factory_health({ repositoryKey: "demo" })).resolves.toEqual({
      repositoryKey: "demo",
      providers,
      host: {
        hostId: "unknown",
        status: "unknown",
        checkoutExists: false,
        branch: null,
        requiredTools: {},
        browserAvailable: null,
        dbtStudioAvailable: null,
        ok: false,
        reasons: ["Could not read host preflight for repository 'demo': host daemon unavailable"],
      },
    });
    expect(listProviderStatus).toHaveBeenCalledWith("demo");
  });
});
