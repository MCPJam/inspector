/**
 * Grade a turn's tool calls against its compiled expectations, once.
 *
 * ONE pairing run per turn produces every result. Each assertion, the order
 * row, the extra-calls row and the "no tool" row are read off the same pairing
 * that `evaluateToolCalls` grades with (`pairToolCalls` in `../matchers`), so a
 * greedy corner case cannot resolve one way in a row and another way in the
 * verdict:
 *
 *  - `A({x:"number"})` + `A({x:1})` against `[A({x:1})]` is ONE missing
 *    assertion, because the first assertion takes the only call;
 *  - `A(1), A(2)` against `[A(2), A(1)]` is two satisfied assertions under
 *    `ignore`, and under `strict` or `superset` the order row fails, not the
 *    assertions: the calls happened, in the wrong places.
 *
 * `matcherEquivalent` is today's verdict for the same turn, computed by calling
 * `evaluateToolCalls` on what `stepsToPromptTurns` promotes. It is kept beside
 * the engine's own result so the two can be compared, not so they must agree:
 * they differ where the engine is deliberately stricter (a `minCount`, or an
 * assert's own `argumentMatching`, both of which the promotion drops).
 *
 * Timing: `evaluateAssertionAtPosition` grades one assertion at its authored
 * position, over the calls the turn has made so far. Order, extras and "no
 * tool" only mean something once the turn is over, so they come from
 * `evaluateTurnExpectations`.
 */

import {
  evaluateToolCalls,
  pairToolCalls,
  type EvalArgumentMismatch,
  type EvalToolCall,
} from "../matchers.js";
import { isSkillToolName } from "./skill-tools.js";
import type { ToolExpectationOrder, TurnExpectations } from "./types.js";

/** A call the turn made. `toolCallId` is carried through to the results. */
export type ToolExpectationCall = EvalToolCall & { toolCallId?: string };

export type EvaluateTurnContext = {
  /**
   * Skill tools are advertised: a skill call (`loadSkill`, ...) is agent
   * housekeeping and does not count against the turn's expectations, unless
   * the turn names that skill tool in an assertion.
   */
  skillToolsActive?: boolean;
  /** Which tool names are skill tools. Defaults to this package's list. */
  isSkillTool?: (toolName: string) => boolean;
};

/**
 * Why an assertion failed. `missing`: the tool was not called (or no call was
 * left for this assertion). `arguments`: it was called, with the wrong
 * arguments. Order is never the reason; it has its own row.
 */
export type ToolExpectationFailureKind = "missing" | "arguments";

export type ToolAssertionResult = {
  stepId: string;
  position: number;
  passed: boolean;
  failureKind: ToolExpectationFailureKind | null;
  /** Slots (one per `minCount`) no call satisfied. */
  missingSlots: number;
  /** Slots paired with a same-name call carrying the wrong arguments. */
  argumentMismatchSlots: number;
  /** Slots satisfied only by a call in the wrong place; the order row carries these. */
  outOfOrderSlots: number;
  /** Indexes into the calls passed in, ascending, for the calls this assertion was paired with. */
  pairedCallIndexes: number[];
  /** `toolCallId` of each of those calls that has one. */
  pairedCallIds: string[];
};

export type TurnEvaluation = {
  turnIndex: number;
  assertions: ToolAssertionResult[];
  sequence: {
    passed: boolean;
    mode: ToolExpectationOrder;
    outOfOrderSlots: number;
  };
  extras: { passed: boolean; count: number; cap: number | null };
  negative: { active: boolean; passed: boolean; callCount: number };
  /** Every assertion, the order row, the extras row and the "no tool" row pass. */
  passed: boolean;
  /**
   * Whether today's matcher would pass this turn: `evaluateMultiTurnResults`'
   * per-turn rules over what `stepsToPromptTurns` promotes.
   */
  matcherEquivalent: boolean;
  /** The lists today's matcher reports for this turn, in the shape it reports them. */
  matcher: {
    missing: EvalToolCall[];
    unexpected: EvalToolCall[];
    argumentMismatches: EvalArgumentMismatch[];
  };
};

function normalizeCalls(
  calls: readonly ToolExpectationCall[] | undefined,
): ToolExpectationCall[] {
  return Array.isArray(calls) ? [...calls] : [];
}

/** The calls the matcher sees, and where each one sits in the calls passed in. */
function matchableCalls(
  calls: ToolExpectationCall[],
  exemptionNames: ReadonlySet<string>,
  context: EvaluateTurnContext,
): { matchable: ToolExpectationCall[]; rawIndex: number[] } {
  const isSkill = context.isSkillTool ?? isSkillToolName;
  const matchable: ToolExpectationCall[] = [];
  const rawIndex: number[] = [];
  calls.forEach((call, index) => {
    if (
      context.skillToolsActive === true &&
      isSkill(call.toolName) &&
      !exemptionNames.has(call.toolName)
    ) {
      return;
    }
    matchable.push(call);
    rawIndex.push(index);
  });
  return { matchable, rawIndex };
}

