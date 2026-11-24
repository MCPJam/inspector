/**
 * The plain sentences a settled round gets. The backend decides keep, revert or
 * not decided and states why as codes; this only says them in words, with the
 * numbers the backend settled. Nothing here recomputes a verdict.
 */
import type { PlatformClimbMeasure } from "@mcpjam/sdk/platform";
import { MEASURE_NAMES, percent, ratioChange } from "./climb-format";
import type { ClimbRoundDetail } from "./climb-types";
import { RESULT_WORD, roundResult } from "./round-model";

export type RoundEnvironment = ClimbRoundDetail["environments"][number];
export type EnvironmentTone = "better" | "worse" | "same" | "none";

export function environmentTone(env: RoundEnvironment, measure: PlatformClimbMeasure): EnvironmentTone {
  if (!env.steering) return "none";
  const results = [env.steering.passRate, env.steering.measure, env.validation?.passRate, env.validation?.measure];
  if (results.some((result) => result?.move === "worse")) return "worse";
  const own = measure === "pass_rate" ? env.steering.passRate : env.steering.measure;
  return own?.move === "better" ? "better" : "same";
}

const labelOf = (labels: Record<string, string>, id: string) => labels[id] ?? "An environment";

function keptSentence(round: ClimbRoundDetail, labels: Record<string, string>, measure: PlatformClimbMeasure): string {
  const better = round.environments.filter((env) => environmentTone(env, measure) === "better");
  const lines = better.slice(0, 2).map((env) => {
    const label = labelOf(labels, env.environmentId);
    if (measure === "pass_rate" && env.steering?.passRate) {
      const { bestBps, candidateBps } = env.steering.passRate;
      return `${label} went from ${percent(bestBps)} to ${percent(candidateBps)}.`;
    }
    const ratio = env.steering?.measure?.ratioBps;
    return ratio === undefined ? `${label} got better.` : `${label}: ${MEASURE_NAMES[measure]} ${ratioChange(ratio)}.`;
  });
  const validation = round.validation === "better" ? "Validation cases went up too." : "Validation cases didn't move.";
  return [...lines, validation].join(" ");
}

function revertedSentence(round: ClimbRoundDetail, labels: Record<string, string>, measure: PlatformClimbMeasure): string {
  const worse = round.environments.filter((env) => environmentTone(env, measure) === "worse");
  const names = worse.map((env) => labelOf(labels, env.environmentId)).join(", ");
  const parts: string[] = [];
  if (round.reasons.includes("pass_rate_worse")) parts.push(`Pass rate went down${names ? ` on ${names}` : ""}.`);
  if (round.reasons.includes("measure_worse")) parts.push(`${MEASURE_NAMES[measure]} got worse${names ? ` on ${names}` : ""}.`);
  if (round.reasons.includes("no_improvement")) parts.push("No environment improved beyond the noise.");
  if (round.validationRegressed) parts.push("Validation cases went down.");
  return parts.join(" ") || "Nothing got better.";
}

const UNDECIDED: Record<string, (server: string) => string> = {
  run_missing: () => "A run did not finish, so the two results can't be compared.",
  too_many_lost: () => "Too many iterations were lost to the model provider to compare the results.",
  real_server_changed: (server) => `${server} changed since the best so far was measured, so the two results can't be compared.`,
  measure_not_comparable: () => "The measure was not recorded in every environment, so the two results can't be compared.",
};

function undecidedSentence(round: ClimbRoundDetail, serverName: string): string {
  const reasons = round.reasons.map((code) => UNDECIDED[code]?.(serverName)).filter(Boolean);
  const failure = round.reasons.includes("unit_failed") && round.failureReason ? [round.failureReason] : [];
  return [...reasons, ...failure].join(" ") || "The two results can't be compared.";
}

/**
 * A round's verdict as a lead word and the reason with its numbers. The numbers
 * come from what the rule decided; an overrule is added after them, with who
 * made it and why, so the record of the rule stays readable.
 */
export function verdictSentence(
  round: ClimbRoundDetail,
  context: { labels: Record<string, string>; measure: PlatformClimbMeasure; serverName: string },
): { lead: string; rest: string } {
  const result = roundResult(round);
  if (result === "running") return { lead: "Running.", rest: "" };
  if (result === "failed") {
    return { lead: "Did not finish.", rest: round.failureReason ?? "The runs did not complete. Submit the change again." };
  }
  const { labels, measure, serverName } = context;
  const ruled =
    round.verdict === "kept"
      ? keptSentence(round, labels, measure)
      : round.verdict === "reverted"
        ? revertedSentence(round, labels, measure)
        : undecidedSentence(round, serverName);
  const overrule = round.overruled
    ? ` The rule ${round.verdict === "not_decided" ? "did not decide it" : `${round.verdict} it`}. Overruled to ${round.overruled.to} by ${round.overruled.by}: ${round.overruled.reason}`
    : "";
  return { lead: `${RESULT_WORD[result]}.`, rest: `${ruled}${overrule}` };
}
