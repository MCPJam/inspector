import type { ServerFeatureEvidenceState } from "./use-server-feature-evidence";

/** The Overview tab's capability names and the features behind them. */
const OVERVIEW_CAPABILITIES = [
  ["Tools", "tools.capability"],
  ["Prompts", "prompts.capability"],
  ["Resources", "resources.capability"],
  ["Skills", "skills.declaration"],
] as const;

/**
 * With the canvas on, Overview lists the capabilities the evaluator calls
 * Supported instead of reading `initializationInfo` itself, so the two views
 * never disagree. While the saved evidence loads, after a failed read and
 * before the first capture the evaluator has nothing to go on, so this
 * returns `undefined` and Overview keeps its own reading.
 */
export function overviewCapabilities(
  evidence: Pick<
    ServerFeatureEvidenceState,
    "status" | "selected" | "evaluation"
  >,
): string[] | undefined {
  const { status, selected, evaluation } = evidence;
  if (status !== "ready" || selected.capturedAt === undefined) return undefined;
  return OVERVIEW_CAPABILITIES.filter(
    ([, featureId]) => evaluation.assessments[featureId]?.state === "supported",
  ).map(([label]) => label);
}
