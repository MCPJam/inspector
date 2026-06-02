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
   * Trajectory pairing mode for actual vs. expected tool calls.
   *
   * `"ignore"` (default) — order-agnostic greedy pairing: for each expected
   * call in iteration order, the matcher consumes the earliest still-unmatched
   * actual call whose tool name + arguments are compatible. Out-of-order
   * pairings are never flagged.
   *
   * `"strict"` — index-aligned positional match. expected[i] is paired with
   * actual[i] if compatible; otherwise expected[i] is missing. Any extras
   * (j ≥ |expected| or mismatched at index j) are unconsumed actuals.
   *
   * `"superset"` — greedy left-to-right consume. The cursor walks forward
   * through actual once; for each expected call in iteration order, the
   * matcher advances the cursor until it finds a compatible actual call.
   * Useful for "the agent must perform these steps in order, but extra
   * unrelated steps interleaved are fine."
   */
  toolCallOrder?: "ignore" | "strict" | "superset";

  /**
   * Bound on extra actual tool calls beyond what was paired with expected.
   *
   * `null` (default) — extras allowed without bound (previous
   * `allowExtraToolCalls: true` behavior).
   *
   * `0` — strict, no extras allowed (previous `allowExtraToolCalls: false`).
   *
   * `N > 0` (must be a non-negative integer) — up to N extras allowed.
   *
   * Evaluated **independently** of `toolCallOrder`: extras = |actual| − |matched|.
   */
  maxExtraToolCalls?: number | null;

  /**
   * LEGACY: prefer `maxExtraToolCalls`. When present without
   * `maxExtraToolCalls`, the matcher entry shims `true → null`, `false → 0`.
   * Remove after v<NEXT_MINOR>.
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
 *
 * `maxExtraToolCalls: null` preserves the previous `allowExtraToolCalls: true`
 * behavior: extras are reported in `extra[]` but never fail the test by
 * themselves.
 */
export const MATCH_OPTIONS_DEFAULTS: Required<
  Omit<EvalMatchOptions, "allowExtraToolCalls">
> = {
  toolCallOrder: "ignore",
  maxExtraToolCalls: null,
  argumentMatching: "partial",
};

/**
 * Merge match options from suite → case → run-override layers on top of
 * defaults. `undefined` fields inherit from the next layer; explicit
 * values win at their layer. Returns a fully-populated options object
 * suitable to snapshot or pass directly to `evaluateToolCalls`.
 *
 * Legacy `allowExtraToolCalls` on any layer is shimmed to
 * `maxExtraToolCalls` (`true → null`, `false → 0`). An explicit
 * `maxExtraToolCalls` on the same layer wins.
 */
