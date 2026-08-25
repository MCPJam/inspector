/**
 * The grading-engine mode for one hosted run.
 *
 * Three positions, ordered: `off < shadow < dual_write`. The effective mode is
 * the MINIMUM of every position that has an opinion, which is what makes the
 * rollout monotone — no single input can raise the mode above what any other
 * input allows:
 *
 *   - `MCPJAM_GRADING_ENGINE_MODE` (env) is the KILL SWITCH. Absent or
 *     unrecognized ⇒ `off`, so a deploy that ships this code and nothing else
 *     changes no behaviour anywhere.
 *   - the org feature gate (`grading-engine-mode`, W1),
 *   - the suite's `gradingEngine.mode`, read from the RUN SNAPSHOT
 *     (`configSnapshot.gradingEngine`) rather than the live suite, so a
 *     mid-run edit cannot split one run across two modes,
 *   - a per-run override.
 *
 * Total and pure: every unparseable or absent input is simply an input with no
 * opinion (env excepted — see above), never a throw, because a mode resolver
 * that can throw becomes a new way for a run to fail.
 *
 * WHO SUPPLIES WHICH POSITION TODAY. The second pass reads the run row, so it
 * passes the run snapshot. The runner's finalization path does NOT carry the
 * run row — `buildIterationFinishParams` is handed an iteration, not a run —
 * so on the first pass only the env ceiling is consulted unless a caller
 * threads a mode in explicitly. That is safe because the env position is a
 * ceiling and defaults to `off`; it does mean an operator must not raise env
 * above the mode the narrowest suite should get, i.e. env is flipped LAST, not
 * first. Threading the snapshot through the runner is the follow-up that makes
 * a per-suite `off` authoritative on the first pass too.
 */

import { logger } from "../../utils/logger.js";

export const GRADING_ENGINE_MODES = ["off", "shadow", "dual_write"] as const;
export type GradingEngineMode = (typeof GRADING_ENGINE_MODES)[number];

/** Monotone order. Index IS the rank — `min` over ranks is the resolution. */
const MODE_RANK: Record<GradingEngineMode, number> = {
  off: 0,
  shadow: 1,
  dual_write: 2,
};

/** The one recognized spelling of each position. Anything else has no opinion. */
export function parseGradingEngineMode(
  value: unknown
): GradingEngineMode | undefined {
  return typeof value === "string" &&
    (GRADING_ENGINE_MODES as readonly string[]).includes(value)
    ? (value as GradingEngineMode)
    : undefined;
}

/** A `{ mode }` carrier (feature gate payload, suite config, run snapshot). */
type ModeCarrier = { mode?: unknown } | null | undefined;

function carrierMode(carrier: ModeCarrier): GradingEngineMode | undefined {
  return carrier ? parseGradingEngineMode(carrier.mode) : undefined;
}

export type GradingModeInputs = {
  /**
   * Raw `MCPJAM_GRADING_ENGINE_MODE`. Defaults to `process.env` when absent so
   * callers that have nothing to say still get the kill switch honored.
   */
  env?: string | undefined;
  /** The org's `grading-engine-mode` gate payload, if the caller resolved one. */
  orgFlag?: ModeCarrier;
  /**
   * The suite's grading config AS SNAPSHOTTED ON THE RUN
   * (`testSuiteRun.configSnapshot.gradingEngine`). Never the live suite row.
   */
  runSnapshot?: ModeCarrier;
  /** Per-run override, when a run carries one. */
  runOverride?: ModeCarrier;
};

/**
 * Resolve the effective mode. Defaults to `off`.
 *
 * The env position is deliberately asymmetric: an absent env var resolves to
 * `off` (ships-at-off), while an absent org/suite/run position is merely
 * unconstrained — those three can only ever lower the env's ceiling.
 */
export function resolveGradingEngineMode(
  inputs: GradingModeInputs = {}
): GradingEngineMode {
  const envRaw =
    inputs.env === undefined
      ? process.env.MCPJAM_GRADING_ENGINE_MODE
      : inputs.env;
  const ceiling = parseGradingEngineMode(envRaw) ?? "off";
  const positions = [
    carrierMode(inputs.orgFlag),
    carrierMode(inputs.runSnapshot),
    carrierMode(inputs.runOverride),
  ].filter((mode): mode is GradingEngineMode => mode !== undefined);
  return positions.reduce<GradingEngineMode>(
    (lowest, mode) => (MODE_RANK[mode] < MODE_RANK[lowest] ? mode : lowest),
    ceiling
  );
}

/** True when this mode writes real (non-shadow) score rows. */
export function isDualWrite(mode: GradingEngineMode): boolean {
  return mode === "dual_write";
}

/** True when this mode produces score rows at all (shadow or real). */
export function producesScoreRows(mode: GradingEngineMode): boolean {
  return mode !== "off";
}

let loggedStartupMode = false;

/**
 * Log the env ceiling exactly once, at startup, so an operator can see which
 * mode the process could reach without reading a flag dashboard. Idempotent:
 * repeated calls are no-ops.
 */
export function logGradingEngineModeOnce(): void {
  if (loggedStartupMode) return;
  loggedStartupMode = true;
  const raw = process.env.MCPJAM_GRADING_ENGINE_MODE;
  logger.info("[evals] grading engine mode", {
    envCeiling: parseGradingEngineMode(raw) ?? "off",
    ...(raw !== undefined && parseGradingEngineMode(raw) === undefined
      ? { unrecognizedEnvValue: true }
      : {}),
  });
}

/** Test-only reset of the once-per-process startup log latch. */
export function resetGradingEngineModeLogForTests(): void {
  loggedStartupMode = false;
}
