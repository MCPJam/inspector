import {
  describeConformanceScore,
  type ConformanceScore,
} from "@mcpjam/sdk";

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
/**
 * The score line, one per run. Same channel discipline as its siblings:
 * stderr so JSON stdout stays parseable, suppressed by `--quiet`, and no
 * effect on exit codes — the score annotates the verdict, it does not
 * replace it.
 */
export function reportScore(
  score: ConformanceScore,
  command: { optsWithGlobals(): { quiet?: boolean } },
  label?: string,
): void {
  if (command.optsWithGlobals().quiet) return;
  process.stderr.write(
    `Score${label ? ` [${label}]` : ""}: ${describeConformanceScore(score)}\n`,
  );
}

/**
 * Surface the readiness channel (SHOULD/RECOMMENDED/MAY advice) for a human.
 * Advice lives beside the verdict, never inside it: it goes to stderr like
 * {@link reportIncomplete}, affects no exit code, and is read structurally so
 * an older `@mcpjam/sdk` (no `readiness`) simply prints nothing.
 */
export function reportReadiness(
  result: {
    readiness?: Array<{
      specStrength: string;
      title: string;
      message: string;
    }>;
  },
  command: { optsWithGlobals(): { quiet?: boolean } },
): void {
  const readiness = result.readiness ?? [];
  if (readiness.length === 0) return;
  if (command.optsWithGlobals().quiet) return;
  process.stderr.write(`Advice (${readiness.length}):\n`);
  for (const advice of readiness) {
    process.stderr.write(
      `  [${advice.specStrength}] ${advice.title}: ${advice.message}\n`,
    );
  }
}

export function reportIncomplete(
  result: { incompleteReason?: string },
  command: { optsWithGlobals(): { quiet?: boolean } },
): void {
  const reason = result.incompleteReason;
  if (!reason) return;
  if (command.optsWithGlobals().quiet) return;
  process.stderr.write(`Run incomplete: ${reason}\n`);
}