export function resolveMatchOptions(
  suite?: EvalMatchOptions,
  testCase?: EvalMatchOptions,
  runOverride?: EvalMatchOptions,
): Required<Omit<EvalMatchOptions, "allowExtraToolCalls">> {
  const merged: Required<Omit<EvalMatchOptions, "allowExtraToolCalls">> = {
    ...MATCH_OPTIONS_DEFAULTS,
  };
  for (const layer of [suite, testCase, runOverride]) {
    if (!layer) continue;
    if (layer.toolCallOrder !== undefined)
      merged.toolCallOrder = layer.toolCallOrder;
    if (layer.argumentMatching !== undefined)
      merged.argumentMatching = layer.argumentMatching;
    // LEGACY: remove after v<NEXT_MINOR>
    if (layer.maxExtraToolCalls !== undefined) {
      merged.maxExtraToolCalls = layer.maxExtraToolCalls;
    } else if (layer.allowExtraToolCalls !== undefined) {
      merged.maxExtraToolCalls = layer.allowExtraToolCalls ? null : 0;
    }
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
 * Single per-pair predicate: tool name match + argument compatibility
 * under the resolved arg-matching mode. Pulled out so the three
 * trajectory algorithms can share the same `matches(e, a)` primitive.
 */
function callsCompatible(
  expected: EvalToolCall,
  actual: EvalToolCall,
  argumentMatching: NonNullable<EvalMatchOptions["argumentMatching"]>,
): boolean {
  if (expected.toolName !== actual.toolName) return false;
  return argsCompatible(
    expected.arguments || {},
    actual.arguments || {},
    argumentMatching,
  );
}

type PairResult = {
  /** expected index → actual index, for every successful pairing */
  expectedToActual: Map<number, number>;
  /**
   * For `superset` mode only: the actual-index cursor value at the moment
   * pass 1 began searching for each expected index. The diagnostics pass
   * uses this to bound its left edge so it never pairs a still-unmatched
   * expected against an actual that occurred BEFORE the previous
   * successful superset pairing (which would yield wrong "called with
   * wrong args" diagnostics). Indexed by expected position; entries
   * `>= actual.length` mean pass 1 exhausted actuals before this E.
   */
  supersetCursorByExpected?: number[];
};

/**
 * pair(E, A, mode) → { expectedToActual } where unpaired E indices are
 * "missing" and unpaired A indices are "extras". Algorithms below are
 * deterministic by construction; see EvalMatchOptions.toolCallOrder for
 * the per-mode semantics.
 */
function pair(
  expected: EvalToolCall[],
  actual: EvalToolCall[],
  mode: NonNullable<EvalMatchOptions["toolCallOrder"]>,
  argumentMatching: NonNullable<EvalMatchOptions["argumentMatching"]>,
): PairResult {
  const expectedToActual = new Map<number, number>();

  if (mode === "strict") {
    // Index-aligned positional match.
    const min = Math.min(expected.length, actual.length);
    for (let i = 0; i < min; i++) {
      if (callsCompatible(expected[i], actual[i], argumentMatching)) {
        expectedToActual.set(i, i);
      }
    }
    return { expectedToActual };
  }

  if (mode === "superset") {
    // Greedy left-to-right consume: cursor k walks forward through actual,
    // never backtracks. For each expected[i] in order, advance k until
    // a compatible actual is found; pair and k++. Snapshot the cursor at
    // the moment we begin scanning for each expected[i] so the
    // diagnostics pass can preserve the same left-bound and not regress
    // into actuals before the previous successful pairing.
    let k = 0;
    const supersetCursorByExpected: number[] = new Array(expected.length);
    for (let i = 0; i < expected.length; i++) {
      supersetCursorByExpected[i] = k;
      while (k < actual.length) {
        if (callsCompatible(expected[i], actual[k], argumentMatching)) {
          expectedToActual.set(i, k);
          k++;
          break;
        }
        k++;
      }
      if (k >= actual.length) {
        // Remaining expected[i+1..] are missing; record the exhausted cursor
        // for them too so pass 2 leaves their left-bound at actual.length.
        for (let j = i + 1; j < expected.length; j++) {
          supersetCursorByExpected[j] = k;
        }
        break;
      }
    }
    return { expectedToActual, supersetCursorByExpected };
  }

  // mode === "ignore": greedy by expected iteration order over unconsumed
  // A indices. NB: not a bipartite max-cardinality matcher — when
  // placeholder polymorphism creates non-obvious assignments, the greedy
  // can theoretically fail to find a pairing that bipartite would. Order
  // expected calls most-specific to least-specific to avoid this in
  // practice. See plan §"Precise semantics" / Phase 1.
  const consumedActual = new Set<number>();
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < actual.length; j++) {
      if (consumedActual.has(j)) continue;
      if (callsCompatible(expected[i], actual[j], argumentMatching)) {
        expectedToActual.set(i, j);
        consumedActual.add(j);
        break;
      }
    }
  }
  return { expectedToActual };
}

/**
 * Validate `maxExtraToolCalls`. Throws on values v8/JSON would accept as
 * a number but the matcher cannot honor (negative, fractional, NaN,
 * Infinity). Called from the matcher entry point; UI / mutation layers
 * should reject earlier with their own error type.
 */
