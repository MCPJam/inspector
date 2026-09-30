/**
 * Compile authored steps into per-turn tool expectations.
 *
 * Reads the AUTHORED steps rather than the `promptTurns` projection, because
 * that projection has already lost what a per-assertion result needs: the step
 * id, its position, the assert's `minCount` and its own `argumentMatching`.
 *
 * Turn grouping mirrors `stepsToPromptTurns` and `stepTurnIndices` in the
 * inspector: a `prompt` or `toolCall` step opens a turn, later `interact` and
 * `assert` steps fold into the turn that is open, and one that comes before any
 * turn opens an implicit one. A `turnIndex` here is the index the runner buckets
 * that turn's tool calls under.
 */

import {
  MATCH_OPTIONS_DEFAULTS,
  assertValidMaxExtra,
  type EvalMatchOptions,
} from "../matchers.js";
import { checkRole } from "../predicates/policy.js";
import type {
  CompileToolExpectationsOptions,
  ToolExpectation,
  ToolExpectationArgumentMode,
  ToolExpectationStep,
  TurnExpectations,
} from "./types.js";

const ARGUMENT_MODES: readonly string[] = ["exact", "partial", "ignore"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The extras cap, from the same precedence `evaluateToolCalls` and the
 * inspector's `resolveExtrasCap` use: an explicit `maxExtraToolCalls` wins,
 * else legacy `allowExtraToolCalls: false` is 0, else unbounded. Throws on a
 * cap the matcher cannot honour, exactly as `evaluateToolCalls` does.
 */
function extrasCapOf(options: EvalMatchOptions | undefined): number | null {
  let cap: number | null;
  if (options?.maxExtraToolCalls !== undefined) {
    cap = options.maxExtraToolCalls;
  } else if (options?.allowExtraToolCalls !== undefined) {
    cap = options.allowExtraToolCalls ? null : 0;
  } else {
    cap = MATCH_OPTIONS_DEFAULTS.maxExtraToolCalls;
  }
  assertValidMaxExtra(cap);
  return cap;
}

/**
 * The expectation a step authors, or `undefined` when it is not one: only a
 * required (non-advisory) transcript-level `toolCalledWith` is a tool-call
 * expectation. An advisory one stays an ordinary predicate, and a widget
 * assertion carries `kind`, not `type`.
 */
function expectationOf(
  step: ToolExpectationStep,
  position: number,
  caseArgumentMatching: ToolExpectationArgumentMode
): ToolExpectation | undefined {
  if (step.kind !== "assert") return undefined;
  const assertion = asRecord(step.assertion);
  if (
    !assertion ||
    assertion.type !== "toolCalledWith" ||
    checkRole(assertion) === "advisory"
  ) {
    return undefined;
  }
  const matcher = asRecord(assertion.args);
  const own = matcher?.argumentMatching;
  const argumentMatching: ToolExpectationArgumentMode =
    typeof own === "string" && ARGUMENT_MODES.includes(own)
      ? (own as ToolExpectationArgumentMode)
      : caseArgumentMatching;
  const authored = assertion.minCount;
  const valid =
    authored === undefined ||
    (typeof authored === "number" &&
      Number.isInteger(authored) &&
      authored >= 1);
  return {
    stepId: step.id,
    position,
    toolName: typeof assertion.toolName === "string" ? assertion.toolName : "",
    args: asRecord(matcher?.args) ?? {},
    argumentMatching,
    minCount: valid && typeof authored === "number" ? authored : 1,
    ...(valid ? {} : { invalidMinCount: true as const }),
  };
}

export function compileToolExpectations(
  steps: readonly ToolExpectationStep[],
  options: CompileToolExpectationsOptions = {}
): TurnExpectations[] {
  const order =
    options.matchOptions?.toolCallOrder ?? MATCH_OPTIONS_DEFAULTS.toolCallOrder;
  const caseArgumentMatching =
    options.matchOptions?.argumentMatching ??
    MATCH_OPTIONS_DEFAULTS.argumentMatching;
  const extrasCap = extrasCapOf(options.matchOptions);
  const negative = options.isNegativeTest === true;

  const turns: TurnExpectations[] = [];
  let current: TurnExpectations | undefined;
  const open = (openedBy: string | undefined, pinned: boolean) => {
    current = {
      turnIndex: turns.length,
      ...(openedBy !== undefined ? { openedBy } : {}),
      pinned,
      expectations: [],
      order,
      extrasCap,
      negative,
      legacyExpected: [],
      legacyArgumentMatching: caseArgumentMatching,
    };
    turns.push(current);
    return current;
  };

  steps.forEach((step, position) => {
    if (step.kind === "prompt") {
      open(step.id, false);
    } else if (step.kind === "toolCall") {
      open(step.id, true);
    } else {
      const turn = current ?? open(undefined, false);
      const expectation = expectationOf(step, position, caseArgumentMatching);
      if (expectation) {
        turn.expectations.push(expectation);
        turn.legacyExpected.push({
          toolName: expectation.toolName,
          arguments: expectation.args,
        });
      }
    }
  });
  return turns;
}
