/**
 * Exit code for a finished conformance run, shared by every suite.
 *
 * `incomplete` gets its own code because "the server violated the spec" and
 * "we never established anything" are different failures with different fixes,
 * and a run that skipped applicable checks must never look like a pass. `2` is
 * taken by usage errors, so the third state is `3`.
 *
 * The result is read structurally rather than by SDK type so an older
 * `@mcpjam/sdk` (no `outcome`) still maps cleanly through `passed`.
 */
export function conformanceExitCode(result: {
  passed: boolean;
  outcome?: "passed" | "failed" | "incomplete";
}): number {
  if (result.outcome === "incomplete") return 3;
  if (result.outcome === "failed") return 1;
  return result.passed ? 0 : 1;
}

/**
 * A suite runs many flows; its exit code is the worst of them. A failure
 * outranks an incomplete, because a violation is a stronger statement than an
 * unestablished one.
 */
export function conformanceSuiteExitCode(
  results: Array<{ passed: boolean; outcome?: "passed" | "failed" | "incomplete" }>,
): number {
  const codes = results.map(conformanceExitCode);
  if (codes.includes(1)) return 1;
  if (codes.includes(3)) return 3;
  return 0;
}

/**
 * Surface why a run established nothing. The JSON payload carries it too, but
 * a human in a terminal must not have to dig for the reason a check never ran.
 */
export function reportIncomplete(
  result: { incompleteReason?: string },
  command: { optsWithGlobals(): { quiet?: boolean } },
): void {
  const reason = result.incompleteReason;
  if (!reason) return;
  if (command.optsWithGlobals().quiet) return;
  process.stderr.write(`Run incomplete: ${reason}\n`);
}
