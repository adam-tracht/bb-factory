import type { RepositoryKey } from "../contracts.js";
import { errorMessage } from "../errors.js";
import { reconcileRepository } from "./lifecycle.js";
import type { DispatchContext } from "./types.js";

/**
 * Startup reconciliation: observe every configured repository's active runs
 * and leases against live thread state before any new dispatch is allowed.
 * Safe to call repeatedly.
 */
export async function reconcileAll(ctx: DispatchContext, repositoryKeys: readonly RepositoryKey[]): Promise<void> {
  for (const repositoryKey of repositoryKeys) {
    try {
      await reconcileRepository(ctx, repositoryKey);
    } catch (error) {
      ctx.log?.(`reconciliation for '${repositoryKey}' failed: ${errorMessage(error)}`);
    }
  }
}
