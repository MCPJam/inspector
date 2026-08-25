/**
 * Paginated iteration fetch, shared by `mcpjam cloud eval gate` and
 * `mcpjam cloud eval compare`.
 *
 * Extracted VERBATIM from `commands/eval.ts` — same bound, same
 * `complete` semantics — because both commands need the same "did we see the
 * whole run?" answer, and two copies of a walk whose failure mode is a
 * confident verdict about page one is exactly the drift worth avoiding.
 */

import { calculateLatencyStats } from "@mcpjam/sdk";
import type { PlatformApiClient } from "@mcpjam/sdk/platform";
import type { PlatformEvalIteration } from "@mcpjam/sdk/platform";

export type FetchedIterations = {
  items: PlatformEvalIteration[];
  complete: boolean;
};

/**
 * Fetch every iteration page for a run.
 *
 * `complete` is the load-bearing half of the return. A gate evaluated against
 * page one of a paginated run would report a confident verdict about a sample,
 * so an aborted walk yields `complete: false` and every score-derived gate
 * degrades to non-gateable (exit 3) instead of passing on partial evidence.
 */
export async function fetchAllIterations(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal,
  projectId: string,
  runId: string
): Promise<FetchedIterations> {
  const items: PlatformEvalIteration[] = [];
  let cursor: string | undefined;
  // Bound the walk so a runaway cursor cannot spin forever; hitting the bound
  // reports `complete: false` rather than pretending the sample is the run.
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listEvalRunIterations(
      { projectId, runId, ...(cursor ? { cursor } : {}), limit: 200 },
      { signal }
    );
    items.push(...result.items);
    if (!result.nextCursor) return { items, complete: true };
    cursor = result.nextCursor;
  }
  return { items, complete: false };
}

/**
 * p95 over a COMPLETE iteration walk; `undefined` from a partial one.
 *
 * Shared by `eval compare` and `eval gate --baseline`: both need a p95 for a
 * side of a comparison, and a single missing duration makes the p95 describe
 * a different set than the run — absent beats approximate.
 */
export function p95Of(
  iterations: FetchedIterations | undefined
): number | undefined {
  if (!iterations?.complete) return undefined;
  const durations = iterations.items
    .map((iteration) => iteration.durationMs)
    .filter((ms): ms is number => typeof ms === "number");
  if (durations.length === 0 || durations.length !== iterations.items.length) {
    return undefined;
  }
  return calculateLatencyStats(durations).p95;
}
