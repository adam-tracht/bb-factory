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
  it("routes a fresh install to the Add repository flow", () => {
    const result = statusFor({});

    expect(result.resolution).toMatchObject({ status: "disabled", reason: "not-configured" });
    const message = result.needsConfiguration.mock.calls[0]?.[0] as string;
    expect(message).toContain("Add repository");
    expect(message).toContain("bb plugin reload factory");
    expect(message).not.toMatch(/repositoryKey|repositoryRoot|connectedHostId|checkoutPath|projectId/);
  });

  it("routes incomplete legacy configuration to the legacy fields or the registry", () => {
    const result = statusFor({ repositoryKey: "monorepo" });

    expect(result.resolution).toMatchObject({ status: "disabled", reason: "legacy-incomplete" });
    const message = result.needsConfiguration.mock.calls[0]?.[0] as string;
    expect(message).toContain("repositoryKey");
    expect(message).toContain("projectId");
    expect(message).toContain("repositoryRegistry");
    expect(message).toContain("bb plugin reload factory");
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

  it("matches threads by project alone when the entry has no environment id", () => {
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
        }],
        defaultRepositoryKey: "monorepo",
      },
    }));
    const reason = "A configured BB thread became active.";

    // bb auto-registers the unmanaged environment, so its id is not known ahead.
    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "project-monorepo", environmentId: "env-auto-registered" },
      reason,
    )).toMatchObject({ repositoryKey: "monorepo", reason });
    expect(repositoryInvalidationForThread(
      resolution,
      { projectId: "other-project", environmentId: "env-auto-registered" },
      reason,
    )).toBeNull();
  });
});
