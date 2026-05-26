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

/**
 * Canonical defaults for {@link EvalMatchOptions}. Exported so the
 * inspector server, client, and tests share a single source of truth
 * with `evaluateToolCalls` instead of redefining the same literals.
 */
export const MATCH_OPTIONS_DEFAULTS: Required<EvalMatchOptions> = {
  toolCallOrder: "ignore",
  allowExtraToolCalls: true,
  argumentMatching: "partial",
};

/**
 * Merge match options from suite → case → run-override layers on top of
 * defaults. `undefined` fields inherit from the next layer; explicit
 * values win at their layer. Returns a fully-populated options object
 * suitable to snapshot or pass directly to `evaluateToolCalls`.
 */
export function resolveMatchOptions(
  suite?: EvalMatchOptions,
  testCase?: EvalMatchOptions,
  runOverride?: EvalMatchOptions,
): Required<EvalMatchOptions> {
  const merged: Required<EvalMatchOptions> = { ...MATCH_OPTIONS_DEFAULTS };
  for (const layer of [suite, testCase, runOverride]) {
    if (!layer) continue;
    if (layer.toolCallOrder !== undefined)
      merged.toolCallOrder = layer.toolCallOrder;
    if (layer.allowExtraToolCalls !== undefined)
      merged.allowExtraToolCalls = layer.allowExtraToolCalls;
    if (layer.argumentMatching !== undefined)
      merged.argumentMatching = layer.argumentMatching;
  }
  return merged;
}

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

/**
 * Stable JSON stringify: sorts object keys recursively so deep-equality
 * via string compare is order-insensitive. Tool args produced by
 * different runtimes routinely come back with keys in a different order
 * (e.g. AI SDK vs MCP server vs hand-authored expected), so a naive
 * `JSON.stringify` compare would report false mismatches.
 *
 * No Date / cyclic ref handling — tool args are plain JSON in practice.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
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
    if (!deepEqual(actualArgs[key], value)) {
      return false;
    }
  }
  return true;
}

function exactArgumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean {
  return deepEqual(expectedArgs, actualArgs);
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

  const toolCallOrder =
    options?.toolCallOrder ?? MATCH_OPTIONS_DEFAULTS.toolCallOrder;
  const allowExtraToolCalls =
    options?.allowExtraToolCalls ?? MATCH_OPTIONS_DEFAULTS.allowExtraToolCalls;
  const argumentMatching =
    options?.argumentMatching ?? MATCH_OPTIONS_DEFAULTS.argumentMatching;

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
