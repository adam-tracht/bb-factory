import { describe, expect, beforeEach, it, vi } from "vitest";
import { resolveRepositoryRegistry } from "../src/contracts.js";
import plugin from "../server.js";

const { createComposition, createActionComposition, fakeStore } = vi.hoisted(() => ({
  createComposition: vi.fn(),
  createActionComposition: vi.fn(),
  fakeStore: { marker: "operational-store" },
}));

vi.mock("../src/services/read-composition.js", () => ({
  createReadComposition: createComposition,
}));

vi.mock("../src/services/action-composition.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/action-composition.js")>();
  return {
    ...original,
    createActionComposition: createActionComposition,
  };
});

vi.mock("../src/storage/index.js", () => ({
  initializeOperationalStorage: vi.fn().mockReturnValue(fakeStore),
}));

const registry = {
  repositories: [{
    configuration: {
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "host-1",
      checkoutPath: "/workspace/monorepo/.factory",
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    projectId: "project-monorepo",
    environmentId: "environment-monorepo",
  }],
  defaultRepositoryKey: "monorepo",
};

const validSettings = { repositoryRegistry: registry };
const invalidSettings = { ...validSettings, repositoryKey: "missing" };

function fakeComposition(currentRegistry = registry) {
  return {
    resolution: resolveRepositoryRegistry({
      repositoryRegistry: currentRegistry,
    } as never),
    operationalState: {},
    listRepositories: vi.fn().mockReturnValue({
      repositories: currentRegistry.repositories.map((entry) => ({
        configuration: entry.configuration,
        selected: true,
        available: true,
        reasons: [],
      })),
      selectedRepositoryKey: currentRegistry.defaultRepositoryKey,
    }),
  };
}

function makeBb(initialSettings: unknown) {
  const settingsApi = {
    get: vi.fn().mockResolvedValue(initialSettings),
    onChange: vi.fn(),
  };
  const bb = {
    pluginId: "factory",
    settings: { define: vi.fn().mockReturnValue(settingsApi) },
    sdk: {},
    storage: {},
    status: { needsConfiguration: vi.fn() },
    cli: { register: vi.fn() },
    rpc: { register: vi.fn() },
    realtime: { publish: vi.fn() },
    events: { on: vi.fn() },
    background: { service: vi.fn(), schedule: vi.fn() },
    log: { info: vi.fn(), error: vi.fn() },
    onDispose: vi.fn(),
  };
  return { bb: bb as never, settingsApi, status: bb.status, rpc: bb.rpc, cli: bb.cli };
}

function fakeActionComposition() {
  return {
    repositoryActionExecutor: { execute: vi.fn() },
    bbInteractionActionExecutor: { execute: vi.fn() },
    dispatchEngine: { reconcile: vi.fn().mockResolvedValue(undefined) },
    dispatchContext: {},
    scheduler: { tick: vi.fn().mockResolvedValue([]) },
  };
}

describe("server invalid configuration state", () => {
  beforeEach(() => {
    createComposition.mockReset();
    createComposition.mockImplementation(() => fakeComposition());
    createActionComposition.mockReset();
    createActionComposition.mockImplementation(() => fakeActionComposition());
  });

  it("reports invalid initial settings and registers fail-closed read routes", async () => {
    const harness = makeBb(invalidSettings);

    await plugin(harness.bb);

    expect(createComposition).not.toHaveBeenCalled();
    expect(harness.status.needsConfiguration).toHaveBeenCalledWith(
      expect.stringContaining("bb plugin reload factory"),
    );
    const handlers = harness.rpc.register.mock.calls[0]![1] as {
      factory_repositories(input: { selectedRepositoryKey: null }): unknown;
    };
    expect(() => handlers.factory_repositories({ selectedRepositoryKey: null })).toThrow(/fail-closed/);
  });

  it("drops the prior composition when settings become invalid", async () => {
    const harness = makeBb(validSettings);

    await plugin(harness.bb);
    const onChange = harness.settingsApi.onChange.mock.calls[0]![0] as (next: unknown) => void;
    onChange(invalidSettings);

    expect(createComposition).toHaveBeenCalledOnce();
    expect(harness.status.needsConfiguration).toHaveBeenCalledWith(
      expect.stringContaining("bb plugin reload factory"),
    );
    const handlers = harness.rpc.register.mock.calls[0]![1] as {
      factory_repositories(input: { selectedRepositoryKey: null }): unknown;
    };
    expect(() => handlers.factory_repositories({ selectedRepositoryKey: null })).toThrow(/fail-closed/);
  });

  it("restores a new composition after invalid settings are corrected", async () => {
    const nextRegistry = {
      repositories: [{
        configuration: {
          repositoryKey: "data-platform",
          repositoryRoot: "/workspace/data-platform",
          connectedHostId: "host-2",
          checkoutPath: "/workspace/data-platform/.factory",
          factoryBranch: "factory",
          mainRef: "origin/main",
        },
        projectId: "project-data",
        environmentId: "environment-data",
      }],
      defaultRepositoryKey: "data-platform",
    };
    createComposition
      .mockReset()
      .mockImplementationOnce(() => fakeComposition(registry))
      .mockImplementationOnce(() => fakeComposition(nextRegistry));
    const harness = makeBb(validSettings);

    await plugin(harness.bb);
    const onChange = harness.settingsApi.onChange.mock.calls[0]![0] as (next: unknown) => void;
    onChange(invalidSettings);
    onChange({ repositoryRegistry: nextRegistry });

    expect(createComposition).toHaveBeenCalledTimes(2);
    const handlers = harness.rpc.register.mock.calls[0]![1] as {
      factory_repositories(input: { selectedRepositoryKey: null }): unknown;
    };
    expect(handlers.factory_repositories({ selectedRepositoryKey: null })).toMatchObject({
      selectedRepositoryKey: "data-platform",
      repositories: [expect.objectContaining({ configuration: expect.objectContaining({ repositoryKey: "data-platform" }) })],
    });
  });
});

describe("server CLI registration", () => {
  it("registers one discoverable factory validate command", async () => {
    const harness = makeBb(validSettings);
    await plugin(harness.bb);

    expect(harness.cli.register).toHaveBeenCalledOnce();
    expect(harness.cli.register.mock.calls[0]![0]).toMatchObject({
      name: "factory",
      summary: expect.stringContaining("validate"),
      commands: [expect.objectContaining({ name: "validate", usage: expect.stringContaining("bb factory validate") })],
    });
  });
});
