/**
 * `stop_climb`: the backend stops the climb and says which rounds stand as
 * kept; this adds the prompt for the coding agent that works on the server's
 * code, built in the SDK from what each kept round changed.
 */
import { climbPrompt } from "@mcpjam/sdk/climbs";
import type { PlatformClimb, PlatformClimbStopped } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import type { ClimbDeps } from "./deps.js";
import { keptRoundsOf, loadRoundChanges } from "./round-changes.js";
import { summarizeStopped } from "./summary.js";

export async function stopClimb(deps: ClimbDeps, climb: PlatformClimb): Promise<PlatformClimbStopped> {
  const stopped: Omit<PlatformClimbStopped, "climbId" | "suiteId" | "prompt" | "summary"> = await deps.convex.mutation(climbFns.stop, {
    climbId: climb.climbId,
  });
  const after: PlatformClimb = await deps.convex.query(climbFns.get, { climbId: climb.climbId });
  const kept = keptRoundsOf(await loadRoundChanges(deps.convex, after), stopped.kept);
  return {
    climbId: climb.climbId,
    suiteId: climb.suiteId,
    ...stopped,
    prompt: climbPrompt({ serverName: climb.serverName, kept }),
    summary: await summarizeStopped(deps, after),
  };
}
