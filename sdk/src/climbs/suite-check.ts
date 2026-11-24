/**
 * The suite check: from the two baseline runs the backend settled, whether
 * this suite can show a change, for pass rate and for the climb's measure.
 * Every number is the backend's (noise, smallest change, recorded measures);
 * this only reads them together and says what they mean.
 */
import type { PlatformClimb, PlatformClimbMeasure } from "../platform/climb-types.js";
import type { SuiteCheck, SuiteCheckEnvironment, SuiteCheckFinding } from "./types.js";

const MEASURE_LABEL: Record<PlatformClimbMeasure, string> = {
  pass_rate: "pass rate",
  tokens: "tokens",
  cost: "cost",
  tool_calls: "tool calls",
};
const percent = (bps: number) => `${Math.round(bps) / 100}%`;
/** A suite that cannot show a move under this much of its pass rate has too few iterations to climb on. */
const COARSE_BPS = 2_500;

export function suiteCheck(climb: Pick<PlatformClimb, "measure" | "baseline" | "groups">): SuiteCheck {
  const { measure, baseline } = climb;
  const none: SuiteCheck = {
    ready: false,
    measure,
    canShowChange: false,
    environments: [],
    steeringToolsWithoutValidation: climb.groups.steeringToolsWithoutValidation,
    findings: [],
  };
  if (!baseline) return none;

  const environments: SuiteCheckEnvironment[] = baseline.environments.map((env) => {
    const noise = env.steering;
    return {
      environmentId: env.environmentId,
      noiseBps: {
        pass_rate: noise?.passRateNoiseBps ?? 0,
        ...(noise?.tokensNoiseBps !== undefined ? { tokens: noise.tokensNoiseBps } : {}),
        ...(noise?.costNoiseBps !== undefined ? { cost: noise.costNoiseBps } : {}),
        ...(noise?.tool_callsNoiseBps !== undefined ? { tool_calls: noise.tool_callsNoiseBps } : {}),
      },
      smallestChangeBps: noise?.smallestChangeBps ?? { pass_rate: 0 },
      recorded: env.recorded,
      noRoomToImprove: env.noRoomToImprove,
      flippedSteeringCaseKeys: env.flippedSteeringCaseKeys,
      flippedValidationCount: env.flippedValidationCount,
      lostIterations: env.lostIterations,
      countedIterations: env.countedIterations,
    };
  });

  const findings: SuiteCheckFinding[] = [];
  if (measure !== "pass_rate") {
    const recording = environments.filter((env) => env.recorded[measure]);
    if (recording.length === 0) {
      findings.push({
        code: "measure_not_recorded",
        severity: "blocks",
        message: `No environment recorded ${MEASURE_LABEL[measure]} on every iteration, so this climb cannot be for it. Climb for pass rate, or for a measure an environment recorded.`,
      });
    }
    for (const env of environments.filter((candidate) => !candidate.recorded[measure] && recording.length > 0)) {
      findings.push({
        code: "measure_not_recorded",
        severity: "warns",
        environmentId: env.environmentId,
        message: `This environment did not record ${MEASURE_LABEL[measure]} on every iteration, so it is left out of the measure. Its pass rate still counts.`,
      });
    }
  }
  if (measure === "pass_rate" && environments.length > 0 && environments.every((env) => env.noRoomToImprove)) {
    findings.push({
      code: "no_room_to_improve",
      severity: "blocks",
      message:
        "Every steering case passed in both baseline runs in every environment, so there is no pass rate to raise. Climb for tokens, cost or tool calls instead.",
    });
  } else {
    for (const env of environments.filter((candidate) => candidate.noRoomToImprove)) {
      findings.push({
        code: "no_room_to_improve",
        severity: "info",
        environmentId: env.environmentId,
        message: "Every steering case passed in both baseline runs here, so this environment has no pass rate to raise.",
      });
    }
  }
  for (const env of environments) {
    if (env.flippedSteeringCaseKeys.length > 0 || env.flippedValidationCount > 0) {
      const named = env.flippedSteeringCaseKeys.length > 0 ? ` Steering: ${env.flippedSteeringCaseKeys.join(", ")}.` : "";
      findings.push({
        code: "flipped_cases",
        severity: "warns",
        environmentId: env.environmentId,
        message:
          `${env.flippedSteeringCaseKeys.length} steering and ${env.flippedValidationCount} validation case${env.flippedValidationCount === 1 ? "" : "s"} ` +
          `passed in one baseline run and failed in the other, so they are noise until they settle.${named}`,
      });
    }
    if (env.lostIterations > 0) {
      findings.push({
        code: "iterations_lost",
        severity: "info",
        environmentId: env.environmentId,
        message: `${env.lostIterations} of ${env.lostIterations + env.countedIterations} iterations were lost to the model provider or the setup and are not counted against the server.`,
      });
    }
    // Two runs that agree to the token are one decision played twice: the noise reads as none, though the environment may not sample at all.
    if (env.recorded.tokens && env.noiseBps.tokens === 0 && env.flippedSteeringCaseKeys.length === 0 && env.flippedValidationCount === 0) {
      findings.push({
        code: "replays_one_decision",
        severity: measure === "pass_rate" ? "warns" : "info",
        environmentId: env.environmentId,
        message:
          "The two baseline runs gave the same result in every case, to the token, so this environment replays one decision (temperature 0 or the like). Its noise reads as none, and a change that steers the model can look like a sure win here." +
          (measure === "pass_rate" ? " A pass rate climb needs an environment that samples: run it in one, or set a temperature above 0." : ""),
      });
    }
    const smallest = env.smallestChangeBps[measure];
    const recorded = measure === "pass_rate" || env.recorded[measure];
    if (smallest !== undefined && recorded) {
      findings.push({
        code: "smallest_change",
        severity: smallest >= COARSE_BPS && measure === "pass_rate" ? "warns" : "info",
        environmentId: env.environmentId,
        message:
          `The smallest ${MEASURE_LABEL[measure]} change this suite can show here is ${percent(smallest)}.` +
          (smallest >= COARSE_BPS && measure === "pass_rate" ? " That is coarse: add iterations or cases." : ""),
      });
    }
  }
  if (climb.groups.validation === 0) {
    findings.push({
      code: "no_validation_cases",
      severity: "warns",
      message:
        "This climb has no validation cases, so the keep rule has nothing to check a gain on a steering case against. Start a new climb with some cases listed as validation, or with sizes that leave room for a validation group.",
    });
  }
  if (climb.groups.steeringToolsWithoutValidation.length > 0) {
    findings.push({
      code: "no_validation_for_tools",
      severity: "info",
      message: `No validation case covers ${climb.groups.steeringToolsWithoutValidation.join(", ")}, so a gain on a steering case there is not checked against anything. Add a case for each.`,
    });
  }

  return {
    ready: true,
    measure,
    canShowChange: !findings.some((finding) => finding.severity === "blocks"),
    environments,
    steeringToolsWithoutValidation: climb.groups.steeringToolsWithoutValidation,
    findings,
  };
}
