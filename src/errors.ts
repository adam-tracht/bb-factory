/** The canonical unknown-error-to-message helper. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