function assertValidMaxExtra(value: number | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid maxExtraToolCalls: ${value}. Must be null (unlimited) or a non-negative integer.`,
    );
  }
}

/**
 * Evaluate actual tool calls against expected.
 *
 * Defaults preserve today's inspector behavior precisely:
 *   - `toolCallOrder: "ignore"` (order does not matter)
 *   - `maxExtraToolCalls: null` (extras reported but non-fatal)
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

  // LEGACY: shim allowExtraToolCalls → maxExtraToolCalls at the entry
  // when only the legacy field is supplied. Remove after v<NEXT_MINOR>.
  let maxExtraToolCalls: number | null;
  if (options?.maxExtraToolCalls !== undefined) {
    maxExtraToolCalls = options.maxExtraToolCalls;
  } else if (options?.allowExtraToolCalls !== undefined) {
    maxExtraToolCalls = options.allowExtraToolCalls ? null : 0;
  } else {
    maxExtraToolCalls = MATCH_OPTIONS_DEFAULTS.maxExtraToolCalls;
  }
  assertValidMaxExtra(maxExtraToolCalls);

  const toolCallOrder =
    options?.toolCallOrder ?? MATCH_OPTIONS_DEFAULTS.toolCallOrder;
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

  // Pass 1: trajectory-aware pairing on toolName + args.
  const { expectedToActual, supersetCursorByExpected } = pair(
    normalizedExpected,
    normalizedActual,
    toolCallOrder,
    argumentMatching,
  );
  const matchedExpectedIndices = new Set<number>(expectedToActual.keys());
  const matchedActualIndices = new Set<number>(expectedToActual.values());
  const argumentMismatches: EvalArgumentMismatch[] = [];

  // Pass 2: for any still-unpaired expected, scan unconsumed actuals for
  // a same-name pairing and report it as an argument mismatch. This keeps
  // the "tool was called with wrong args" diagnostic that existed before
  // the trajectory rework. Order of scan mirrors the per-mode primitive:
  // strict checks the same index; superset preserves the pass 1 cursor so
  // a missing-expected is never paired against an actual that occurred
  // before the previous successful superset match; ignore scans
  // left-to-right.
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    if (matchedExpectedIndices.has(ei)) continue;
    const exp = normalizedExpected[ei];
    const expectedArgs = exp.arguments || {};

    // In strict mode, only the same-index actual is eligible. In superset,
    // start the scan at the pass 1 cursor for this expected — anything to
    // the left of it was already considered (and skipped or consumed) by
    // pass 1's monotonic walk. In ignore, any unconsumed actual is eligible.
    let scanStart = 0;
    let scanEnd = normalizedActual.length;
    if (toolCallOrder === "strict") {
      scanStart = ei;
      scanEnd = Math.min(ei + 1, normalizedActual.length);
    } else if (toolCallOrder === "superset" && supersetCursorByExpected) {
      scanStart = Math.min(
        supersetCursorByExpected[ei] ?? 0,
        normalizedActual.length,
      );
    }

    for (let ai = scanStart; ai < scanEnd; ai++) {
      if (matchedActualIndices.has(ai)) continue;
      const act = normalizedActual[ai];
      if (act.toolName !== exp.toolName) continue;
      const actualArgs = act.arguments || {};

      matchedExpectedIndices.add(ei);
      matchedActualIndices.add(ai);
      expectedToActual.set(ei, ai);

      // We're in Pass 2 because callsCompatible already returned false in
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

  // Order analysis is folded into the per-mode primitive: `strict` only
  // pairs at the same index, so it can't produce out-of-order pairings;
  // `superset` advances monotonically by construction. `outOfOrder` is
  // retained in the result shape (and stays empty for the new modes) for
  // backward compatibility with consumers that read the field.
  const outOfOrder: EvalOutOfOrderToolCall[] = [];

  const missing = normalizedExpected.filter(
    (_, idx) => !matchedExpectedIndices.has(idx),
  );
  const extra = normalizedActual.filter(
    (_, idx) => !matchedActualIndices.has(idx),
  );

  // Extras gate is independent of toolCallOrder. `null` = unlimited; a
  // non-negative integer caps the count.
  const extraFails =
    maxExtraToolCalls !== null && extra.length > maxExtraToolCalls;
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
