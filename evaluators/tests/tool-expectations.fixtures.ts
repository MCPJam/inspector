/**
 * The counterexample corpus for the tool-expectation engine.
 *
 * Plain data on purpose: the evaluators suite runs it against the engine and
 * the bare matcher, and the inspector runs the SAME list through its real
 * `stepsToPromptTurns` + `evaluateMultiTurnResults` (the hosted verdict today),
 * so "today's verdict" is a property of the real code, not of a copy of it.
 *
 * Each turn states three things: what the engine reports (`engine`), what
 * today's matcher reports (`matcher`), and — when they differ on purpose —
 * why (`intendedDifference`). A fixture that does not name an intended
 * difference asserts the two agree, so an accidental divergence fails here.
 */

import type { EvalMatchOptions } from "../src/matchers";
import type {
  ToolExpectationCall,
  ToolExpectationStep,
} from "../src/tool-expectations";

export type FixtureAssertionOutcome = "pass" | "missing" | "arguments";

export type FixtureTurnExpectation = {
  /** Outcome per assertion step id. Only the ids listed are checked. */
  assertions?: Record<string, FixtureAssertionOutcome>;
  /** `false` = the order row fails. Omitted = not asserted. */
  sequence?: boolean;
  extras?: boolean;
  negative?: boolean;
  /** The engine's verdict for the turn. */
  passed: boolean;
};

export type ToolExpectationFixture = {
  name: string;
  steps: ToolExpectationStep[];
  matchOptions?: EvalMatchOptions;
  isNegativeTest?: boolean;
  skillToolsActive?: boolean;
  /** The calls each turn made, indexed by turn. */
  callsByTurn: ToolExpectationCall[][];
  /** Per turn, what the engine reports. */
  engine: FixtureTurnExpectation[];
  /** Per turn, whether today's matcher passes. */
  matcher: boolean[];
  /**
   * Set when the engine's turn verdict differs from today's matcher on
   * purpose. Every turn where they differ must be covered by this.
   */
  intendedDifference?: string;
};

export const prompt = (id: string): ToolExpectationStep => ({
  id,
  kind: "prompt",
});
export const pinnedCall = (id: string): ToolExpectationStep => ({
  id,
  kind: "toolCall",
});
export const interact = (id: string): ToolExpectationStep => ({
  id,
  kind: "interact",
});

export function expectCall(
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
  options: {
    argumentMatching?: "exact" | "partial" | "ignore";
    minCount?: number;
    role?: "advisory";
  } = {}
): ToolExpectationStep {
  return {
    id,
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName,
      args: {
        args,
        ...(options.argumentMatching
          ? { argumentMatching: options.argumentMatching }
          : {}),
      },
      ...(options.minCount !== undefined ? { minCount: options.minCount } : {}),
      ...(options.role ? { role: options.role } : {}),
    },
  };
}

export const call = (
  toolName: string,
  args: Record<string, unknown> = {},
  toolCallId?: string
): ToolExpectationCall => ({
  toolName,
  arguments: args,
  ...(toolCallId ? { toolCallId } : {}),
});

const ok = (
  assertions: Record<string, FixtureAssertionOutcome>,
  extra: Partial<FixtureTurnExpectation> = {}
): FixtureTurnExpectation => ({ assertions, passed: true, ...extra });