/**
 * Today's per-turn verdict, mirroring `evaluateMultiTurnResults`: a pinned turn
 * is exempt; a negative turn passes iff no call was made; a turn with no
 * expectations passes unless it went past a bounded extras cap; anything else
 * is `evaluateToolCalls` over the promoted expected calls.
 */
function legacyTurnVerdict(
  turn: TurnExpectations,
  matchable: ToolExpectationCall[],
): TurnEvaluation["matcher"] & { passed: boolean } {
  if (turn.pinned) {
    return {
      passed: true,
      missing: [],
      unexpected: [],
      argumentMismatches: [],
    };
  }
  if (turn.negative) {
    return {
      passed: matchable.length === 0,
      missing: [],
      unexpected: matchable,
      argumentMismatches: [],
    };
  }
  if (turn.legacyExpected.length === 0) {
    const over = turn.extrasCap !== null && matchable.length > turn.extrasCap;
    return {
      passed: !over,
      missing: [],
      unexpected: over ? matchable : [],
      argumentMismatches: [],
    };
  }
  const result = evaluateToolCalls(turn.legacyExpected, matchable, {
    toolCallOrder: turn.order,
    maxExtraToolCalls: turn.extrasCap,
    argumentMatching: turn.legacyArgumentMatching,
  });
  return {
    passed: result.passed,
    missing: result.missing,
    unexpected: result.extra,
    argumentMismatches: result.argumentMismatches,
  };
}

type SlotClass = "ok" | "order" | "arguments" | "missing";

function evaluateTurn(
  turn: TurnExpectations,
  rawCalls: readonly ToolExpectationCall[] | undefined,
  context: EvaluateTurnContext,
  /** The names that exempt a skill call. Always the WHOLE turn's, even when only some assertions are graded. */
  exemptionNames: ReadonlySet<string>,
): TurnEvaluation {
  const calls = normalizeCalls(rawCalls);
  const { matchable, rawIndex } = matchableCalls(
    calls,
    exemptionNames,
    context,
  );

  // One slot per `minCount`, adjacent, all owned by one assertion.
  //
  // A slot more than `matchable.length` places into its own assertion is not
  // built: an authored `minCount` of 1e9 must not allocate a billion slots.
  // That drops nothing that could pair. The slots of one assertion are
  // identical and adjacent, and a call goes to at most one slot, so under
  // `ignore` and `superset` a slot that fails to pair ends its assertion's
  // pairing (only `matchable.length` calls exist to hand out), and under
  // `strict` a slot at a global index >= the call count has no call at its
  // index. Assertions after a truncated one start past that index either way,
  // so their alignment is the same. Each dropped slot is counted as missing.
  const slots: EvalToolCall[] = [];
  const slotOwner: number[] = [];
  const droppedSlots: number[] = turn.expectations.map(() => 0);
  const slotsPerAssertion = matchable.length + 1;
  turn.expectations.forEach((expectation, owner) => {
    const built = Math.min(expectation.minCount, slotsPerAssertion);
    droppedSlots[owner] = expectation.minCount - built;
    for (let n = 0; n < built; n++) {
      slots.push({
        toolName: expectation.toolName,
        arguments: expectation.args,
      });
      slotOwner.push(owner);
    }
  });
  const modeOfSlot = (slot: number) =>
    turn.expectations[slotOwner[slot]!]!.argumentMatching;

  const graded = pairToolCalls(slots, matchable, turn.order, modeOfSlot);
  // Order-agnostic pairing over the same slots and calls: it tells a call that
  // never happened from one that happened in the wrong place.
  const agnostic =
    turn.order === "ignore"
      ? graded
      : pairToolCalls(slots, matchable, "ignore", modeOfSlot);
  const gradedMismatch = new Set(graded.argumentMismatchExpected);
  const agnosticMismatch = new Set(agnostic.argumentMismatchExpected);

  const classOfSlot = (slot: number): SlotClass => {
    const lost = !graded.expectedToActual.has(slot) || gradedMismatch.has(slot);
    if (!lost) return "ok";
    if (!agnostic.expectedToActual.has(slot)) return "missing";
    return agnosticMismatch.has(slot) ? "arguments" : "order";
  };

  const assertions: ToolAssertionResult[] = turn.expectations.map(
    (expectation, owner) => {
      let missingSlots = droppedSlots[owner]!;
      let argumentMismatchSlots = 0;
      let outOfOrderSlots = 0;
      const paired = new Set<number>();
      slotOwner.forEach((slotOf, slot) => {
        if (slotOf !== owner) return;
        const cls = classOfSlot(slot);
        if (cls === "missing") missingSlots += 1;
        else if (cls === "arguments") argumentMismatchSlots += 1;
        else if (cls === "order") outOfOrderSlots += 1;
        const call =
          graded.expectedToActual.get(slot) ??
          agnostic.expectedToActual.get(slot);
        if (call !== undefined) paired.add(rawIndex[call]!);
      });
      const invalid = expectation.invalidMinCount === true;
      const failureKind: ToolExpectationFailureKind | null =
        missingSlots > 0 || invalid
          ? "missing"
          : argumentMismatchSlots > 0
            ? "arguments"
            : null;
      const pairedCallIndexes = [...paired].sort((a, b) => a - b);
      return {
        stepId: expectation.stepId,
        position: expectation.position,
        passed: failureKind === null,
        failureKind,
        missingSlots,
        argumentMismatchSlots,
        outOfOrderSlots,
        pairedCallIndexes,
        pairedCallIds: pairedCallIndexes.flatMap((index) => {
          const id = calls[index]?.toolCallId;
          return id === undefined ? [] : [id];
        }),
      };
    },
  );

  const outOfOrderSlots = assertions.reduce(
    (sum, assertion) => sum + assertion.outOfOrderSlots,
    0,
  );
  const extraCount =
    matchable.length - new Set(graded.expectedToActual.values()).size;
  const exempt = turn.pinned;
  const sequence = {
    passed: exempt || outOfOrderSlots === 0,
    mode: turn.order,
    outOfOrderSlots: exempt ? 0 : outOfOrderSlots,
  };
  // A negative turn says no call at all, so a cap on extras is not the rule
  // that applies to it; a pinned call is fixture input.
  const extras = {
    passed:
      exempt ||
      turn.negative ||
      turn.extrasCap === null ||
      extraCount <= turn.extrasCap,
    count: exempt ? 0 : extraCount,
    cap: turn.extrasCap,
  };
  const negative = {
    active: turn.negative && !exempt,
    passed: !turn.negative || exempt || matchable.length === 0,
    callCount: matchable.length,
  };
  const legacy = legacyTurnVerdict(turn, matchable);

  return {
    turnIndex: turn.turnIndex,
    assertions,
    sequence,
    extras,
    negative,
    passed:
      assertions.every((assertion) => assertion.passed) &&
      sequence.passed &&
      extras.passed &&
      negative.passed,
    matcherEquivalent: legacy.passed,
    matcher: {
      missing: legacy.missing,
      unexpected: legacy.unexpected,
      argumentMismatches: legacy.argumentMismatches,
    },
  };
}

