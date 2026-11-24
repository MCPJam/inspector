/**
 * Reading a round with a bounded wait. The round settles itself in the backend
 * when its runs end, so this only polls `getClimbRound`: it holds the call for
 * at most the bound the caller asked for, so a surface that ends a call that
 * sits too long never has to, and says whether the round settled.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformClimbRound, PlatformClimbRoundRead } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";

export const ROUND_POLL_MS = 2_000;

export async function readRound(
  convex: Pick<ConvexHttpClient, "query">,
  scope: { climbId: string; suiteId: string },
  roundNumber: number,
  waitSeconds: number,
  clock: { now(): number; sleep(ms: number): Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<PlatformClimbRoundRead> {
  const started = clock.now();
  for (;;) {
    const round: PlatformClimbRound = await convex.query(climbFns.getRound, { climbId: scope.climbId, roundNumber });
    const waitedMs = clock.now() - started;
    const settled = round.status !== "running";
    if (settled || waitedMs + ROUND_POLL_MS > waitSeconds * 1000) {
      return { ...round, climbId: scope.climbId, suiteId: scope.suiteId, waitedMs, settled };
    }
    await clock.sleep(ROUND_POLL_MS);
  }
}
