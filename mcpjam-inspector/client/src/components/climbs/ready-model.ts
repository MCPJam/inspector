/**
 * What the ready view lists, read from `get_climb`. The backend and the SDK's
 * climb functions order and count everything; these only choose which option
 * starts selected and which of the ranked changes belong to an option.
 */
import type { ChangeEntry, ClimbForOption, SuiteCheckFinding } from "@mcpjam/sdk/climbs";
import type { Climb } from "./climb-types";

/** The option a climb starts on: the one its measure names, or the first with failed runs behind it. */
export function defaultOptionId(climb: Climb): string | undefined {
  const options = (climb.climbFor ?? []).filter((option) => option.available);
  if (climb.measure !== "pass_rate") {
    return options.find((option) => option.id === climb.measure)?.id ?? options[0]?.id;
  }
  return (
    options.find((option) => option.measure === "pass_rate" && option.failedRuns.length > 0)?.id ??
    options.find((option) => option.id === "pass_rate")?.id ??
    options[0]?.id
  );
}

/** An option whose measure differs from a locked climb's cannot be chosen: the measure is fixed once round 1 settles. */
export function optionDisabledReason(climb: Climb, option: ClimbForOption): string | undefined {
  if (!option.available) return option.reason ?? "This server has nothing to climb for here.";
  if (climb.measureLocked && option.measure !== climb.measure) {
    return "The measure is fixed once round 1 has settled.";
  }
  return undefined;
}

const OPTION_FIELDS: Record<string, (entry: ChangeEntry) => boolean> = {
  tool_descriptions: (entry) => entry.where.field === "description" || entry.where.field === "title",
  tool_inputs: (entry) => entry.where.field === "inputSchema" || entry.where.field.startsWith("params"),
  instructions: (entry) => entry.where.kind === "server" && entry.where.field === "instructions",
  fewer_tools: (entry) => entry.where.field === "hidden",
};

/** The ranked changes that belong to an option; an option about no one field keeps them all. */
export function entriesForOption(entries: readonly ChangeEntry[], optionId: string | undefined): ChangeEntry[] {
  const belongs = optionId ? OPTION_FIELDS[optionId] : undefined;
  return belongs ? entries.filter(belongs) : [...entries];
}

export const FINDING_LABELS: Record<SuiteCheckFinding["code"], string> = {
  measure_not_recorded: "Not recorded",
  no_room_to_improve: "Headroom",
  flipped_cases: "Unstable cases",
  no_validation_for_tools: "Coverage",
  no_validation_cases: "Coverage",
  iterations_lost: "Plumbing",
  replays_one_decision: "One decision",
  smallest_change: "Smallest change",
};
