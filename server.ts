import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  invalidationEventSchema,
  type InvalidationEvent,
  type RepositoryKey,
  type RepositoryRegistryResolution,
} from "./src/contracts.js";
import { factoryRpcContract } from "./src/rpc.js";
import { createFactoryReadRpcHandlers } from "./src/rpc/read-router.js";
import { factorySettingDescriptors } from "./src/settings.js";
import { createReadComposition, type ReadComposition } from "./src/services/read-composition.js";

export function reportConfigurationStatus(
  bb: Pick<BbPluginApi, "pluginId" | "status">,
  composition: Pick<ReadComposition, "resolution">,
): void {
  if (composition.resolution.status !== "disabled" || composition.resolution.reason === "explicitly-empty") return;
  const message = composition.resolution.reason === "legacy-incomplete"
    ? `Factory legacy repository settings are incomplete. Configure repositoryRegistry, or provide repositoryKey, repositoryRoot, connectedHostId, checkoutPath, projectId, and environmentId. Then run: bb plugin reload ${bb.pluginId}.`
    : `Factory repository configuration is missing. Configure repositoryRegistry, or complete the legacy repository settings. Then run: bb plugin reload ${bb.pluginId}.`;
  bb.status.needsConfiguration(message);
}

export function invalidConfigurationMessage(pluginId: string, error: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? error.message : String(error);
  return `Factory settings are invalid: ${detail} Fix the stored settings, then run: bb plugin reload ${pluginId}.`;
}

export function repositoryKeyForThread(
  resolution: RepositoryRegistryResolution | null,
  thread: unknown,
): RepositoryKey | null {
  if (!resolution || resolution.status !== "configured") return null;
  if (typeof thread !== "object" || thread === null) return null;
  const value = thread as { projectId?: unknown; environmentId?: unknown };
  if (typeof value.projectId !== "string" || typeof value.environmentId !== "string") return null;
  return resolution.repositories.find(
    (entry) => entry.projectId === value.projectId && entry.environmentId === value.environmentId,
  )?.configuration.repositoryKey ?? null;
}

export function repositoryInvalidationForThread(
  resolution: RepositoryRegistryResolution | null,
  thread: unknown,
  reason: string,
): InvalidationEvent | null {
  const repositoryKey = repositoryKeyForThread(resolution, thread);
  if (!repositoryKey) return null;
  return {
    channel: "factory",
    kind: "repository.changed",
    repositoryKey,
    revision: null,
    reason,
    durableReloadRequired: true,
  };
}

/**
 * P1 backend composition. All registered routes are read-only. No scheduler,
 * worker, repository write, or legacy discovery path starts here.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(factorySettingDescriptors);
  let composition: ReadComposition | null = null;
  const activeComposition = (): ReadComposition => {
    if (!composition) {
      throw new Error(invalidConfigurationMessage(bb.pluginId, "The plugin is fail-closed until valid settings are loaded."));
    }
    return composition;
  };
  const rejectInvalidConfiguration = (error: unknown): void => {
    composition = null;
    const message = invalidConfigurationMessage(bb.pluginId, error);
    bb.status.needsConfiguration(message);
    bb.log.error(message);
  };

  try {
    const current = factorySettingsSchema.parse(await settings.get());
    composition = createReadComposition({
      sdk: bb.sdk,
      storage: bb.storage,
      settings: current,
    });
    reportConfigurationStatus(bb, composition);
  } catch (error) {
    rejectInvalidConfiguration(error);
  }

  bb.rpc.register(
    factoryRpcContract,
    createFactoryReadRpcHandlers(activeComposition),
  );

  settings.onChange((next) => {
    try {
      const parsed = factorySettingsSchema.parse(next);
      composition = createReadComposition({
        sdk: bb.sdk,
        storage: bb.storage,
        operationalState: composition?.operationalState,
        settings: parsed,
      });
      reportConfigurationStatus(bb, composition);
      bb.realtime.publish("factory", invalidationEventSchema.parse({
        channel: "factory",
        kind: "settings.changed",
        repositoryKey: composition.resolution.status === "configured" ? composition.resolution.selectedRepositoryKey : null,
        revision: null,
        reason: "Factory settings changed; reload the durable read projections.",
        durableReloadRequired: true,
      }));
    } catch (error) {
      rejectInvalidConfiguration(error);
    }
  });

  const publishRepositoryInvalidation = (thread: unknown, reason: string) => {
    const event = repositoryInvalidationForThread(composition?.resolution ?? null, thread, reason);
    if (event) bb.realtime.publish("factory", invalidationEventSchema.parse(event));
  };

  bb.events.on("thread.created", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was created."));
  bb.events.on("thread.active", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread became active."));
  bb.events.on("thread.idle", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread became idle."));
  bb.events.on("thread.failed", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread failed."));
  bb.events.on("thread.archived", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was archived."));
  bb.events.on("thread.deleted", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was deleted."));
  bb.events.on("interaction.pending", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB interaction became pending."));

  bb.log.info("loaded P1 read-only integration; dispatch, schedulers, and workers remain paused");

  bb.onDispose(() => {
    bb.log.info("disposed P1 read-only integration");
  });
}
