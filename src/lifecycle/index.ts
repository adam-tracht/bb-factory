import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RepositoryKey } from "../contracts.js";
import { reconcileAll } from "../dispatch/recovery.js";
import type { DispatchContext } from "../dispatch/types.js";

const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Startup reconciliation runs before this service returns, so the scheduler
 * registered after it cannot dispatch against stale ownership or run state.
 * The periodic pass then keeps run/lease state converging with live threads.
 */
export function registerFactoryLifecycle(
  bb: Pick<BbPluginApi, "background" | "log">,
  context: () => DispatchContext | null,
  repositoryKeys: () => readonly RepositoryKey[],
): void {
  bb.background.service("factory-lifecycle", {
    async start(signal) {
      const reconcile = async () => {
        const ctx = context();
        if (!ctx) return;
        await reconcileAll(ctx, repositoryKeys());
      };
      try {
        await reconcile();
      } catch (error) {
        bb.log.error(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const timer = setInterval(() => {
        void reconcile().catch((error) => {
          bb.log.error(`periodic reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, RECONCILE_INTERVAL_MS);
      signal.addEventListener("abort", () => clearInterval(timer));
    },
  });
}
