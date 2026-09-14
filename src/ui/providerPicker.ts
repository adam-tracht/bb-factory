import { experimental_ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { ComponentProps, ComponentType } from "react";
import type { ProviderStatus } from "../contracts.js";

export type PickerValue = ComponentProps<NonNullable<typeof experimental_ProviderModelPicker>>["value"];
export type PickerRouting = ComponentProps<NonNullable<typeof experimental_ProviderModelPicker>>["routing"];

// The host only binds the picker on runtimes new enough to ship it.
export const ProviderModelPicker = experimental_ProviderModelPicker as ComponentType<{
  value: PickerValue;
  onChange(value: PickerValue): void;
  routing?: PickerRouting;
  disabled?: boolean;
}> | undefined;

/** Seed the picker from live health: the configured preference, then the first available provider. */
export function seedPickerValue(
  providers: readonly ProviderStatus[],
  preferredProviderId: string | null,
): PickerValue | null {
  const usable = providers.filter(
    (provider) => provider.model !== "unavailable" && provider.availability !== "unavailable",
  );
  const pick = (preferredProviderId === null ? undefined : usable.find((provider) => provider.providerId === preferredProviderId))
    ?? usable.find((provider) => provider.availability === "available")
    ?? usable[0]
    ?? null;
  return pick === null
    ? null
    : { providerId: pick.providerId, model: pick.model, reasoningLevel: pick.reasoningLevel };
}
