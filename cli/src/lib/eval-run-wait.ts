/**
 * How long `--wait` waits for an eval run.
 *
 * The DEFAULT budget is an idle budget: it runs out only after a whole window
 * passes with no newly finished trial. A hosted run may wait for shared
 * execution capacity and then work through its trials a few at a time, so a
 * wall-clock budget would cut off a run that is still making progress. An
 * explicit `--wait-timeout` stays strict wall-clock time: a caller who named a
 * budget meant it.
 *
 * Progress is counted only when a window runs out, so a long run costs one
 * iteration walk per window, not one per poll. A walk that fails counts as no
 * progress, which is exactly the old wall-clock behavior.
 */
import type { PlatformApiClient } from "@mcpjam/sdk/platform";
import { fetchAllIterations } from "./eval-iterations.js";

/** Never wait longer than the platform's longest run budget. */
export const RUN_WAIT_CEILING_MS = 12 * 60 * 60_000;

export type RunWaitBudget = { ms: number; strict: boolean };

export type RunWaitClock = {
  /** True once the budget is spent. May read the run's trials to decide. */
  expired(): Promise<boolean>;
  /** Push the deadline to at least `ms` from now. */
  extend(ms: number): void;
};

/** The command's outer budget, which must outlast every inner deadline. */
export function outerRunWaitMs(
  budget: RunWaitBudget,
  gradingExtensionMs: number
): number {
  return (budget.strict ? budget.ms : RUN_WAIT_CEILING_MS) + gradingExtensionMs;
}

async function finishedTrials(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal,
  projectId: string,
  runId: string
): Promise<number | null> {
  try {
    const { items } = await fetchAllIterations(
      client,
      signal,
      projectId,
      runId
    );
    return items.filter(
      (iteration) =>
        iteration.status !== "pending" && iteration.status !== "running"
    ).length;
  } catch {
    if (signal.aborted) throw signal.reason;
    return null;
  }
}

export async function startRunWaitClock(args: {
  client: Pick<PlatformApiClient, "listEvalRunIterations">;
  signal: AbortSignal;
  projectId: string;
  runId: string;
  budget: RunWaitBudget;
}): Promise<RunWaitClock> {
  const startedAt = Date.now();
  let deadline = startedAt + args.budget.ms;
  const count = () =>
    finishedTrials(args.client, args.signal, args.projectId, args.runId);
  let finished = args.budget.strict ? null : await count();
  return {
    extend(ms) {
      deadline = Math.max(deadline, Date.now() + ms);
    },
    async expired() {
      if (Date.now() < deadline) return false;
      if (args.budget.strict) return true;
      if (Date.now() - startedAt >= RUN_WAIT_CEILING_MS) return true;
      const now = await count();
      if (now === null || finished === null || now <= finished) return true;
      // Trials finished during this window: the run is moving, so it earns a
      // new window from here.
      finished = now;
      deadline = Date.now() + args.budget.ms;
      return false;
    },
  };
}
