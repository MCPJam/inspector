/**
 * What the rail and the round view say about a round, read from the climb as
 * the backend describes it. Nothing here decides a verdict: the backend keeps
 * or reverts a round, and these only name what it did.
 */
import type { PlatformMockChange } from "@mcpjam/sdk/platform";
import type { Climb, ClimbRoundSummary } from "./climb-types";
import { plural } from "./climb-format";

export type RoundResult = "kept" | "reverted" | "undecided" | "running" | "failed";

export const RESULT_WORD: Record<RoundResult, string> = {
  kept: "Kept",
  reverted: "Reverted",
  undecided: "Not decided",
  running: "Running",
  failed: "Did not finish",
};

export function roundResult(round: ClimbRoundSummary): RoundResult {
  if (round.status === "running") return "running";
  if (round.status === "failed") return "failed";
  const verdict = round.standing ?? round.verdict;
  if (verdict === "kept") return "kept";
  if (verdict === "reverted") return "reverted";
  return "undecided";
}

/** "You", "MCPJam", or the agent's own name: who put this round in. */
export function submittedByLabel(climb: Climb, round: ClimbRoundSummary): string {
  if (round.pickedBy === "mcpjam") return "MCPJam";
  const throughAgent =
    round.submittedVia === "mcp" || round.submittedVia === "cli" || climb.picker === "agent";
  if (!throughAgent) return "You";
  return round.submittedBy.trim() || "Your agent";
}

/**
 * "Overruled by Casey: It reads better." for a round a person overruled, else
 * null. The rule's own verdict stays readable in the round view; this only
 * says who changed what stands, and why.
 */
export function overruleLine(round: ClimbRoundSummary): string | null {
  const overruled = round.overruled;
  if (!overruled) return null;
  const by = overruled.by.trim();
  const reason = overruled.reason.trim();
  return `Overruled${by ? ` by ${by}` : ""}${reason ? `: ${reason}` : "."}`;
}

export function keptRounds(climb: Climb): ClimbRoundSummary[] {
  return climb.rounds.filter((round) => roundResult(round) === "kept");
}

/** The best so far, as the rounds it is made of: "Baseline + rounds 1 and 2". */
export function bestSoFarLabel(climb: Climb): string {
  const numbers = keptRounds(climb).map((round) => round.number);
  if (numbers.length === 0) return "Baseline";
  const list =
    numbers.length === 1
      ? String(numbers[0])
      : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
  return `Baseline + ${numbers.length === 1 ? "round" : "rounds"} ${list}`;
}

const versionOf = (version: string | undefined): number | null => {
  const parsed = version === undefined ? NaN : Number.parseInt(version, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

/**
 * The version of the mock this round started from: the best so far when the
 * round was submitted, which is the last kept round before it, else the
 * baseline's first version. Null when the round ran another server, where a
 * comparison of versions would mean nothing.
 */
export function startingVersion(climb: Climb, round: ClimbRoundSummary): number | null {
  const own = versionOf(round.serverVersion);
  if (own === null) return null;
  const before = keptRounds(climb)
    .filter((candidate) => candidate.number < round.number)
    .at(-1);
  if (!before) return own > 1 ? 1 : null;
  if (before.serverId !== round.serverId) return null;
  const since = versionOf(before.serverVersion);
  return since !== null && since < own ? since : null;
}

/** One line for the rail: the first change, and how many more came with it. */
export function changeTitle(changes: readonly PlatformMockChange[] | null | undefined, round: number): string {
  const first = changes?.[0];
  if (!first) return `Round ${round}`;
  const more = (changes?.length ?? 1) - 1;
  return more > 0 ? `${first.summary}, and ${plural(more, "more change")}` : first.summary;
}