function exemptionNamesOf(turn: TurnExpectations): Set<string> {
  return new Set(turn.legacyExpected.map((expected) => expected.toolName));
}

/** Grade one turn, once it is over. */
export function evaluateTurnExpectations(
  turn: TurnExpectations,
  calls: readonly ToolExpectationCall[] | undefined,
  context: EvaluateTurnContext = {},
): TurnEvaluation {
  return evaluateTurn(turn, calls, context, exemptionNamesOf(turn));
}

/**
 * Grade one assertion where the author put it: against the calls the turn has
 * made SO FAR, together with the assertions above it in the same turn (they
 * take calls first, and the pairing is greedy in authored order). An assertion
 * below it does not exist yet. Returns `undefined` for a step that is not one of
 * the turn's expectations.
 *
 * A failed required assertion halts the run at this position, exactly as the
 * step executor's fail-fast does; this only says whether it failed.
 */
export function evaluateAssertionAtPosition(
  turn: TurnExpectations,
  stepId: string,
  callsSoFar: readonly ToolExpectationCall[] | undefined,
  context: EvaluateTurnContext = {},
): ToolAssertionResult | undefined {
  const target = turn.expectations.find(
    (expectation) => expectation.stepId === stepId,
  );
  if (!target) return undefined;
  const visible: TurnExpectations = {
    ...turn,
    expectations: turn.expectations.filter(
      (expectation) => expectation.position <= target.position,
    ),
  };
  // The exemption names stay the whole turn's: an assertion below that names
  // `loadSkill` still means a `loadSkill` call above it is not housekeeping.
  return evaluateTurn(
    visible,
    callsSoFar,
    context,
    exemptionNamesOf(turn),
  ).assertions.find((assertion) => assertion.stepId === stepId);
}

export type ToolExpectationsEvaluation = {
  turns: TurnEvaluation[];
  passed: boolean;
  matcherEquivalent: boolean;
};

/**
 * Grade every turn. `callsByTurn[i]` is the calls turn `i` made, follow-up
 * calls a widget message triggered included, the same bucket the runner keeps.
 */
export function evaluateToolExpectations(
  turns: readonly TurnExpectations[],
  callsByTurn: ReadonlyArray<readonly ToolExpectationCall[] | undefined>,
  context: EvaluateTurnContext = {},
): ToolExpectationsEvaluation {
  const evaluated = turns.map((turn, index) =>
    evaluateTurnExpectations(turn, callsByTurn[index], context),
  );
  return {
    turns: evaluated,
    passed: evaluated.every((turn) => turn.passed),
    matcherEquivalent: evaluated.every((turn) => turn.matcherEquivalent),
  };
}
