import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  addRepositoryInputSchema,
  factoryActionRequestSchema,
  factoryActionResultSchema,
  healthProjectionSchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  pickFolderInputSchema,
  pickFolderResultSchema,
  probeRepositoryInputSchema,
  protocolSnapshotSchema,
  registryOptionsProjectionSchema,
  repositoryKeySchema,
  repositoryProbeSchema,
  repositorySelectionInputSchema,
  repositorySelectionProjectionSchema,
  repositoryReadInputSchema,
  resolveProjectInputSchema,
  resolveProjectResultSchema,
  settingsMutationResultSchema,
  settingsProjectionSchema,
  updateRepositoryInputSchema,
  updateSettingsInputSchema,
} from "./contracts.js";

/**
 * Phase 0 wire contract. Handlers are deliberately not registered yet. Every
 * later action must use these schemas and return a durable-state result.
 */
export const factoryRpcContract = defineRpcContract({
  factory_snapshot: {
    input: z.object({ repositoryKey: repositoryKeySchema }).strict(),
    output: protocolSnapshotSchema,
  },
  factory_action: {
    input: factoryActionRequestSchema,
    output: factoryActionResultSchema,
  },
  factory_repositories: {
    input: repositorySelectionInputSchema,
    output: repositorySelectionProjectionSchema,
  },
  factory_settings: {
    input: repositoryReadInputSchema,
    output: settingsProjectionSchema,
  },
  factory_health: {
    input: repositoryReadInputSchema,
    output: healthProjectionSchema,
  },
  factory_interactions: {
    input: repositoryReadInputSchema,
    output: pendingInteractionsProjectionSchema,
  },
  factory_runs: {
    input: operationalRunListInputSchema,
    output: operationalRunListProjectionSchema,
  },
  factory_run_detail: {
    input: operationalRunDetailInputSchema,
    output: operationalRunDetailProjectionSchema,
  },
  factory_update_settings: {
    input: updateSettingsInputSchema,
    output: settingsMutationResultSchema,
  },
  factory_update_repository: {
    input: updateRepositoryInputSchema,
    output: settingsMutationResultSchema,
  },
  factory_add_repository: {
    input: addRepositoryInputSchema,
    output: settingsMutationResultSchema,
  },
  factory_registry_options: {
    input: z.object({}).strict(),
    output: registryOptionsProjectionSchema,
  },
  factory_pick_folder: {
    input: pickFolderInputSchema,
    output: pickFolderResultSchema,
  },
  factory_probe_repository: {
    input: probeRepositoryInputSchema,
    output: repositoryProbeSchema,
  },
  factory_resolve_project: {
    input: resolveProjectInputSchema,
    output: resolveProjectResultSchema,
  },
});

export type FactoryRpcContract = typeof factoryRpcContract;
