/**
 * The picker reads transcripts one iteration at a time, and only those of the
 * climb's steering cases (amendment A8): a validation or confirmation
 * transcript would let it steer by cases that must stay unseen. The fence is a
 * rule on the call, so it holds whatever ids the model tries: the run must be
 * one the climb launched, and the iteration's case must be a steering case. A
 * backend that cannot say which runs the climb launched refuses every read,
 * because the fence cannot be checked without it.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformApiClient, PlatformClimb } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import { readRunGroups } from "./run-groups.js";

const PAGE = 100;
const MAX_PAGES = 10;

const REFUSAL = "Only iterations of the climb's steering cases can be read. Take the run and iteration ids from the failed runs `get_climb` lists.";

export type TraceFenceDeps = {
  convex: Pick<ConvexHttpClient, "query">;
  client: Pick<PlatformApiClient, "listEvalRunIterations">;
  projectId: string;
  climbId: string;
};

export function createTraceFence(deps: TraceFenceDeps): (input: Record<string, unknown>) => Promise<string | undefined> {
  const { convex, client, projectId, climbId } = deps;
  return async (input) => {
    const runId = typeof input.runId === "string" ? input.runId : "";
    const iterationId = typeof input.iterationId === "string" ? input.iterationId : "";
    if (!runId || !iterationId) return REFUSAL;
    // Read each time: a round the step submitted adds runs the climb now owns.
    const groups = await readRunGroups(convex, climbId);
    if (!groups?.some((group) => group.launchedRunIds.includes(runId))) return REFUSAL;
    const climb: PlatformClimb = await convex.query(climbFns.get, { climbId });
    const steering = new Set(climb.groups.steeringCases.map((entry) => entry.key));
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await client.listEvalRunIterations({ projectId, runId, cursor, limit: PAGE });
      const found = result.items.find((iteration) => iteration.id === iterationId);
      if (found) return [found.caseId, found.testCaseId].some((key) => !!key && steering.has(key)) ? undefined : REFUSAL;
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return REFUSAL;
  };
}
