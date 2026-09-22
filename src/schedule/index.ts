import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RepositoryKey } from "../contracts.js";
import { errorMessage } from "../errors.js";
import { reconcileRepository } from "../dispatch/lifecycle.js";
import { startRun } from "../dispatch/start.js";
import {
  dispatcherNowSeconds,
  dispatchRunOccupiesSlot,
  nightKeyAt,
  nightState,
  type DispatchContext,
} from "../dispatch/types.js";
import { cronMatches, localClock } from "./cron.js";

export { cronMatches, describeCron, nextCronTimes } from "./cron.js";
export { describeSchedule } from "./describe.js";

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const body = hex.slice(0, 32).split("");
  body[12] = "5";
  body[16] = "89ab"[parseInt(hex[16], 16) % 4];
  return `${body.slice(0, 8).join("")}-${body.slice(8, 12).join("")}-${body.slice(12, 16).join("")}-${body.slice(16, 20).join("")}-${body.slice(20, 32).join("")}`;
}

export interface SchedulerTickResult {
  readonly repositoryKey: RepositoryKey;
  readonly action: "started" | "skipped";
  readonly reason: string;
}

/**
 * One scheduler pass over a repository: reconcile durable state first, then
 * apply the shell dispatcher's decision order exactly — night window, night
 * rollover, night-stop conditions, rolling spacing guard, concurrency —
 * before starting one run under a deterministic per-minute idempotency key.
 */
export async function schedulerTick(
  ctx: DispatchContext,
  repositoryKey: RepositoryKey,
  allRepositoryKeys: readonly RepositoryKey[],
): Promise<SchedulerTickResult> {
  const settings = ctx.settings;
  const skip = (reason: string): SchedulerTickResult => ({ repositoryKey, action: "skipped", reason });

  if (settings.dispatchMode !== "enabled") return skip("dispatch is paused");
  if (ctx.repositoryLookup(repositoryKey)?.dispatchPaused === true) {
    return skip("dispatch is paused for this repository");
  }
  if (!settings.scheduleCron) return skip("no schedule configured");
  const now = ctx.now();
  if (!cronMatches(settings.scheduleCron, now, settings.timeZone)) return skip("outside the configured schedule");
  const clock = localClock(now, settings.timeZone);
  if (clock.hour >= settings.nightWindowEndHour) return skip(`outside the night window (hour ${clock.hour} >= ${settings.nightWindowEndHour})`);

  const nightKey = nightKeyAt(now, settings.nightWindowEndHour);
  const previous = ctx.store.getDispatcherState(repositoryKey);
  let state = nightState(previous, nightKey);
  if (state.nightKey !== previous.nightKey) {
    ctx.store.saveDispatcherState(state);
  }

  await reconcileRepository(ctx, repositoryKey);
  state = ctx.store.getDispatcherState(repositoryKey);

  if (state.lastState === "blocked") return skip("night stopped after a blocked run");
  if (state.noopCount >= 2) return skip("night stopped after two no-op runs");
  if (state.failedCount >= 2) return skip("night stopped after two failed-safe runs");

  const nowS = dispatcherNowSeconds(ctx.now);
  if (nowS - state.lastStartAt < settings.minimumStartGapSeconds) return skip("inside the minimum start gap");

  const nowMs = now.getTime();
  if (ctx.tasksIntegration === "enabled") {
    const activeForRepository = ctx.store.listActiveRuns(repositoryKey)
      .filter((run) => dispatchRunOccupiesSlot(run, nowMs)).length;
    if (activeForRepository >= settings.concurrencyLimit) return skip("the concurrency limit is reached");
  } else {
    const activeAcross = allRepositoryKeys.reduce(
      (count, key) => count + ctx.store.listActiveRuns(key).filter((run) => dispatchRunOccupiesSlot(run, nowMs)).length,
      0,
    );
    if (activeAcross >= settings.concurrencyLimit) return skip("the concurrency limit is reached");
  }

  const slotIso = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
  const idempotencyKey = `bbf:v1:${repositoryKey}:run-now:${deterministicUuid(`${repositoryKey}|${slotIso}`)}`;
  const started = await startRun(ctx, {
    repositoryKey,
    trigger: "schedule",
    idempotencyKey,
  });
  if (started.result.ok) return { repositoryKey, action: "started", reason: started.result.result.message };
  return skip(started.result.error.message);
}

export function createScheduler(
  context: DispatchContext,
  repositoryKeys: () => readonly RepositoryKey[],
): { tick(): Promise<SchedulerTickResult[]> } {
  return {
    async tick() {
      const keys = repositoryKeys();
      const results: SchedulerTickResult[] = [];
      for (const repositoryKey of keys) {
        try {
          results.push(await schedulerTick(context, repositoryKey, keys));
        } catch (error) {
          results.push({
            repositoryKey,
            action: "skipped",
            reason: `tick failed: ${errorMessage(error)}`,
          });
        }
      }
      return results;
    },
  };
}

/**
 * Register the durable per-minute sweep. Due rows are claimed by the host
 * with a CAS on next_run_at while this plugin is loaded, so a missed night
 * fires late on load; the internal cron gate and the rolling spacing guard
 * make every wakeup safe to replay.
 */
export function registerFactorySchedule(
  bb: Pick<BbPluginApi, "background">,
  tick: () => void | Promise<void>,
): void {
  bb.background.schedule("factory-dispatch", "* * * * *", tick);
}
