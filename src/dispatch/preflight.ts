import type { HostPreflight, ProviderId, ProviderStatus, ProviderPreference, RepositoryKey } from "../contracts.js";
import { errorMessage } from "../errors.js";
import type { DispatcherState } from "../storage/index.js";
import type { DispatchContext } from "./types.js";

export type HostPreflightResult = HostPreflight | { ok: false; reasons: string[]; hostId: string };

export async function hostPreflight(ctx: DispatchContext, repositoryKey: RepositoryKey): Promise<HostPreflightResult> {
  try {
    return await ctx.healthReader.getHostPreflight(repositoryKey);
  } catch (error) {
    return {
      ok: false,
      hostId: "unknown",
      reasons: [`Could not read host preflight: ${errorMessage(error)}`],
    };
  }
}

export interface ProviderSelection {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly reasoningLevel: ProviderStatus["reasoningLevel"];
  readonly reason: string;
}

/**
 * A provider is usable when the live catalog reports it available, has a
 * configured model, is not durably limited, and supports full permissions
 * when the host reports permission modes.
 */
export function providerUsable(provider: ProviderStatus, state: DispatcherState, nowS: number): boolean {
  const limitedUntil = state.limits[provider.providerId] ?? 0;
  return provider.availability === "available"
    && provider.model !== "unavailable"
    && limitedUntil <= nowS
    && (provider.permissionModes === undefined || provider.permissionModes.includes("full"));
}

export function selectProvider(
  providers: readonly ProviderStatus[],
  state: DispatcherState,
  preference: ProviderPreference | undefined,
  nightKey: string,
  nowS: number,
): ProviderSelection | null {
  const usable = providers.filter((provider) => providerUsable(provider, state, nowS));
  if (usable.length === 0) return null;

  const selection = (picked: ProviderStatus, reason: string): ProviderSelection => ({
    providerId: picked.providerId,
    model: picked.model,
    reasoningLevel: picked.reasoningLevel,
    reason,
  });

  if (preference !== undefined && preference !== "alternate") {
    const picked = usable.find((provider) => provider.providerId === preference) ?? usable[0]!;
    return selection(picked, picked.providerId === preference
      ? `providerPreference=${preference}`
      : `fallback, ${preference} unusable`);
  }

  const lastStart = state.lastStartProvider;
  const lastIndex = providers.findIndex((provider) => provider.providerId === lastStart);
  if (lastIndex >= 0) {
    for (let offset = 1; offset <= providers.length; offset += 1) {
      const picked = providers[(lastIndex + offset) % providers.length]!;
      if (providerUsable(picked, state, nowS)) return selection(picked, `alternate after ${lastStart}`);
    }
  }

  const nightDay = Number(nightKey.slice(-2));
  return selection(usable[nightDay % usable.length]!, `alternate lead, night ${nightKey}`);
}

/**
 * A manual run-now may pin the execution triple explicitly. The pick faces
 * the same usability gate as rotation, but a rejected provider errors out
 * instead of silently substituting another.
 */
export function selectExplicitProvider(
  providers: readonly ProviderStatus[],
  state: DispatcherState,
  override: { providerId: ProviderId; model: string; reasoningLevel: ProviderStatus["reasoningLevel"] },
  nowS: number,
): ProviderSelection | null {
  const picked = providers.find((provider) => provider.providerId === override.providerId);
  if (picked === undefined || !providerUsable(picked, state, nowS)) return null;
  return { providerId: picked.providerId, model: override.model, reasoningLevel: override.reasoningLevel, reason: "manual selection" };
}
