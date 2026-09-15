import type { ProviderStatus } from "./contracts.js";

/**
 * Full permission is assumed when the host does not report permission modes.
 * Shared by the dispatch usability gate and the settings UI labels.
 */
export function hasFullPermission(provider: ProviderStatus): boolean {
  return provider.permissionModes === undefined || provider.permissionModes.includes("full");
}
