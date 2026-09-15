import { z } from "zod";
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { providerModelDefaultsSchema, providerPreferenceSchema, providerRotationSchema, repositoryRegistrySchema } from "./contracts.js";

const repositoryKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const absolutePath = z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/);

/** String setting holding JSON validated by an inner schema, for descriptor checks. */
function jsonSettingSchema(inner: z.ZodTypeAny, label: string) {
  return z.string().superRefine((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: "custom", message: `must be valid ${label} JSON` });
      return;
    }
    const result = inner.safeParse(parsed);
    if (!result.success) {
      context.addIssue({
        code: "custom",
        message: `invalid ${label}: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
      });
    }
  });
}

export const repositoryRegistrySettingSchema = jsonSettingSchema(repositoryRegistrySchema, "repository registry");
export const providerModelDefaultsSettingSchema = jsonSettingSchema(providerModelDefaultsSchema, "provider model defaults");
export const providerRotationSettingSchema = jsonSettingSchema(providerRotationSchema, "provider rotation");

export const factorySettingDescriptors = {
  repositoryKey: {
    type: "string",
    label: "Repository key (legacy)",
    description:
      "Stable key used for factory state and reporting. Legacy single-repository setting kept for existing installs; new setups should use Add repository instead.",
    experimental_schema: repositoryKey,
  },
  repositoryRoot: {
    type: "string",
    label: "Repository root (legacy)",
    description:
      "Containing project root. The plugin never writes outside the configured checkout. Legacy single-repository setting; new setups should use Add repository instead.",
    experimental_schema: absolutePath,
  },
  connectedHostId: {
    type: "string",
    label: "Connected host (legacy)",
    description:
      "BB host that owns the checkout and any host-local prerequisites. Legacy single-repository setting; new setups should use Add repository instead.",
  },
  checkoutPath: {
    type: "string",
    label: "Checkout path (legacy)",
    description:
      "Factory worktree path on the connected host. Legacy single-repository setting; new setups should use Add repository instead.",
    experimental_schema: absolutePath,
  },
  projectId: {
    type: "string",
    label: "BB project (legacy)",
    description:
      "Required BB project scope for this repository's threads and interactions. Legacy single-repository setting; new setups should use Add repository instead.",
  },
  environmentId: {
    type: "string",
    label: "BB environment (legacy)",
    description:
      "Advanced legacy setting: pin a pre-existing BB environment for this repository's threads and interactions. Leave unset and bb registers an unmanaged environment for the checkout path on first dispatch. New setups should use Add repository instead.",
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
    type: "string",
    label: "Provider preference",
    description: "Provider id to lead dispatch (any id the host reports), or alternate to rotate.",
    experimental_schema: providerPreferenceSchema,
  },
  providerModelDefaults: {
    type: "string",
    label: "Provider model defaults",
    description:
      "Validated JSON map of provider id to the model and thinking level dispatch uses instead of the host-reported default. The Factory Settings tab edits this per provider.",
    experimental_multiline: true,
    experimental_schema: providerModelDefaultsSettingSchema,
  },
  providerRotation: {
    type: "string",
    label: "Provider rotation",
    description:
      "Validated JSON list of 2 to 5 provider ids the alternate preference rotates through in order. The Factory Settings tab edits this list.",
    experimental_multiline: true,
    experimental_schema: providerRotationSettingSchema,
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
