/**
 * Eval tool-call matchers.
 *
 * This module is browser-safe and intentionally has no node-only deps so
 * it can be imported into client bundles via `@mcpjam/sdk/matchers`.
 *
 * `evaluateToolCalls` is a richer, configurable replacement for the
 * existing `matchToolCalls(expected: string[], actual: string[]): boolean`
 * in `./validators`. The simple boolean API in `./validators` stays
 * unchanged for SDK consumers that already depend on it.
 */

import type { ToolCall } from "./types.js";

export type EvalToolCall = ToolCall;

export type EvalArgumentMismatch = {
  toolName: string;
  expectedArgs: Record<string, unknown>;
  actualArgs: Record<string, unknown>;
};

export type EvalOutOfOrderToolCall = {
  toolName: string;
  expectedIndex: number;
  actualIndex: number;
};

export type EvalMatchOptions = {
  /**
   * `"ignore"` (default) — order of tool calls is not checked; `outOfOrder`
   * is always empty.
   *
   * `"strict"` — actual tool calls must appear in the same relative order
   * as `expected` for matched pairs; out-of-order matches are reported and
   * fail the test.
   */
  toolCallOrder?: "ignore" | "strict";

  /**
   * `true` (default) — actual calls beyond what's expected are reported in
   * `extra[]` but do NOT fail the test (current inspector behavior).
   *
   * `false` — any extra actual call fails the test.
   */
  allowExtraToolCalls?: boolean;

  /**
   * `"partial"` (default) — only expected keys are checked; actual may
   * carry extra keys; empty expected args match anything; placeholder
   * strings like `"string"`, `"number"`, `"any"` are interpreted as type
   * checks (matches current inspector behavior).
   *
   * `"exact"` — deep equality on the args object; no extras allowed; no
   * placeholders.
   *
   * `"ignore"` — args are not compared.
   */
  argumentMatching?: "exact" | "partial" | "ignore";
};

export type EvalToolCallMatchResult = {
  missing: EvalToolCall[];
  extra: EvalToolCall[];
  outOfOrder: EvalOutOfOrderToolCall[];
  argumentMismatches: EvalArgumentMismatch[];
  passed: boolean;
};

type ArgumentPlaceholder =
  | "any"
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

function matchArgumentPlaceholder(
  expectedValue: unknown,
  actualValue: unknown,
): boolean | null {
  if (typeof expectedValue !== "string") return null;
  switch (expectedValue.trim().toLowerCase() as ArgumentPlaceholder) {
    case "any":
      return actualValue !== undefined;
    case "string":
      return typeof actualValue === "string";
    case "number":
      return typeof actualValue === "number";
    case "boolean":
      return typeof actualValue === "boolean";
    case "object":
      return (
        actualValue !== null &&
        typeof actualValue === "object" &&
        !Array.isArray(actualValue)
      );
    case "array":
      return Array.isArray(actualValue);
    case "null":
      return actualValue === null;
    default:
      return null;
  }
}

function partialArgumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(expectedArgs)) {
    const placeholder = matchArgumentPlaceholder(value, actualArgs[key]);
    if (placeholder !== null) {
      if (!placeholder) return false;
      continue;
    }
    if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
}

function exactArgumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean {
  // Cheapest deep-equal that's good enough for tool args (no Dates, no
  // cyclic refs in practice).
  return JSON.stringify(expectedArgs) === JSON.stringify(actualArgs);
}

function argsCompatible(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
  mode: NonNullable<EvalMatchOptions["argumentMatching"]>,
): boolean {
  if (mode === "ignore") return true;
  if (mode === "partial") {
    if (Object.keys(expectedArgs).length === 0) return true;
    return partialArgumentsMatch(expectedArgs, actualArgs);
  }
  return exactArgumentsMatch(expectedArgs, actualArgs);
}

/**
 * Evaluate actual tool calls against expected.
 *
 * Defaults preserve today's inspector behavior precisely:
 *   - `toolCallOrder: "ignore"` (order does not matter)
 *   - `allowExtraToolCalls: true` (extra calls reported but non-fatal)
 *   - `argumentMatching: "partial"` (placeholders, empty-expected matches
 *     anything, extras allowed on actual args)
 *
 * Pass `isNegativeTest: true` to flip the test: it then passes iff *no*
 * tool calls were made.
 */
