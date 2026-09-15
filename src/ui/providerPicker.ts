import { experimental_ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { ComponentProps, ComponentType } from "react";
import type { ProviderStatus } from "../contracts.js";
import type { ViewContext } from "./context.js";

type PickerProps = ComponentProps<NonNullable<typeof experimental_ProviderModelPicker>>;
export type PickerValue = PickerProps["value"];
export type PickerRouting = NonNullable<PickerProps["routing"]>;

// The host only binds the picker on runtimes new enough to ship it; the SDK
// declares the component non-nullable, so the cast adds the unbound case.
export const ProviderModelPicker = experimental_ProviderModelPicker as ComponentType<PickerProps> | undefined;

/** True when the running host bound the shared picker. */
export const providerModelPickerBound = ProviderModelPicker !== undefined;

/** Resolve catalog routing through the view's environment when it has one, else its host. */
export function pickerRoutingFor(ctx: Pick<ViewContext, "environmentId" | "repository">): PickerRouting {
  return ctx.environmentId
    ? { kind: "environment", environmentId: ctx.environmentId }
    : { kind: "host", hostId: ctx.repository.connectedHostId };
}

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
