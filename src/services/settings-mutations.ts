import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  factorySettingsSchema,
  repositoryDisplayNameSchema,
  repositoryRegistryEntrySchema,
  repositoryRegistrySchema,
  type AddRepositoryInput,
  type FactorySettings,
  type FactorySettingsPatch,
  type SettingsMutationResult,
  type UpdateRepositoryInput,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import { repositoryLabel } from "../repository-label.js";
import type { ReadComposition } from "./read-composition.js";

type BbSdk = BbPluginApi["sdk"];
type SettingValue = string | number | boolean;

export interface SettingsMutationHandlers {
  factory_update_settings(input: { repositoryKey: string; patch: FactorySettingsPatch }): Promise<SettingsMutationResult>;
  factory_update_repository(input: UpdateRepositoryInput): Promise<SettingsMutationResult>;
  factory_add_repository(input: AddRepositoryInput): Promise<SettingsMutationResult>;
}

export interface SettingsMutationOptions {
  readonly getSettings: () => FactorySettings;
  readonly getComposition: () => ReadComposition;
  readonly applySettings: (values: Record<string, SettingValue | null>) => Promise<void>;
  readonly sdk: BbSdk;
}

function failure(category: "invalid-input" | "not-found" | "conflict" | "internal", message: string, fieldErrors?: Record<string, string[]>): SettingsMutationResult {
  return { ok: false, error: { category, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

function invalidSettings(error: unknown): SettingsMutationResult {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }).issues;
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of issues) {
      const field = issue.path.map(String).join(".") || "settings";
      fieldErrors[field] = [...(fieldErrors[field] ?? []), issue.message];
    }
    return failure("invalid-input", `The updated settings are invalid: ${issues[0]?.message ?? "schema mismatch"}`, fieldErrors);
  }
  return failure("invalid-input", `The updated settings are invalid: ${errorMessage(error)}`);
}

function readRegistry(settings: FactorySettings) {
  const parsed = repositoryRegistrySchema.safeParse(
    settings.repositoryRegistry ?? { repositories: [], defaultRepositoryKey: null },
  );
  return parsed.success ? parsed.data : null;
}

export function createSettingsMutationHandlers(options: SettingsMutationOptions): SettingsMutationHandlers {
  const { getSettings, getComposition, applySettings, sdk } = options;

  const writeRegistry = async (registry: { repositories: unknown[]; defaultRepositoryKey: string | null }, message: string): Promise<SettingsMutationResult> => {
    const validated = repositoryRegistrySchema.safeParse(registry);
    if (!validated.success) {
      return invalidSettings(validated.error);
    }
    try {
      await applySettings({ repositoryRegistry: JSON.stringify(validated.data) });
    } catch (error) {
      return failure("internal", `Could not persist the repository registry: ${errorMessage(error)}`);
    }
    return { ok: true, message };
  };

  return {
    async factory_update_settings(input) {
      const current = getSettings();
      const merged = { ...current };
      for (const [key, value] of Object.entries(input.patch)) {
        if (value === undefined) continue;
        if (value === null) {
          delete (merged as Record<string, unknown>)[key];
        } else {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
      const validated = factorySettingsSchema.safeParse(merged);
      if (!validated.success) {
        return invalidSettings(validated.error);
      }
      try {
        await applySettings(input.patch as Record<string, SettingValue | null>);
      } catch (error) {
        return failure("internal", `Could not persist the settings: ${errorMessage(error)}`);
      }
      return { ok: true, message: "Settings saved. The change applies on the next dispatch cycle; a run in progress is not affected." };
    },

    async factory_update_repository(input) {
      if (input.dispatchPaused === undefined && input.displayName === undefined) {
        return failure("invalid-input", "At least one repository setting is required.");
      }
      let displayNameInput: string | null | undefined;
      if (input.displayName === undefined || input.displayName === null) {
        displayNameInput = input.displayName;
      } else {
        const parsedDisplayName = repositoryDisplayNameSchema.safeParse(input.displayName);
        if (!parsedDisplayName.success) return invalidSettings(parsedDisplayName.error);
        displayNameInput = parsedDisplayName.data;
      }
      const registry = readRegistry(getSettings());
      const currentEntry = getComposition().getRepositoryEntry(input.repositoryKey);
      if (!registry || !currentEntry) {
        return failure("not-found", `Repository '${input.repositoryKey}' is not configured.`);
      }
      const repositories = registry.repositories.map((entry) => {
        if (entry.configuration.repositoryKey !== input.repositoryKey) return entry;
        const updated = { ...entry };
        if (input.dispatchPaused !== undefined) updated.dispatchPaused = input.dispatchPaused;
        if (displayNameInput !== undefined) {
          if (displayNameInput === null) delete updated.displayName;
          else updated.displayName = displayNameInput;
        }
        return updated;
      });
      const displayName = displayNameInput === undefined
        ? currentEntry.displayName
        : displayNameInput ?? undefined;
      const label = repositoryLabel(input.repositoryKey, displayName);
      const message = input.dispatchPaused === undefined
        ? displayNameInput === null
          ? `Display name cleared for '${label}'.`
          : `Display name saved as '${label}'.`
        : input.dispatchPaused
          ? `Dispatch paused for '${label}'. Scheduled and manual starts are blocked; running runs continue.`
          : `Dispatch resumed for '${label}'.`;
      return writeRegistry(
        { repositories, defaultRepositoryKey: registry.defaultRepositoryKey },
        message,
      );
    },

    async factory_add_repository(input) {
      const configuration = {
        ...input.configuration,
        factoryBranch: "factory" as const,
      };
      const entry = repositoryRegistryEntrySchema.safeParse({
        configuration,
        projectId: input.projectId,
        environmentId: input.environmentId,
        dispatchPaused: input.dispatchPaused,
        displayName: input.displayName,
      });
      if (!entry.success) {
        return invalidSettings(entry.error);
      }
      const current = getSettings();
      const registry = readRegistry(current) ?? { repositories: [], defaultRepositoryKey: null };
      const key = entry.data.configuration.repositoryKey;
      if (registry.repositories.some((existing) => existing.configuration.repositoryKey === key)) {
        return failure("conflict", `Repository '${key}' is already configured.`);
      }
      const repositories = [...registry.repositories, entry.data];
      const defaultRepositoryKey = registry.defaultRepositoryKey ?? key;

      let protocolNote = " No plans/factory/ protocol files were found in the checkout; scaffold them before the first run.";
      try {
        await sdk.files.read({
          hostId: entry.data.configuration.connectedHostId,
          path: `${entry.data.configuration.checkoutPath.replace(/[\\/]+$/u, "")}/plans/factory/queue.md`,
        });
        protocolNote = " Protocol files detected in the checkout.";
      } catch {
        // The probe is advisory; the registry write still proceeds.
      }
      return writeRegistry(
        { repositories, defaultRepositoryKey },
        `Repository '${repositoryLabel(key, entry.data.displayName)}' added${input.dispatchPaused ? " with dispatch paused" : ""}.${protocolNote}`,
      );
    },
  };
}
