/**
 * What one run group costs, from the estimate the app's own "Run all" shows.
 * It is a quote, not an upper bound: runs can cost more, and a run MCPJam
 * could not price is left out (the backend says so with `credits: null`).
 */
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformClimbEstimate } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";

type RunCostEstimate = { credits: number | null; lowerBoundCredits: number };

/** One group of `caseIds` in each of `environmentIds`, rounded up to a whole credit. */
export async function estimateGroup(
  convex: Pick<ConvexHttpClient, "query">,
  args: { suiteId: string; environmentIds: string[]; caseIds?: string[] },
  groups: number,
  /** The share of the suite's cases the group runs, for an estimate made before the cases are named. */
  share = 1,
): Promise<PlatformClimbEstimate> {
  const quote: RunCostEstimate = await convex.query(climbFns.estimate, {
    suiteId: args.suiteId,
    environmentIds: args.environmentIds,
    ...(args.caseIds && args.caseIds.length > 0 ? { caseIds: args.caseIds } : {}),
  });
  const credits = quote.credits ?? quote.lowerBoundCredits;
  return {
    creditsPerGroup: Math.ceil(credits * share),
    groups,
    lowerBound: quote.credits === null,
    note: "A quote from past runs, not an upper bound. The climb's credit limit is checked against it.",
  };
}
