/**
 * What each round changed, from the mock versions the rounds ran. A round's
 * change list is the difference between its definition and the best before it,
 * so a kept round's list is what the coding agent has to apply and a reverted
 * one is what was tried. A round that ran a saved server that is not a mock
 * carries `code` and no changes. Definitions are read once each, as the caller.
 */
import type { ConvexHttpClient } from "convex/browser";
import { diffMockDefinitions, type MockDefinition } from "@mcpjam/sdk/mocks";
import type { KeptRound, TriedChange } from "@mcpjam/sdk/climbs";
import type { PlatformClimb, PlatformClimbRoundSummary } from "@mcpjam/sdk/platform";
import { convexErrorData } from "../../routes/v1/convex-errors.js";
import { logger } from "../../utils/logger.js";
import { climbFns } from "./backend.js";

type MockRow = { definitionJson: string };

/** The definition a round ran: its mock at the version it recorded. A server that is not a mock has none. */
export async function definitionOf(
  convex: Pick<ConvexHttpClient, "query">,
  serverId: string,
  serverVersion: string | undefined,
): Promise<MockDefinition | undefined> {
  const version = Number(serverVersion);
  try {
    const row: MockRow = await convex.query(climbFns.getMock, {
      mockId: serverId,
      ...(Number.isInteger(version) && version >= 1 ? { version } : {}),
    });
    return JSON.parse(row.definitionJson);
  } catch (error) {
    if (convexErrorData(error)?.code === "MOCK_NOT_FOUND") return undefined;
    throw error;
  }
}

export type RoundChange = TriedChange & { standing: "kept" | "reverted" | "not_decided" };

/**
 * The names of the project's saved servers, so a code round reads as the server
 * the person knows. Read once, and only when a round ran one; a read that fails
 * leaves the id to stand in, because the prompt is still true without a name.
 */
async function savedServerNames(convex: Pick<ConvexHttpClient, "query">, projectId: string): Promise<Map<string, string>> {
  try {
    const rows: Array<{ _id: string; name?: string }> = await convex.query(climbFns.projectServers, { projectId });
    return new Map(rows.flatMap((row) => (row.name ? [[String(row._id), row.name] as const] : [])));
  } catch (error) {
    logger.warn("[climbs] the project's saved servers were not read, so a code round shows its server id", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/** Every settled round's change list, against the best that stood before it, in round order. */
export async function loadRoundChanges(
  convex: Pick<ConvexHttpClient, "query">,
  climb: Pick<PlatformClimb, "rounds" | "best" | "projectId">,
): Promise<RoundChange[]> {
  let names: Map<string, string> | undefined;
  // The baseline mock has no changes: the best so far starts as an empty definition.
  let best: MockDefinition = {};
  const changes: RoundChange[] = [];
  for (const round of [...climb.rounds].sort((a, b) => a.number - b.number)) {
    const standing = standingOf(round);
    if (!standing) continue;
    const definition = await definitionOf(convex, round.serverId, round.serverVersion);
    if (!definition) {
      // A saved server that runs the agent's own code: the code is the change, and it is no mock to diff later rounds against.
      names ??= await savedServerNames(convex, climb.projectId);
      const serverName = names.get(round.serverId);
      changes.push({
        round: round.number,
        verdict: round.verdict ?? standing,
        standing,
        changes: [],
        code: { serverId: round.serverId, ...(serverName ? { serverName } : {}) },
      });
      continue;
    }
    changes.push({ round: round.number, verdict: round.verdict ?? standing, standing, changes: diffMockDefinitions(best, definition) });
    if (standing === "kept") best = definition;
  }
  return changes;
}

function standingOf(round: PlatformClimbRoundSummary): RoundChange["standing"] | undefined {
  if (round.status !== "settled") return undefined;
  return round.standing ?? round.verdict;
}

/** The rounds that stand as kept, in the shape the prompt takes. */
export function keptRoundsOf(
  rounds: readonly RoundChange[],
  kept: ReadonlyArray<{ number: number; validation?: "better" | "unchanged"; overruled: boolean }>,
): KeptRound[] {
  const byNumber = new Map(rounds.map((round) => [round.round, round]));
  return kept.map((round) => ({
    number: round.number,
    ...(round.validation ? { validation: round.validation } : {}),
    overruled: round.overruled,
    changes: byNumber.get(round.number)?.changes ?? [],
    ...(byNumber.get(round.number)?.code ? { code: byNumber.get(round.number)!.code } : {}),
  }));
}
