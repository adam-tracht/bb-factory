import type { FactoryActionResult, RepositoryKey } from "../contracts.js";
import { stopRun } from "./cancel.js";
import { reconcileRepository } from "./lifecycle.js";
import { reconcileAll } from "./recovery.js";
import { retryAttempt, type RetryAttemptInput } from "./retry.js";
import { startRun, type StartRunInput } from "./start.js";
import type { DispatchContext } from "./types.js";

export interface DispatchEngine {
  requestRun(input: StartRunInput): Promise<FactoryActionResult>;
  requestStop(repositoryKey: RepositoryKey): Promise<FactoryActionResult>;
  requestRetry(input: RetryAttemptInput): Promise<FactoryActionResult>;
  reconcile(repositoryKey?: RepositoryKey): Promise<void>;
}

export function createDispatchEngine(
  context: DispatchContext,
  repositoryKeys: () => readonly RepositoryKey[],
): DispatchEngine {
  return {
    async requestRun(input) {
      try {
        await reconcileRepository(context, input.repositoryKey);
      } catch (error) {
        context.log?.(`pre-dispatch reconciliation for '${input.repositoryKey}' failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return (await startRun(context, input)).result;
    },
    async requestStop(repositoryKey) {
      return stopRun(context, { repositoryKey });
    },
    async requestRetry(input) {
      return retryAttempt(context, input);
    },
    async reconcile(repositoryKey) {
      if (repositoryKey !== undefined) {
        await reconcileRepository(context, repositoryKey);
        return;
      }
      await reconcileAll(context, repositoryKeys());
    },
  };
}
