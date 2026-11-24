/**
 * The summary of a stopped climb: steering and validation results, labeled as
 * the cases that picked the result, the confirmation with its interval, and a
 * plain statement of what the climb established and what it did not.
 *
 * Every number is one the backend settled (a round's pass rates and ratios) or
 * the interval the SDK computes from the confirmation's stored per-case
 * measurements. Validation is totals per environment and never a case (A8).
 */
import type { PlatformClimb, PlatformClimbMeasure, PlatformClimbRound } from "../platform/climb-types.js";
import { confirmationInterval, type ConfirmationCaseRow, type ConfirmationInterval } from "./interval.js";

const MEASURE_LABEL: Record<PlatformClimbMeasure, string> = {
  pass_rate: "pass rate",
  tokens: "tokens",
  cost: "cost",
  tool_calls: "tool calls",
};

export type SummaryEnvironment = {
  environmentId: string;
  baselinePassRateBps: number | null;
  bestPassRateBps: number | null;
  /** Best against baseline. For tokens, cost or tool calls: the kept rounds' ratios multiplied; below 10000 is fewer. */
  measureRatioBps?: number;
};

export type ConfirmationSummary =
  | { status: "no_cases" | "not_run" | "running" | "failed"; usedByEarlierClimbs: string[]; failureReason?: string }
  | { status: "settled"; usedByEarlierClimbs: string[]; environments: ConfirmationInterval[]; notDecided: string[] };

export type ClimbSummary = {
  measure: PlatformClimbMeasure;
  stoppedBecause: string;
  steering: { label: string; environments: SummaryEnvironment[] };
  validation: { label: string; environments: SummaryEnvironment[] };
  rounds: Array<{ number: number; standing: string; validation?: "better" | "unchanged"; reasons: string[] }>;
  confirmation: ConfirmationSummary;
  /** What the climb established, and what it did not. */
  established: string[];
  notEstablished: string[];
};

export type ConfirmationInput = {
  record: NonNullable<PlatformClimb["confirmation"]>;
  /** Present once it settled: the stored per-case measurements. */
  cases?: ConfirmationCaseRow[];
};

const STOPPED: Record<string, string> = {
  all_steering_pass: "every steering case passes in every environment",
  target_reached: "the target was reached in every environment that recorded the measure",
  round_limit: "the round limit was reached",
  stopped_by_caller: "it was stopped",
};

export function summarizeClimb(input: {
  climb: Pick<PlatformClimb, "measure" | "baseline" | "groups" | "stopReason" | "confirmationCasesUsedBy">;
  rounds: readonly PlatformClimbRound[];
  confirmation?: ConfirmationInput;
}): ClimbSummary {
  const { climb } = input;
  const settled = input.rounds.filter((round) => round.status === "settled").sort((a, b) => a.number - b.number);
  const standing = (round: PlatformClimbRound) => round.overruled?.to ?? round.standing ?? round.verdict;
  const kept = settled.filter((round) => standing(round) === "kept");
  const last = kept.at(-1);

  const environmentOf = (group: "steering" | "validation") =>
    (climb.baseline?.environments ?? []).map((env): SummaryEnvironment => {
      const baseline = env[group];
      const best = last?.environments.find((candidate) => candidate.environmentId === env.environmentId)?.[group]?.passRate?.candidateBps;
      const ratios = kept.flatMap((round) => {
        const ratio = round.environments.find((candidate) => candidate.environmentId === env.environmentId)?.[group]?.measure?.ratioBps;
        return ratio === undefined ? [] : [ratio];
      });
      const baselineBps = baseline ? Math.round((baseline.passRateBps[0] + baseline.passRateBps[1]) / 2) : null;
      return {
        environmentId: env.environmentId,
        baselinePassRateBps: baselineBps,
        bestPassRateBps: best ?? baselineBps,
        ...(climb.measure !== "pass_rate" && ratios.length > 0
          ? { measureRatioBps: Math.round(ratios.reduce((product, ratio) => (product * ratio) / 10_000, 10_000)) }
          : {}),
      };
    });

  const confirmation = summarizeConfirmation(climb, input.confirmation, kept.length > 0);
  const { established, notEstablished } = statements(climb, kept.length, confirmation);
  return {
    measure: climb.measure,
    stoppedBecause: climb.stopReason ? (STOPPED[climb.stopReason] ?? climb.stopReason) : "it has not stopped",
    steering: { label: "Steering cases: the climb learned from them and they helped pick this result", environments: environmentOf("steering") },
    validation: { label: "Validation cases: every round ran them, so they helped pick this result too (totals only)", environments: environmentOf("validation") },
    rounds: settled.map((round) => ({
      number: round.number,
      standing: standing(round) ?? "not_decided",
      ...(round.validation ? { validation: round.validation } : {}),
      reasons: round.reasons,
    })),
    confirmation,
    established,
    notEstablished,
  };
}

