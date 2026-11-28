/**
 * The grading-engine mode one run executes at.
 *
 * Four positions, ordered: `off < shadow < dual_write < enforce`.
 *
 * The backend decides it once, when it creates the run, and freezes the answer
 * into `configSnapshot.gradingEngine`: the suite's own `gradingEngine.mode`,
 * lowered for a replay to its source run's mode, then clamped to verdict-policy
 * authority. This process runs the run at exactly that. It reads the run's
 * snapshot rather than the live suite, so a mid-run edit cannot split one run
 * across two modes.
 *
 * There is deliberately no setting here that can raise or lower it. The backend
 * accepts a Required judge or code evaluator only on a run frozen at `enforce`,
 * so a second source on this side could grade that run at something lower and
 * leave the Required gate accepted but never applied.
 *
 * Total and pure: every unparseable or absent input resolves to `off`, never a
 * throw, because a mode resolver that can throw becomes a new way for a run to
 * fail.
 */

export const GRADING_ENGINE_MODES = [
  "off",
  "shadow",
  "dual_write",
  "enforce",
] as const;
export type GradingEngineMode = (typeof GRADING_ENGINE_MODES)[number];

/** The one recognized spelling of each position. Anything else has no opinion. */
export function parseGradingEngineMode(
  value: unknown
): GradingEngineMode | undefined {
  return typeof value === "string" &&
    (GRADING_ENGINE_MODES as readonly string[]).includes(value)
    ? (value as GradingEngineMode)
    : undefined;
}

/** The run snapshot's `gradingEngine`: a `{ mode }` carrier, or nothing. */
type ModeCarrier = { mode?: unknown } | null | undefined;

/**
 * The mode ONE RUN executes at, from the position the backend FROZE onto it.
 *
 * An ABSENT STAMP IS A DECISION, not a missing opinion: the backend writes no
 * `gradingEngine` key at all when it resolved `off`, so that an `off` run's
 * snapshot stays byte-identical to one from before the key existed.
 *
 * A PRESENT stamp this build cannot spell is a decision too. A carrier like
 * `{}`, or one naming a mode a NEWER backend added, is read as the lowest
 * position, because the safe reading of a decision we cannot read is the one
 * that writes and enforces nothing. Inheriting some other value instead is how
 * a typo becomes a promotion.
 */
export function resolveFrozenRunGradingMode(
  runSnapshot: ModeCarrier
): GradingEngineMode {
  return parseGradingEngineMode(runSnapshot?.mode) ?? "off";
}

/**
 * The mode a quick run (Run or Compare on one case in the editor) grades at.
 *
 * A quick run has no suite run, so the backend froze no position for it and
 * there is no stamp to read. It grades at `enforce` so its trial keeps the
 * score rows it is saved with; the `off` an absent stamp resolves to would
 * drop them.
 */
export const QUICK_RUN_GRADING_MODE: GradingEngineMode = "enforce";

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
