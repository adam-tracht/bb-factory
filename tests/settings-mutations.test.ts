import { describe, expect, it, vi } from "vitest";
import { factorySettingsSchema, type FactorySettings } from "../src/contracts.js";
import { createSettingsMutationHandlers } from "../src/services/settings-mutations.js";
import type { ReadComposition } from "../src/services/read-composition.js";
import { makeConfiguration, makeRegistryEntry, makeSettings } from "./fakes.js";

function harness(
  settingsOverrides: Partial<FactorySettings> = {},
  persist?: (values: Record<string, string | number | boolean | null>) => Promise<void>,
) {
  const settings = makeSettings(settingsOverrides);
  const applied: Array<Record<string, string | number | boolean | null>> = [];
  const composition = {
    getRepositoryEntry: (repositoryKey: string) =>
      settings.repositoryRegistry?.repositories.find((entry) => entry.configuration.repositoryKey === repositoryKey) ?? null,
  } as unknown as ReadComposition;
  const handlers = createSettingsMutationHandlers({
    getSettings: () => settings,
    getComposition: () => composition,
    applySettings: async (values) => {
      applied.push(values);
      await persist?.(values);
    },
    sdk: {
      files: {
        read: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
      },
    } as never,
  });
  return { settings, applied, handlers };
}