/** The confirmation as the summary tells it, from the record and, once it settled, the stored per-case measurements. */
export function summarizeConfirmation(
  climb: Pick<PlatformClimb, "measure" | "groups" | "confirmationCasesUsedBy">,
  input: ConfirmationInput | undefined,
  anyKept = true,
): ConfirmationSummary {
  const usedByEarlierClimbs = climb.confirmationCasesUsedBy;
  if (climb.groups.confirmation === 0) return { status: "no_cases", usedByEarlierClimbs };
  if (!input) return { status: anyKept ? "not_run" : "no_cases", usedByEarlierClimbs };
  const { record } = input;
  if (record.status === "failed") return { status: "failed", usedByEarlierClimbs, failureReason: record.failureReason };
  if (record.status !== "settled" || !input.cases) return { status: "running", usedByEarlierClimbs };
  const cases = input.cases;
  const decided = (record.environments ?? []).flatMap((entry) => {
    const value = entry as { environmentId?: string; notDecided?: boolean };
    return typeof value.environmentId === "string" ? [{ id: value.environmentId, notDecided: value.notDecided === true }] : [];
  });
  const ids = decided.length > 0 ? decided : [...new Set(cases.map((row) => row.environmentId))].map((id) => ({ id, notDecided: false }));
  return {
    status: "settled",
    usedByEarlierClimbs,
    environments: ids.filter((entry) => !entry.notDecided).map((entry) => confirmationInterval(cases, entry.id, climb.measure)),
    notDecided: ids.filter((entry) => entry.notDecided).map((entry) => entry.id),
  };
}

function statements(
  climb: Pick<PlatformClimb, "measure">,
  keptCount: number,
  confirmation: ConfirmationSummary,
): { established: string[]; notEstablished: string[] } {
  const measure = MEASURE_LABEL[climb.measure];
  const established: string[] = [];
  const notEstablished: string[] = [];
  if (keptCount === 0) {
    return { established: ["No round improved on the baseline, so nothing is kept."], notEstablished: [] };
  }
  established.push(
    `${keptCount} round${keptCount === 1 ? "" : "s"} improved ${measure} on the steering cases in at least one environment without making ${measure} or pass rate worse in any, validation cases included.`,
  );
  notEstablished.push(
    "Steering and validation cases both helped pick this result, so their numbers say what the rounds showed, not what the server will do on cases no round ran.",
  );
  switch (confirmation.status) {
    case "settled":
      for (const entry of confirmation.environments) {
        const range = entry.low === null || entry.high === null ? "" : ` (95% interval ${entry.low} to ${entry.high} ${entry.unit})`;
        if (entry.difference === null) {
          notEstablished.push(`The confirmation cases could not be compared in ${entry.environmentId}.`);
        } else if (entry.includesZero) {
          notEstablished.push(
            `On the confirmation cases the gain in ${entry.environmentId} is within noise${range}. Do not ship on it.`,
          );
        } else {
          established.push(`On the confirmation cases, ${measure} moved ${entry.difference} ${entry.unit}${range} in ${entry.environmentId}, and the interval excludes zero.`);
        }
      }
      for (const id of confirmation.notDecided) {
        notEstablished.push(`More than one in ten confirmation iterations were lost in ${id}, so it is not decided there.`);
      }
      break;
    case "no_cases":
      notEstablished.push(
        "No cases were set aside for a confirmation, so nothing here tests the result on cases no round ran. Run verify_climb to check it on the real server.",
      );
      break;
    case "failed":
      notEstablished.push("The confirmation did not finish. It can be asked for again.");
      break;
    case "running":
      notEstablished.push("The confirmation is still running. Read the climb again when it has settled.");
      break;
    case "not_run":
      notEstablished.push("The confirmation has not run. Run confirm_climb once to test the result on cases no round saw.");
      break;
  }
  return { established, notEstablished };
}