export const TOOL_EXPECTATION_FIXTURES: ToolExpectationFixture[] = [
  // ── review point 1: independent predicates would get these wrong ─────────
  {
    name: "overlapping expectations share one call: A({x:number}) + A({x:1}) vs [A({x:1})]",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: "number" }),
      expectCall("a2", "A", { x: 1 }),
    ],
    callsByTurn: [[call("A", { x: 1 })]],
    engine: [
      {
        assertions: { a1: "pass", a2: "missing" },
        passed: false,
        sequence: true,
      },
    ],
    matcher: [false],
  },
  {
    name: "overlapping expectations, the specific one first, still leave one missing",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: "number" }),
    ],
    callsByTurn: [[call("A", { x: 1 })]],
    engine: [{ assertions: { a1: "pass", a2: "missing" }, passed: false }],
    matcher: [false],
  },
  {
    name: "overlapping expectations are both met by two calls",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: "number" }),
      expectCall("a2", "A", { x: 1 }),
    ],
    callsByTurn: [[call("A", { x: 2 }), call("A", { x: 1 })]],
    engine: [ok({ a1: "pass", a2: "pass" })],
    matcher: [true],
  },
  {
    name: "swapped arguments under ignore: A(1), A(2) vs [A(2), A(1)] passes",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: 2 }),
    ],
    matchOptions: { toolCallOrder: "ignore" },
    callsByTurn: [[call("A", { x: 2 }), call("A", { x: 1 })]],
    engine: [ok({ a1: "pass", a2: "pass" }, { sequence: true })],
    matcher: [true],
  },
  {
    name: "swapped arguments under strict: the calls happened, the order row fails",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: 2 }),
    ],
    matchOptions: { toolCallOrder: "strict" },
    callsByTurn: [[call("A", { x: 2 }), call("A", { x: 1 })]],
    engine: [
      {
        assertions: { a1: "pass", a2: "pass" },
        sequence: false,
        passed: false,
      },
    ],
    matcher: [false],
  },
  {
    name: "swapped arguments under superset: the second is out of order",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: 2 }),
    ],
    matchOptions: { toolCallOrder: "superset" },
    callsByTurn: [[call("A", { x: 2 }), call("A", { x: 1 })]],
    engine: [
      {
        assertions: { a1: "pass", a2: "pass" },
        sequence: false,
        passed: false,
      },
    ],
    matcher: [false],
  },
  // ── review point 2: what the promotion drops ─────────────────────────────
  {
    name: "two turns, minCount 2 with one call each turn (the intended difference)",
    steps: [
      prompt("p1"),
      prompt("p2"),
      expectCall("a1", "A", {}, { minCount: 2 }),
    ],
    callsByTurn: [[call("A")], [call("A")]],
    engine: [
      { passed: true },
      { assertions: { a1: "missing" }, passed: false },
    ],
    matcher: [true, true],
    intendedDifference:
      "minCount is per turn in the engine. The promotion drops it (the matcher needs one call), and the step executor counts it across turns (two calls in all).",
  },
  {
    name: "one turn, minCount 2 with two calls passes",
    steps: [prompt("p1"), expectCall("a1", "A", {}, { minCount: 2 })],
    callsByTurn: [[call("A"), call("A")]],
    engine: [ok({ a1: "pass" })],
    matcher: [true],
  },
  {
    name: "one turn, minCount 2 with one call fails (the matcher drops minCount)",
    steps: [prompt("p1"), expectCall("a1", "A", {}, { minCount: 2 })],
    callsByTurn: [[call("A")]],
    engine: [{ assertions: { a1: "missing" }, passed: false }],
    matcher: [true],
    intendedDifference:
      "the promotion drops minCount, so the matcher needs one call; the step executor already fails this assert.",
  },
  {
    name: "an assert's own argumentMatching wins over the case's",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { a: 1 }, { argumentMatching: "exact" }),
    ],
    matchOptions: { argumentMatching: "partial" },
    callsByTurn: [[call("A", { a: 1, b: 2 })]],
    engine: [{ assertions: { a1: "arguments" }, passed: false }],
    matcher: [true],
    intendedDifference:
      "the promotion drops the assert's own argumentMatching, so the matcher grades it under the case's mode; the step executor honours it.",
  },
  {
    name: "an assert with no argumentMatching of its own takes the case's",
    steps: [prompt("p1"), expectCall("a1", "A", { a: 1 })],
    matchOptions: { argumentMatching: "exact" },
    callsByTurn: [[call("A", { a: 1, b: 2 })]],
    engine: [{ assertions: { a1: "arguments" }, passed: false }],
    matcher: [false],
  },
  {
    name: "an invalid minCount fails closed",
    steps: [prompt("p1"), expectCall("a1", "A", {}, { minCount: 0 })],
    callsByTurn: [[call("A")]],
    engine: [{ assertions: { a1: "missing" }, passed: false }],
    matcher: [true],
    intendedDifference:
      "the predicate evaluator fails a non-positive minCount closed; the promotion drops it.",
  },
  // ── the rest of the corpus ───────────────────────────────────────────────
  {
    name: "duplicate expectations need two calls",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: 1 }),
    ],
    callsByTurn: [[call("A", { x: 1 })]],
    engine: [{ assertions: { a1: "pass", a2: "missing" }, passed: false }],
    matcher: [false],
  },
  {
    name: "duplicate expectations are met by two calls",
    steps: [
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }),
      expectCall("a2", "A", { x: 1 }),
    ],
    callsByTurn: [[call("A", { x: 1 }), call("A", { x: 1 })]],
    engine: [ok({ a1: "pass", a2: "pass" })],
    matcher: [true],
  },
  {
    name: "extra calls past the cap fail the turn that made them",
    steps: [
      prompt("p1"),
      expectCall("a1", "A"),
      prompt("p2"),
      expectCall("a2", "A"),
    ],
    matchOptions: { maxExtraToolCalls: 1 },
    callsByTurn: [
      [call("A"), call("B"), call("C")],
      [call("A"), call("B")],
    ],
    engine: [
      {
        assertions: { a1: "pass" },
        extras: false,
        passed: false,
      },
      { assertions: { a2: "pass" }, extras: true, passed: true },
    ],
    matcher: [false, true],
  },
  {
    name: "unbounded extras never fail",
    steps: [prompt("p1"), expectCall("a1", "A")],
    callsByTurn: [[call("A"), call("B"), call("C"), call("D")]],
    engine: [ok({ a1: "pass" }, { extras: true })],
    matcher: [true],
  },
  {
    name: "a turn with no expectations under cap 0 fails when it calls a tool",
    steps: [prompt("p1"), expectCall("a1", "A"), prompt("p2")],
    matchOptions: { maxExtraToolCalls: 0 },
    callsByTurn: [[call("A")], [call("B")]],
    engine: [{ passed: true }, { extras: false, passed: false }],
    matcher: [true, false],
  },
  {
    name: "a turn with no expectations under cap 0 passes when it calls nothing",
    steps: [prompt("p1"), expectCall("a1", "A"), prompt("p2")],
    matchOptions: { maxExtraToolCalls: 0 },
    callsByTurn: [[call("A")], []],
    engine: [{ passed: true }, { extras: true, passed: true }],
    matcher: [true, true],
  },
  {
    name: "the legacy allowExtraToolCalls: false is a cap of 0",
    steps: [prompt("p1"), expectCall("a1", "A")],
    matchOptions: { allowExtraToolCalls: false },
    callsByTurn: [[call("A"), call("B")]],
    engine: [{ assertions: { a1: "pass" }, extras: false, passed: false }],
    matcher: [false],
  },
  {
    name: "negative: no call passes",
    steps: [prompt("p1")],
    isNegativeTest: true,
    callsByTurn: [[]],
    engine: [{ negative: true, passed: true }],
    matcher: [true],
  },
  {
    name: "negative: a call fails the no-tool row",
    steps: [prompt("p1")],
    isNegativeTest: true,
    callsByTurn: [[call("A")]],
    engine: [{ negative: false, passed: false }],
    matcher: [false],
  },
  {
    name: "a pinned turn is exempt from extras, order and no-tool",
    steps: [pinnedCall("c1"), expectCall("a1", "render")],
    matchOptions: { maxExtraToolCalls: 0, toolCallOrder: "strict" },
    callsByTurn: [[call("other"), call("render")]],
    engine: [
      ok({ a1: "pass" }, { extras: true, sequence: true, negative: true }),
    ],
    matcher: [true],
  },
  {
    name: "an assert after a pinned call that never happened still fails",
    steps: [pinnedCall("c1"), expectCall("a1", "render")],
    callsByTurn: [[call("other")]],
    engine: [{ assertions: { a1: "missing" }, passed: false }],
    matcher: [true],
    intendedDifference:
      "the matcher exempts a pinned turn entirely; the step executor already fails the assert at its position.",
  },
  {
    name: "a skill load is not an extra when skills are active",
    steps: [prompt("p1"), expectCall("a1", "A")],
    matchOptions: { maxExtraToolCalls: 0 },
    skillToolsActive: true,
    callsByTurn: [[call("loadSkill", {}, "s1"), call("A", {}, "a")]],
    engine: [ok({ a1: "pass" }, { extras: true })],
    matcher: [true],
  },
  {
    name: "a skill load is an extra when skills are not active",
    steps: [prompt("p1"), expectCall("a1", "A")],
    matchOptions: { maxExtraToolCalls: 0 },
    callsByTurn: [[call("loadSkill"), call("A")]],
    engine: [{ assertions: { a1: "pass" }, extras: false, passed: false }],
    matcher: [false],
  },
  {
    name: "a skill tool an assertion names is not exempt",
    steps: [prompt("p1"), expectCall("a1", "loadSkill"), expectCall("a2", "A")],
    matchOptions: { maxExtraToolCalls: 0 },
    skillToolsActive: true,
    callsByTurn: [[call("loadSkill"), call("A")]],
    engine: [ok({ a1: "pass", a2: "pass" }, { extras: true })],
    matcher: [true],
  },
  {
    name: "a positive case with no calls fails",
    steps: [prompt("p1"), expectCall("a1", "A")],
    callsByTurn: [[]],
    engine: [{ assertions: { a1: "missing" }, passed: false }],
    matcher: [false],
  },
  {
    name: "a turn with no expectations and no calls passes",
    steps: [prompt("p1")],
    callsByTurn: [[]],
    engine: [{ passed: true }],
    matcher: [true],
  },
  {
    name: "a same-name call with bad arguments is an arguments failure, not a missing one",
    steps: [prompt("p1"), expectCall("a1", "A", { x: 1 })],
    callsByTurn: [[call("A", { x: 2 }, "wrong")]],
    engine: [{ assertions: { a1: "arguments" }, passed: false }],
    matcher: [false],
  },
  {
    name: "a call to a different tool is a missing failure",
    steps: [prompt("p1"), expectCall("a1", "A", { x: 1 })],
    callsByTurn: [[call("B", { x: 1 })]],
    engine: [{ assertions: { a1: "missing" }, passed: false }],
    matcher: [false],
  },
  {
    name: "an advisory toolCalledWith is not an expectation",
    steps: [prompt("p1"), expectCall("a1", "A", {}, { role: "advisory" })],
    callsByTurn: [[]],
    engine: [{ assertions: {}, passed: true }],
    matcher: [true],
  },
  {
    name: "a call in turn 1 does not satisfy turn 2",
    steps: [
      prompt("p1"),
      expectCall("a1", "A"),
      prompt("p2"),
      expectCall("a2", "A"),
    ],
    callsByTurn: [[call("A")], []],
    engine: [
      { assertions: { a1: "pass" }, passed: true },
      {
        assertions: { a2: "missing" },
        passed: false,
      },
    ],
    matcher: [true, false],
  },
  {
    name: "strict order with a matching sequence passes",
    steps: [prompt("p1"), expectCall("a1", "A"), expectCall("a2", "B")],
    matchOptions: { toolCallOrder: "strict" },
    callsByTurn: [[call("A"), call("B")]],
    engine: [ok({ a1: "pass", a2: "pass" }, { sequence: true })],
    matcher: [true],
  },
  {
    name: "strict order with an extra call in front costs the sequence",
    steps: [prompt("p1"), expectCall("a1", "A")],
    matchOptions: { toolCallOrder: "strict" },
    callsByTurn: [[call("X"), call("A")]],
    engine: [{ assertions: { a1: "pass" }, sequence: false, passed: false }],
    matcher: [false],
  },
  {
    name: "superset order tolerates interleaved calls",
    steps: [prompt("p1"), expectCall("a1", "A"), expectCall("a2", "B")],
    matchOptions: { toolCallOrder: "superset" },
    callsByTurn: [[call("A"), call("X"), call("B")]],
    engine: [ok({ a1: "pass", a2: "pass" }, { sequence: true, extras: true })],
    matcher: [true],
  },
  {
    name: "strict order with wrong arguments in place is an arguments failure",
    steps: [prompt("p1"), expectCall("a1", "A", { x: 1 })],
    matchOptions: { toolCallOrder: "strict" },
    callsByTurn: [[call("A", { x: 2 })]],
    engine: [{ assertions: { a1: "arguments" }, passed: false }],
    matcher: [false],
  },
  {
    name: "ignore argumentMatching only checks the name",
    steps: [prompt("p1"), expectCall("a1", "A", { x: 1 })],
    matchOptions: { argumentMatching: "ignore" },
    callsByTurn: [[call("A", { x: 999 })]],
    engine: [ok({ a1: "pass" })],
    matcher: [true],
  },
  {
    name: "a leading assert opens an implicit turn, ahead of the prompt's",
    steps: [expectCall("a0", "A"), prompt("p1"), expectCall("a1", "B")],
    callsByTurn: [[call("A")], [call("B")]],
    engine: [
      { assertions: { a0: "pass" }, passed: true },
      { assertions: { a1: "pass" }, passed: true },
    ],
    matcher: [true, true],
  },
  {
    name: "an interact step folds into the turn that is open",
    steps: [prompt("p1"), interact("i1"), expectCall("a1", "A")],
    callsByTurn: [[call("A")]],
    engine: [ok({ a1: "pass" })],
    matcher: [true],
  },
];