describe("settings mutation handlers", () => {
  it("applies a validated global dispatch patch", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_update_settings({
      repositoryKey: "monorepo",
      patch: { scheduleCron: "*/15 1-5 * * *", concurrencyLimit: 2, providerPreference: "alternate" },
    });
    expect(result).toMatchObject({ ok: true });
    expect(applied).toEqual([{ scheduleCron: "*/15 1-5 * * *", concurrencyLimit: 2, providerPreference: "alternate" }]);
  });

  it("accepts a host-reported provider id as the dispatch preference", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_update_settings({
      repositoryKey: "monorepo",
      patch: { providerPreference: "acp-opencode" },
    });
    expect(result).toMatchObject({ ok: true });
    expect(applied).toEqual([{ providerPreference: "acp-opencode" }]);
  });

  it("unsets optional fields with null and rejects invalid merges", async () => {
    const { applied, handlers } = harness();
    expect(await handlers.factory_update_settings({
      repositoryKey: "monorepo",
      patch: { scheduleCron: null },
    })).toMatchObject({ ok: true });
    expect(applied).toEqual([{ scheduleCron: null }]);

    const invalid = await handlers.factory_update_settings({
      repositoryKey: "monorepo",
      patch: { concurrencyLimit: 0 },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.category).toBe("invalid-input");
      expect(invalid.error.fieldErrors?.concurrencyLimit).toBeDefined();
    }
  });

  it("rejects patches that would break the merged settings schema", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_update_settings({
      repositoryKey: "monorepo",
      patch: { minimumStartGapSeconds: 59 },
    });
    expect(result.ok).toBe(false);
    expect(applied).toEqual([]);
  });

  it("toggles per-repository dispatch pause inside the registry JSON", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_update_repository({
      repositoryKey: "monorepo",
      dispatchPaused: true,
    });
    expect(result).toMatchObject({ ok: true });
    const registry = JSON.parse(String(applied[0]?.repositoryRegistry)) as {
      repositories: Array<{ dispatchPaused?: boolean; configuration: { repositoryKey: string } }>;
      defaultRepositoryKey: string;
    };
    expect(registry.repositories[0]?.dispatchPaused).toBe(true);
    expect(registry.repositories[0]?.configuration.repositoryKey).toBe("monorepo");
    expect(registry.defaultRepositoryKey).toBe("monorepo");

    const missing = await handlers.factory_update_repository({
      repositoryKey: "ghost",
      dispatchPaused: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.category).toBe("not-found");
  });

  it("sets and clears a display name without changing repository identity or metadata", async () => {
    const entry = { ...makeRegistryEntry(), displayName: "Old name", dispatchPaused: true };
    const other = {
      ...makeRegistryEntry(),
      configuration: {
        ...makeConfiguration(),
        repositoryKey: "other",
        repositoryRoot: "/work/other",
        checkoutPath: "/work/other-factory",
      },
    };
    const { applied, handlers } = harness({
      repositoryRegistry: { repositories: [entry, other], defaultRepositoryKey: "other" },
    });

    const saved = await handlers.factory_update_repository({
      repositoryKey: "monorepo",
      displayName: "  New name  ",
    });
    expect(saved).toMatchObject({ ok: true, message: "Display name saved as 'New name'." });
    const updated = JSON.parse(String(applied[0]?.repositoryRegistry)) as NonNullable<FactorySettings["repositoryRegistry"]>;
    expect(updated).toEqual({
      repositories: [{ ...entry, displayName: "New name" }, other],
      defaultRepositoryKey: "other",
    });

    const cleared = await handlers.factory_update_repository({ repositoryKey: "monorepo", displayName: null });
    expect(cleared).toMatchObject({ ok: true, message: "Display name cleared for 'monorepo'." });
    const clearedRegistry = JSON.parse(String(applied[1]?.repositoryRegistry)) as {
      repositories: Array<{ displayName?: string; dispatchPaused?: boolean; configuration: { repositoryKey: string } }>;
    };
    expect(clearedRegistry.repositories[0]).toMatchObject({ dispatchPaused: true, configuration: { repositoryKey: "monorepo" } });
    expect(clearedRegistry.repositories[0]?.displayName).toBeUndefined();
    expect(clearedRegistry.repositories[1]).toEqual(other);
  });

  it("persists identical display names for different repository keys", async () => {
    const first = makeRegistryEntry();
    const second = {
      ...makeRegistryEntry(),
      configuration: {
        ...makeConfiguration(),
        repositoryKey: "other",
        repositoryRoot: "/work/other",
        checkoutPath: "/work/other-factory",
      },
    };
    const { settings, applied, handlers } = harness({
      repositoryRegistry: { repositories: [first, second], defaultRepositoryKey: "monorepo" },
    });

    expect(await handlers.factory_update_repository({
      repositoryKey: "monorepo",
      displayName: "Shared name",
    })).toMatchObject({ ok: true });
    settings.repositoryRegistry = JSON.parse(String(applied[0]?.repositoryRegistry)) as FactorySettings["repositoryRegistry"];

    expect(await handlers.factory_update_repository({
      repositoryKey: "other",
      displayName: "Shared name",
    })).toMatchObject({ ok: true });
    const updated = JSON.parse(String(applied[1]?.repositoryRegistry)) as NonNullable<FactorySettings["repositoryRegistry"]>;
    expect(updated.repositories.map((entry) => ({
      repositoryKey: entry.configuration.repositoryKey,
      displayName: entry.displayName,
    }))).toEqual([
      { repositoryKey: "monorepo", displayName: "Shared name" },
      { repositoryKey: "other", displayName: "Shared name" },
    ]);
  });

  it("reports a display-name persistence failure without claiming success", async () => {
    const { applied, handlers } = harness({}, async () => {
      throw new Error("disk full");
    });
    const result = await handlers.factory_update_repository({
      repositoryKey: "monorepo",
      displayName: "Friendly repo",
    });
    expect(result).toEqual({
      ok: false,
      error: { category: "internal", message: "Could not persist the repository registry: disk full" },
    });
    expect(applied).toHaveLength(1);
  });

  it("adds a repository entry paused by default and reports missing protocol files", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_add_repository({
      configuration: {
        repositoryKey: "data-platform",
        repositoryRoot: "/work/data",
        connectedHostId: "host-1",
        checkoutPath: "/work/data-factory",
        mainRef: "origin/main",
      },
      projectId: "project-9",
      environmentId: "env-9",
      dispatchPaused: true,
      displayName: "  Data platform  ",
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain("Data platform");
    expect(result.ok && result.message).toContain("paused");
    expect(result.ok && result.message).toContain("No plans/factory/ protocol files");
    const registry = JSON.parse(String(applied[0]?.repositoryRegistry)) as {
      repositories: Array<{ displayName?: string; dispatchPaused?: boolean; configuration: { repositoryKey: string; factoryBranch: string } }>;
    };
    expect(registry.repositories).toHaveLength(2);
    expect(registry.repositories[1]?.configuration.factoryBranch).toBe("factory");
    expect(registry.repositories[1]?.dispatchPaused).toBe(true);
    expect(registry.repositories[1]?.displayName).toBe("Data platform");
  });

  it("adds a repository entry without an environment id", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_add_repository({
      configuration: {
        repositoryKey: "data-platform",
        repositoryRoot: "/work/data",
        connectedHostId: "host-1",
        checkoutPath: "/work/data-factory",
        mainRef: "origin/main",
      },
      projectId: "project-9",
      dispatchPaused: true,
    });
    expect(result).toMatchObject({ ok: true });
    const registry = JSON.parse(String(applied[0]?.repositoryRegistry)) as {
      repositories: Array<{ environmentId?: string; configuration: { repositoryKey: string } }>;
    };
    expect(registry.repositories[1]?.configuration.repositoryKey).toBe("data-platform");
    expect(registry.repositories[1]?.environmentId).toBeUndefined();
  });

  it("rejects a duplicate repository key", async () => {
    const { applied, handlers } = harness();
    const result = await handlers.factory_add_repository({
      configuration: {
        repositoryKey: "monorepo",
        repositoryRoot: "/work/monorepo",
        connectedHostId: "host-1",
        checkoutPath: "/work/monorepo-factory",
        mainRef: "origin/main",
      },
      projectId: "project-9",
      environmentId: "env-9",
      dispatchPaused: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("conflict");
    expect(applied).toEqual([]);
  });

  it("keeps the settings schema shape valid after mutation", () => {
    expect(factorySettingsSchema.parse(makeSettings()).dispatchMode).toBe("enabled");
    const entry = makeRegistryEntry();
    expect(entry.dispatchPaused).toBeUndefined();
    expect(makeConfiguration().factoryBranch).toBe("factory");
  });
});
