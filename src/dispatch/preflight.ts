import type { HostPreflight, ProviderStatus, RepositoryKey } from "../contracts.js";
import { errorMessage } from "../errors.js";
import type { DispatcherState } from "../storage/index.js";
import type { DispatchContext } from "./types.js";
import { FACTORY_PROVIDERS, otherProvider, type FactoryProviderId } from "./types.js";

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
  readonly providerId: FactoryProviderId;
  readonly model: string;
  readonly reasoningLevel: ProviderStatus["reasoningLevel"];
  readonly reason: string;
}

/**
 * Provider policy ported from the shell dispatcher: `providerPreference` pins
 * the lead; `alternate` takes the other provider from the night's previous
 * start, or the night-parity lead on the first start. A provider is usable
 * when the live catalog reports it available and no durable limit mark is
 * still in force. A limited lead falls back to the other provider; both
 * limited means no dispatch.
 */
export function selectProvider(
  providers: readonly ProviderStatus[],
  state: DispatcherState,
  preference: "alternate" | "codex" | "claude-code" | undefined,
  nightKey: string,
  nowS: number,
): ProviderSelection | null {
  const usable = new Map<FactoryProviderId, ProviderStatus>();
  for (const providerId of FACTORY_PROVIDERS) {
    const status = providers.find((candidate) => candidate.providerId === providerId);
    if (!status || status.availability !== "available" || status.model === "unavailable") continue;
    const limitedUntil = state.limits[providerId] ?? 0;
    if (limitedUntil > nowS) continue;
    usable.set(providerId, status);
  }
  if (usable.size === 0) return null;

  const lastStart = state.lastStartProvider;
  let lead: FactoryProviderId;
  let reason: string;
  if (preference === "codex" || preference === "claude-code") {
    lead = preference;
    reason = `providerPreference=${preference}`;
  } else if (lastStart === "codex" || lastStart === "claude-code") {
    lead = otherProvider(lastStart);
    reason = `alternate after ${lastStart}`;
  } else {
    const nightDay = Number(nightKey.slice(-2));
    lead = nightDay % 2 === 0 ? "codex" : "claude-code";
    reason = `alternate lead, night ${nightKey}`;
  }

  const fallback = otherProvider(lead);
  const picked = usable.get(lead) ?? usable.get(fallback);
  if (!picked) return null;
  return {
    providerId: picked.providerId as FactoryProviderId,
    model: picked.model,
    reasoningLevel: picked.reasoningLevel,
    reason: picked.providerId === lead ? reason : `fallback, ${lead} limited`,
  };
}