export function evaluateToolCalls(
  expected: EvalToolCall[],
  actual: EvalToolCall[],
  options?: EvalMatchOptions & { isNegativeTest?: boolean },
): EvalToolCallMatchResult {
  const normalizedExpected = Array.isArray(expected) ? expected : [];
  const normalizedActual = Array.isArray(actual) ? actual : [];

  const toolCallOrder = options?.toolCallOrder ?? "ignore";
  const allowExtraToolCalls = options?.allowExtraToolCalls ?? true;
  const argumentMatching = options?.argumentMatching ?? "partial";

  if (options?.isNegativeTest) {
    return {
      missing: [],
      extra: normalizedActual,
      outOfOrder: [],
      argumentMismatches: [],
      passed: normalizedActual.length === 0,
    };
  }

  if (normalizedActual.length === 0) {
    // Positive test: matches today's inspector behavior — any empty-actual
    // positive run fails, including the both-empty case. Callers that want
    // "no expected + no actual = pass" should mark the case as negative or
    // pass `argumentMatching: "ignore"` and check counts themselves.
    return {
      missing: normalizedExpected,
      extra: [],
      outOfOrder: [],
      argumentMismatches: [],
      passed: false,
    };
  }

  // Track expected->actual index pairs to enable order analysis.
  const matchedActualIndices = new Set<number>();
  const matchedExpectedIndices = new Set<number>();
  const expectedToActualIndex = new Map<number, number>();
  const argumentMismatches: EvalArgumentMismatch[] = [];

  // Pass 1: match by toolName + args.
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    const exp = normalizedExpected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < normalizedActual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;
      const act = normalizedActual[ai];
      if (act.toolName !== exp.toolName) continue;
      const actualArgs = act.arguments || {};

      if (argsCompatible(expectedArgs, actualArgs, argumentMatching)) {
        matchedActualIndices.add(ai);
        matchedExpectedIndices.add(ei);
        expectedToActualIndex.set(ei, ai);
        break;
      }
    }
  }

  // Pass 2: match remaining expected by toolName only -> argument mismatches.
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    if (matchedExpectedIndices.has(ei)) continue;
    const exp = normalizedExpected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < normalizedActual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;
      const act = normalizedActual[ai];
      if (act.toolName !== exp.toolName) continue;
      const actualArgs = act.arguments || {};

      matchedActualIndices.add(ai);
      matchedExpectedIndices.add(ei);
      expectedToActualIndex.set(ei, ai);

      // We're in Pass 2 because argsCompatible already returned false in
      // Pass 1, so any non-"ignore" mode here is a real argument mismatch
      // — including the exact-mode case where expected is {} but actual is
      // non-empty (partial mode never reaches here with empty expected
      // since argsCompatible short-circuits to true).
      if (argumentMatching !== "ignore") {
        argumentMismatches.push({
          toolName: exp.toolName,
          expectedArgs,
          actualArgs,
        });
      }
      break;
    }
  }

  // Order analysis: actual indices for matched expected calls should be
  // monotonically non-decreasing. If they aren't, those calls are out of
  // order. We walk pairs in expected order and flag any actual index that
  // dips below the running max.
  const outOfOrder: EvalOutOfOrderToolCall[] = [];
  if (toolCallOrder === "strict") {
    let highestActual = -1;
    for (let ei = 0; ei < normalizedExpected.length; ei++) {
      const ai = expectedToActualIndex.get(ei);
      if (ai === undefined) continue;
      if (ai < highestActual) {
        outOfOrder.push({
          toolName: normalizedExpected[ei].toolName,
          expectedIndex: ei,
          actualIndex: ai,
        });
      } else {
        highestActual = ai;
      }
    }
  }

  const missing = normalizedExpected.filter(
    (_, idx) => !matchedExpectedIndices.has(idx),
  );
  const extra = normalizedActual.filter(
    (_, idx) => !matchedActualIndices.has(idx),
  );

  const extraFails = !allowExtraToolCalls && extra.length > 0;
  const passed =
    missing.length === 0 &&
    argumentMismatches.length === 0 &&
    outOfOrder.length === 0 &&
    !extraFails;

  return {
    missing,
    extra,
    outOfOrder,
    argumentMismatches,
    passed,
  };
}
