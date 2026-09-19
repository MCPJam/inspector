/**
 * Argument matching for the `toolCalledWith` predicate.
 *
 * Delegates to the same `evaluateToolCalls` engine the tool-call matcher uses,
 * exposing all three `argumentMatching` modes (`exact` | `partial` | `ignore`).
 * Reusing one engine guarantees a predicate's notion of "these args match" is
 * identical to the existing `expectedToolCalls` matcher's.
 */

import { evaluateToolCalls } from "../matchers.js";
import type { ArgMatcher } from "./types.js";

/** Sentinel tool name so the single-pair match isolates argument comparison. */
const PROBE = "__predicate_arg_probe__";

/**
 * True iff `actualArgs` satisfies `matcher` under its `argumentMatching` mode
 * (default `"partial"`).
 */
export function argMatch(
  matcher: ArgMatcher,
  actualArgs: Record<string, unknown>,
): boolean {
  const argumentMatching = matcher.argumentMatching ?? "partial";
  const result = evaluateToolCalls(
    [{ toolName: PROBE, arguments: matcher.args ?? {} }],
    [{ toolName: PROBE, arguments: actualArgs ?? {} }],
    { argumentMatching },
  );
  // Single expected + single actual call with the same probe name: `passed`
  // reflects solely whether the arguments were compatible under the mode.
  return result.passed;
}
