/**
 * The shared model behind "a tool-call expectation is one visible assertion".
 *
 * `compile` reads AUTHORED steps and produces, per turn, the tool-call
 * assertions the author wrote, with everything the older
 * `stepsToPromptTurns` → `expectedToolCalls` projection dropped: the step id,
 * its position, its own argument mode and its `minCount`. `evaluate` grades a
 * turn's calls against that once, through the matcher's own pairing, and
 * reports one result per assertion plus the turn-level facts a reader needs
 * (order, extra calls, "no tool").
 *
 * Nothing in here judges an expectation on its own. Whether `A({x:"number"})`
 * and `A({x:1})` can both be satisfied by one `A({x:1})` call is a property of
 * the pairing, not of either assertion, so every result comes out of one
 * pairing run per turn.
 */

import type { EvalMatchOptions } from "../matchers.js";

export type ToolExpectationOrder = NonNullable<
  EvalMatchOptions["toolCallOrder"]
>;
export type ToolExpectationArgumentMode = NonNullable<
  EvalMatchOptions["argumentMatching"]
>;

/**
 * The step shapes `compile` reads. Structural on purpose: the SDK's `TestStep`
 * satisfies it, and this package cannot import the SDK. Only the `kind`
 * decides how a step groups into turns, and only an `assert` carries anything
 * `compile` looks at.
 */
export type ToolExpectationStep =
  | { id: string; kind: "prompt" | "toolCall" | "interact" }
  | { id: string; kind: "assert"; assertion: unknown };

/** One required `toolCalledWith` assert, as authored. */
export type ToolExpectation = {
  stepId: string;
  /** Index of the assert in the flat authored step list. */
  position: number;
  toolName: string;
  args: Record<string, unknown>;
  /** The assert's own mode when it set one, else the case's. */
  argumentMatching: ToolExpectationArgumentMode;
  /**
   * How many pairing slots this assert occupies: its `minCount`, or 1. The
   * slots are adjacent and all belong to this assert.
   */
  minCount: number;
  /**
   * The authored `minCount` is not a positive integer. The predicate
   * evaluator fails such an assert closed (`>= 0` would disable the gate), so
   * the engine does too. `minCount` above is 1 in that case, so the assert
   * still occupies one slot and the pairing of its neighbours is unchanged.
   */
  invalidMinCount?: true;
};

/** One turn's expectations and the case-level options that grade them. */
export type TurnExpectations = {
  /** The turn's index, the same one `stepsToPromptTurns` assigns. */
  turnIndex: number;
  /**
   * The `prompt` / `toolCall` step that opened the turn. Absent for the
   * implicit turn a leading `interact` or `assert` opens.
   */
  openedBy?: string;
  /**
   * The turn is a pinned (`toolCall`) step: the call is fixture input, exempt
   * from order, extra-call and "no tool" grading.
   */
  pinned: boolean;
  expectations: ToolExpectation[];
  order: ToolExpectationOrder;
  /** `null` is unbounded. */
  extrasCap: number | null;
  negative: boolean;
  /**
   * What today's `stepsToPromptTurns` promotes from the same asserts: one
   * expected call per assert, `minCount` and the assert's own argument mode
   * dropped. Kept only so `evaluate` can report `matcherEquivalent`.
   */
  legacyExpected: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  /** The single argument mode today's matcher grades every expected call under. */
  legacyArgumentMatching: ToolExpectationArgumentMode;
};

export type CompileToolExpectationsOptions = {
  /** The case's resolved match options. Legacy `allowExtraToolCalls` is honoured. */
  matchOptions?: EvalMatchOptions;
  isNegativeTest?: boolean;
};
