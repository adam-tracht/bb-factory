import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  factoryActionRequestSchema,
  factoryActionResultSchema,
  healthProjectionSchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  protocolSnapshotSchema,
  repositoryKeySchema,
  repositorySelectionInputSchema,
  repositorySelectionProjectionSchema,
  repositoryReadInputSchema,
  settingsProjectionSchema,
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
});

export type FactoryRpcContract = typeof factoryRpcContract;
