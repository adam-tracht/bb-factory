import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  invalidationEventSchema,
  type InvalidationEvent,
  type RepositoryKey,
  type RepositoryRegistryResolution,
} from "./src/contracts.js";
import { factoryRpcContract } from "./src/rpc.js";
import { createFactoryRpcHandlers } from "./src/rpc/action-router.js";
import { factorySettingDescriptors } from "./src/settings.js";
import { createReadComposition } from "./src/services/read-composition.js";
import { createActionComposition, createFactoryComposition, type FactoryComposition } from "./src/services/action-composition.js";
import { initializeOperationalStorage, type OperationalStateStore } from "./src/storage/index.js";
import { registerFactoryLifecycle } from "./src/lifecycle/index.js";
import { registerFactorySchedule } from "./src/schedule/index.js";

export function reportConfigurationStatus(
  bb: Pick<BbPluginApi, "pluginId" | "status">,
  composition: Pick<FactoryComposition, "resolution">,
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
 * The full factory backend: read projections, guarded repository and BB
 * interaction actions, the dispatch engine, the durable scheduler sweep, and
 * startup + periodic reconciliation. The legacy shell dispatcher is not
 * disabled here; cutover is a separate rollout step.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(factorySettingDescriptors);
  const store: OperationalStateStore = initializeOperationalStorage(bb.storage);
  let composition: FactoryComposition | null = null;
  const activeComposition = (): FactoryComposition => {
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

  const buildComposition = (current: ReturnType<typeof factorySettingsSchema.parse>): FactoryComposition => {
    const read = createReadComposition({
      sdk: bb.sdk,
      storage: bb.storage,
      settings: current,
      operationalState: store,
    });
    const action = createActionComposition({
      sdk: bb.sdk,
      composition: read,
      store,
      setDispatchMode: async (mode) => {
        await settings.experimental_set({ dispatchMode: mode });
      },
      log: (message) => bb.log.info(message),
    });
    return createFactoryComposition(read, action);
  };

  try {
    const current = factorySettingsSchema.parse(await settings.get());
    composition = buildComposition(current);
    reportConfigurationStatus(bb, composition);
  } catch (error) {
    rejectInvalidConfiguration(error);
  }

  const publish = (event: InvalidationEvent) => {
    bb.realtime.publish("factory", invalidationEventSchema.parse(event));
  };

  bb.rpc.register(factoryRpcContract, createFactoryRpcHandlers(activeComposition, publish));

  settings.onChange((next) => {
    try {
      const parsed = factorySettingsSchema.parse(next);
      composition = buildComposition(parsed);
      reportConfigurationStatus(bb, composition);
      publish({
        channel: "factory",
        kind: "settings.changed",
        repositoryKey: composition.resolution.status === "configured" ? composition.resolution.selectedRepositoryKey : null,
        revision: null,
        reason: "Factory settings changed; reload the durable read projections.",
        durableReloadRequired: true,
      });
    } catch (error) {
      rejectInvalidConfiguration(error);
    }
  });

  const repositoryKeys = (): RepositoryKey[] =>
    composition?.resolution.status === "configured"
      ? composition.resolution.repositories.map((entry) => entry.configuration.repositoryKey)
      : [];

  const reconcileRepositoryForThread = (thread: unknown) => {
    const repositoryKey = repositoryKeyForThread(composition?.resolution ?? null, thread);
    if (!repositoryKey || !composition) return;
    void composition.dispatchEngine.reconcile(repositoryKey).catch((error) => {
      bb.log.error(`reconciliation for '${repositoryKey}' failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const publishRepositoryInvalidation = (thread: unknown, reason: string) => {
    const event = repositoryInvalidationForThread(composition?.resolution ?? null, thread, reason);
    if (event) publish(event);
  };

  bb.events.on("thread.created", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was created."));
  bb.events.on("thread.active", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread became active."));
  bb.events.on("thread.idle", ({ thread }) => {
    publishRepositoryInvalidation(thread, "A configured BB thread became idle.");
    reconcileRepositoryForThread(thread);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    publishRepositoryInvalidation(thread, "A configured BB thread failed.");
    reconcileRepositoryForThread(thread);
  });
  bb.events.on("thread.archived", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was archived."));
  bb.events.on("thread.deleted", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB thread was deleted."));
  bb.events.on("interaction.pending", ({ thread }) => publishRepositoryInvalidation(thread, "A configured BB interaction became pending."));

  // Startup reconciliation completes before the schedule is registered, so no
  // dispatch tick can run against stale ownership or run state.
  if (composition) {
    try {
      await composition.dispatchEngine.reconcile();
    } catch (error) {
      bb.log.error(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  registerFactoryLifecycle(bb, () => composition?.dispatchContext ?? null, repositoryKeys);
  registerFactorySchedule(bb, () => {
    const current = composition;
    if (!current) return;
    return current.scheduler.tick().then((results) => {
      for (const result of results) {
        if (result.action === "started") {
          bb.log.info(`dispatch tick started a run for '${result.repositoryKey}': ${result.reason}`);
        }
      }
    });
  });

  bb.log.info("loaded factory integration: guarded actions, dispatch, scheduler, and reconciliation active");

  bb.onDispose(() => {
    bb.log.info("disposed factory integration");
  });
}
