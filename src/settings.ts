import { z } from "zod";
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { repositoryRegistrySchema } from "./contracts.js";

const repositoryKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const absolutePath = z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/);

export const repositoryRegistrySettingSchema = z.string().superRefine((value, context) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be valid repository registry JSON" });
    return;
  }
  const result = repositoryRegistrySchema.safeParse(parsed);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      message: `invalid repository registry: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
    });
  }
});

export const factorySettingDescriptors = {
  repositoryKey: {
    type: "string",
    label: "Repository key",
    description: "Stable key used for factory state and reporting.",
    experimental_schema: repositoryKey,
  },
  repositoryRoot: {
    type: "string",
    label: "Repository root",
    description: "Containing project root. The plugin never writes outside the configured checkout.",
    experimental_schema: absolutePath,
  },
  connectedHostId: {
    type: "string",
    label: "Connected host",
    description: "BB host that owns the checkout and any host-local prerequisites.",
  },
  checkoutPath: {
    type: "string",
    label: "Checkout path",
    description: "Factory worktree path on the connected host.",
    experimental_schema: absolutePath,
  },
  projectId: {
    type: "string",
    label: "BB project",
    description: "Required BB project scope for this repository's threads and interactions.",
  },
  environmentId: {
    type: "string",
    label: "BB environment",
    description:
      "Advanced: pin a pre-existing BB environment for this repository's threads and interactions. Leave unset and bb registers an unmanaged environment for the checkout path on first dispatch.",
  },
  repositoryRegistry: {
    type: "string",
    label: "Repository registry",
    description: "Validated JSON registry of configured repositories. Use an empty registry to keep the factory disabled.",
    experimental_multiline: true,
    experimental_schema: repositoryRegistrySettingSchema,
  },
  scheduleCron: {
    type: "string",
    label: "Schedule",
    description: "Five-field server-local cron expression. Phase 0 does not register it.",
  },
  timeZone: {
    type: "string",
    label: "Schedule time zone",
    description: "Use server-local to preserve the current BB schedule behavior.",
    default: "server-local",
  },
  nightWindowEndHour: {
    type: "number",
    label: "Night window end hour",
    description: "Local hour at which new work stops.",
    default: 6,
    experimental_schema: z.number().int().min(0).max(23),
  },
  runtimeCapSeconds: {
    type: "number",
    label: "Runtime cap (seconds)",
    description: "Maximum runtime before a run is stopped safely.",
    default: 10_800,
    experimental_schema: z.number().int().positive(),
  },
  providerPreference: {
    type: "select",
    label: "Provider preference",
    description: "Use the current alternate behavior or pin the lead provider.",
    options: ["alternate", "codex", "claude-code"],
  },
  minimumStartGapSeconds: {
    type: "number",
    label: "Minimum start gap (seconds)",
    description: "Rolling safety gap between foreman starts.",
    default: 3600,
    experimental_schema: z.number().int().min(3600),
  },
  concurrencyLimit: {
    type: "number",
    label: "Concurrency limit",
    description: "Maximum active foreman runs for this plugin instance.",
    default: 1,
    experimental_schema: z.number().int().positive(),
  },
  dispatchMode: {
    type: "select",
    label: "Dispatch mode",
    description: "Phase 0 defaults to paused and does not start a scheduler or worker.",
    options: ["enabled", "paused"],
    default: "paused",
  },
} satisfies PluginSettingDescriptors;
