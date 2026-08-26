/**
 * The grading-engine mode for one hosted run.
 *
 * Four positions, ordered: `off < shadow < dual_write < enforce`. The effective
 * mode is the MINIMUM of every position that has an opinion, which is what
 * makes the rollout monotone — no single input can raise the mode above what
 * any other input allows:
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
 * WHO SUPPLIES WHICH POSITION. Both passes now carry the RUN's frozen position:
 * the second pass reads it off the run row, and the runner threads
 * `gradingMode` from `configSnapshot.gradingEngine` into
 * `buildIterationFinishParams` (B3b). A per-suite `off` is therefore
 * authoritative on the first pass too, which it was not before — the first pass
 * used to consult the env ceiling alone.
 *
 * ── THE STALE-FLEET HAZARD, and why env is flipped LAST ─────────────────────
 *
 * `parseGradingEngineMode` accepts exactly the spellings THIS BUILD knows. A
 * pod running a build that predates `enforce` parses `MCPJAM_GRADING_ENGINE_MODE
 * =enforce` as UNRECOGNIZED, and an unrecognized env value is `off` — not
 * `dual_write`, not "ignore this position". So during a rollout where the env
 * var is raised before every pod has the new build, the old pods do not merely
 * decline to enforce: they write no score rows at all.
 *
 * That is the safe direction (a lower position is always safe) and it is not a
 * bug to "fix" by making unknown values inherit — inheriting an unknown value
 * is how a typo becomes a promotion. It does mean the ORDER of a promotion
 * matters: raise the org flag and the suite ceiling FIRST, which are read from
 * data every build understands, and raise the env ceiling LAST, once the fleet
 * is uniform.
 */

import { logger } from "../../utils/logger.js";

export const GRADING_ENGINE_MODES = [
  "off",
  "shadow",
  "dual_write",
  "enforce",
] as const;
export type GradingEngineMode = (typeof GRADING_ENGINE_MODES)[number];

/** Monotone order. Index IS the rank — `min` over ranks is the resolution. */
const MODE_RANK: Record<GradingEngineMode, number> = {
  off: 0,
  shadow: 1,
  dual_write: 2,
  /**
   * B3b. The score contract DECIDES here: `finalize-iteration` derives the
   * iteration's outgoing `result` from its gating rows via the contract's
   * `allGatingScorersPassed`, and the backend re-derives from the rows it
   * persisted and downgrades on disagreement.
   *
   * Above `dual_write` rather than beside it, deliberately: `enforce` writes
   * exactly the fields `dual_write` writes, so lowering one position restores
   * boolean authority with no data migration in either direction. That is what
   * makes the rollback a flag flip for the whole window between the two waves.
   */
  enforce: 3,
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

/**
 * The mode ONE RUN executes at, from the position the backend FROZE onto it.
 *
 * The subtlety this exists to contain: `resolveGradingEngineMode` treats a
 * position with no opinion as UNCONSTRAINED, so it falls through to the env
 * ceiling — correct for an org flag nobody resolved, and exactly wrong for a
 * run snapshot. The backend writes no `gradingEngine` key at all when it
 * resolved `off`, so that an `off` run's snapshot stays byte-identical to a
 * pre-B3b one. An ABSENT STAMP IS THEREFORE A DECISION, not a missing opinion —
 * the suite ceiling, the org flag and the legacy v2 clamp all live upstream of
 * it, and absence is their combined answer.
 *
 * Passing that absence straight through would promote every `off` run to
 * whatever this process's env var says, the moment an operator raises it — the
 * precise inverse of the safety the ceilings are for. Every caller that has a
 * run snapshot goes through here instead of spelling the fallback out, so
 * there is one place to get it right.
 */
export function resolveFrozenRunGradingMode(
  runSnapshot: ModeCarrier
): GradingEngineMode {
  // A PRESENT stamp this build cannot spell is still a DECISION, and the safe
  // reading of a decision we cannot read is the lowest position.
  //
  // The absent case was already handled; a carrier like `{}`, or one naming a
  // mode a NEWER backend added, yields `undefined` from the parser — and
  // `resolveGradingEngineMode` treats an unparseable position as "no opinion"
  // and falls through to the env ceiling. That is the same promotion this
  // function exists to prevent, reached by a different route. The module
  // already resolves an unrecognized ENV value to `off` for exactly this
  // reason; the run stamp gets the same direction.
  const stamped = runSnapshot
    ? (parseGradingEngineMode(runSnapshot.mode) ?? "off")
    : "off";
  return resolveGradingEngineMode({ runSnapshot: { mode: stamped } });
}

/**
 * True when this mode writes real (non-shadow) score rows.
 *
 * `enforce` writes the same real rows `dual_write` does — the difference
 * between them is who decides the VERDICT, not what gets persisted. Every
 * writer therefore asks this question, not `mode === "dual_write"`.
 */
export function isDualWrite(mode: GradingEngineMode): boolean {
  return mode === "dual_write" || mode === "enforce";
}

/** True when the score rows are AUTHORITATIVE for this iteration's result. */
export function isEnforcing(mode: GradingEngineMode): boolean {
  return mode === "enforce";
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
