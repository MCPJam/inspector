/**
 * The summary of a climb: the rounds as the backend settled them, and the
 * confirmation once it has run, put together by the SDK's `summarizeClimb`.
 */
import { summarizeClimb, type ClimbSummary, type ConfirmationInput } from "@mcpjam/sdk/climbs";
import type { PlatformClimb, PlatformClimbRound } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import type { ClimbDeps } from "./deps.js";

/** The stored record of the confirmation, with its per-case measurements once it has settled. */
export async function readConfirmation(deps: Pick<ClimbDeps, "convex">, climbId: string): Promise<ConfirmationInput | undefined> {
  const read: { status: "none" } | (ConfirmationInput["record"] & { cases?: ConfirmationInput["cases"] }) =
    await deps.convex.query(climbFns.getConfirmation, { climbId });
  if (read.status === "none") return undefined;
  const { cases, ...record } = read;
  return { record, cases };
}

export async function summarizeStopped(deps: Pick<ClimbDeps, "convex">, climb: PlatformClimb): Promise<ClimbSummary> {
  const settled = climb.rounds.filter((round) => round.status === "settled");
  const rounds: PlatformClimbRound[] = await Promise.all(
    settled.map((round) => deps.convex.query(climbFns.getRound, { climbId: climb.climbId, roundNumber: round.number })),
  );
  return summarizeClimb({ climb, rounds, confirmation: await readConfirmation(deps, climb.climbId) });
}
