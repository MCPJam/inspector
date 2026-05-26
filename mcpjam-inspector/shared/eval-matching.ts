/**
 * Shared tool call matching for the inspector.
 *
 * Thin re-export of the richer `evaluateToolCalls` matcher from the SDK
 * (`@mcpjam/sdk/matchers`, a browser-safe subpath). The historical
 * `matchToolCalls` function and `ToolCallMatchResult` type are preserved
 * as compatibility aliases so existing inspector call sites keep working
 * unchanged — call sites can migrate to `evaluateToolCalls` deliberately.
 *
 * Defaults preserve today's inspector behavior precisely:
 *   - order-agnostic
 *   - extra/unexpected calls reported but non-fatal
 *   - partial argument matching with placeholder type checks (e.g.
 *     `"string"` matches any string)
 */

import { z } from "zod";
import {
  evaluateToolCalls,
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
  type EvalArgumentMismatch,
  type EvalMatchOptions,
  type EvalOutOfOrderToolCall,
  type EvalToolCall,
  type EvalToolCallMatchResult,
} from "@mcpjam/sdk/matchers";

export type ToolCall = EvalToolCall;
export type ArgumentMismatch = EvalArgumentMismatch;
export type OutOfOrderToolCall = EvalOutOfOrderToolCall;

/**
 * Zod schema mirroring `EvalMatchOptions` for transport boundaries
 * (HTTP request bodies, Convex args). Keep field names + value enums in
 * lockstep with `@mcpjam/sdk/matchers`.
 */
export const matchOptionsSchema = z
  .object({
    toolCallOrder: z.enum(["ignore", "strict"]).optional(),
    allowExtraToolCalls: z.boolean().optional(),
    argumentMatching: z.enum(["exact", "partial", "ignore"]).optional(),
  })
  .strict();

/**
 * Transport DTO — narrow Pick from the SDK type so server/client wire
 * payloads import a stable name from this boundary module.
 */
export type MatchOptionsDTO = z.infer<typeof matchOptionsSchema>;

/**
 * Inspector-shaped result that the existing tests + UI consume.
 *
 * Note: the inspector has historically used `unexpected` as the field
 * name; the SDK matcher returns `extra`. We surface both here so the
 * field rename can happen gradually. New code should prefer
 * `evaluateToolCalls()` directly and read `extra` + `outOfOrder`.
 */
export type ToolCallMatchResult = {
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: ArgumentMismatch[];
  passed: boolean;
};

export type { EvalMatchOptions, EvalToolCallMatchResult };
export { evaluateToolCalls, MATCH_OPTIONS_DEFAULTS, resolveMatchOptions };

/**
 * Compatibility alias for the inspector's historical matcher.
 *
 * Returns the legacy shape (missing/unexpected/argumentMismatches/passed)
 * by delegating to {@link evaluateToolCalls} with the default
 * order-agnostic / extras-allowed / partial-args options.
 *
 * Prefer {@link evaluateToolCalls} in new code.
 */
export function matchToolCalls(
  expected: ToolCall[],
  actual: ToolCall[],
  isNegativeTest?: boolean,
): ToolCallMatchResult {
  const result = evaluateToolCalls(expected, actual, {
    isNegativeTest,
  });
  return {
    missing: result.missing,
    unexpected: result.extra,
    argumentMismatches: result.argumentMismatches,
    passed: result.passed,
  };
}

/**
 * Argument compatibility check kept for callers that depended on the
 * standalone helper. Implements partial-match semantics with placeholder
 * type checks (matches today's behavior).
 */
export function argumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean {
  const result = evaluateToolCalls(
    [{ toolName: "__probe__", arguments: expectedArgs }],
    [{ toolName: "__probe__", arguments: actualArgs }],
  );
  return result.argumentMismatches.length === 0;
}
