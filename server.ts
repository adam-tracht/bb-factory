import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { factorySettingsSchema } from "./src/contracts.js";
import { factorySettingDescriptors } from "./src/settings.js";

/**
 * Phase 0 backend entry point. It declares the settings boundary and lifecycle
 * cleanup only. No scheduler, worker, repository write, or RPC handler starts
 * until a later phase is reviewed and integrated.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(factorySettingDescriptors);
  const current = await settings.get();
  factorySettingsSchema.parse(current);

  bb.log.info("loaded Phase 0 contract bootstrap; dispatch remains paused");

  bb.onDispose(() => {
    bb.log.info("disposed Phase 0 contract bootstrap");
  });
}
