/**
 * Resolves the label shown to people while keeping repositoryKey available
 * for all operational identity and action paths.
 */
export function repositoryLabel(repositoryKey: string, displayName?: string): string {
  return displayName ?? repositoryKey;
}
