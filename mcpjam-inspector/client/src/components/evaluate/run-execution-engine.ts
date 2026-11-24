import type { EvalSuiteRun } from "../evals/types";

/**
 * The run's recorded engine, if any.
 *
 * Top-level wins (API-projected rows), then the snapshot. Absence is
 * UNKNOWN, not emulated, and the caller decides how to treat it.
 */
export function readRunExecutionEngine(
  run: Pick<EvalSuiteRun, "executionEngine" | "configSnapshot">,
): string | undefined {
  if (typeof run.executionEngine === "string" && run.executionEngine) {
    return run.executionEngine;
  }
  const snap = run.configSnapshot?.executionEngine;
  if (typeof snap === "string" && snap) return snap;
  return undefined;
}
