import { describe, expect, it, vi } from "vitest";
import { factorySettingsSchema, resolveRepositoryRegistry } from "../src/contracts.js";
import {
  invalidConfigurationMessage,
  reportConfigurationStatus,
  repositoryInvalidationForThread,
} from "../server.js";

function statusFor(settings: unknown) {
  const needsConfiguration = vi.fn();
  const resolution = resolveRepositoryRegistry(factorySettingsSchema.parse(settings));
  reportConfigurationStatus(
    { pluginId: "factory", status: { needsConfiguration } } as never,
    { resolution },
  );
  return { needsConfiguration, resolution };
}

describe("server configuration status", () => {
  it("reports missing configuration with the reload command", () => {
    const result = statusFor({});

    expect(result.resolution).toMatchObject({ status: "disabled", reason: "not-configured" });
    expect(result.needsConfiguration).toHaveBeenCalledWith(
      expect.stringContaining("bb plugin reload factory"),
    );
  });

  it("reports incomplete legacy configuration with the reload command", () => {
    const result = statusFor({ repositoryKey: "monorepo" });

    expect(result.resolution).toMatchObject({ status: "disabled", reason: "legacy-incomplete" });
    expect(result.needsConfiguration).toHaveBeenCalledWith(
      expect.stringContaining("bb plugin reload factory"),
    );
  });

  it("leaves intentional explicit-empty configuration quiet", () => {
    const result = statusFor({
      repositoryRegistry: { repositories: [], defaultRepositoryKey: null },
    });

    expect(result.resolution).toMatchObject({ status: "disabled", reason: "explicitly-empty" });
    expect(result.needsConfiguration).not.toHaveBeenCalled();
  });

  it("makes invalid settings actionable for initial load and reload", () => {
    expect(invalidConfigurationMessage("factory", new Error("repositoryKey must identify a configured repository"))).toBe(
      "Factory settings are invalid: repositoryKey must identify a configured repository Fix the stored settings, then run: bb plugin reload factory.",
    );
  });

  it("only creates lifecycle invalidations for matching configured repositories", () => {
    const resolution = resolveRepositoryRegistry(factorySettingsSchema.parse({
      repositoryRegistry: {
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
      },
    }));
    const reason = "A configured BB thread became active.";

    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "project-monorepo", environmentId: "environment-monorepo" },
      reason,
    )).toMatchObject({ repositoryKey: "monorepo", reason });
    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "other-project", environmentId: "environment-monorepo" },
      reason,
    )).toBeNull();
    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "project-monorepo", environmentId: "other-environment" },
      reason,
    )).toBeNull();
    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "other-project", environmentId: "other-environment" },
      reason,
    )).toBeNull();
  });
});
