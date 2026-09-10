import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  DispatcherState,
  OperationalStateStore,
} from "../storage/index.js";
import type {
  FactorySettings,
  RepositoryKey,
  RepositoryRegistryEntry,
} from "../contracts.js";
import type { FactoryHealthReader, ProtocolReader } from "../ports.js";

export type DispatchSdk = Pick<BbPluginApi["sdk"], "threads" | "files">;

export interface DispatchContext {
  readonly sdk: DispatchSdk;
  readonly store: OperationalStateStore;
  readonly protocolReader: ProtocolReader;
  readonly healthReader: FactoryHealthReader;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
  readonly settings: FactorySettings;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
}

export const FACTORY_PROVIDERS = ["codex", "claude-code"] as const;
export type FactoryProviderId = (typeof FACTORY_PROVIDERS)[number];

/** The shell dispatcher marks a provider limited for six hours after a dead start or a long provider retry. */
export const PROVIDER_LIMIT_SECONDS = 6 * 3600;
/** A run left in `pending` past this grace period needs reconciliation: its worker spawn never landed. */
export const PENDING_RUN_GRACE_MS = 10 * 60 * 1000;
/** Retry budget per run: the initial attempt plus this many retries. */
export const MAX_RUN_ATTEMPTS = 3;

export function dispatcherNowSeconds(now: () => Date): number {
  return Math.floor(now().getTime() / 1000);
}

export function otherProvider(provider: FactoryProviderId): FactoryProviderId {
  return provider === "codex" ? "claude-code" : "codex";
}

export function nightKeyAt(date: Date, windowEndHour: number): string {
  const shifted = new Date(date.getTime() - windowEndHour * 3600 * 1000);
  const year = shifted.getFullYear();
  const month = `${shifted.getMonth() + 1}`.padStart(2, "0");
  const day = `${shifted.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nightState(state: DispatcherState, nightKey: string): DispatcherState {
  if (state.nightKey === nightKey) return state;
  return { ...state, nightKey, lastState: "", failedCount: 0, noopCount: 0, lastStartProvider: "" };
}
