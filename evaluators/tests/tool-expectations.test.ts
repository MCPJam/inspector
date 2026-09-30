import { describe, expect, it } from "vitest";
import {
  evaluateToolCalls,
  pairToolCalls,
  type EvalMatchOptions,
  type EvalToolCall,
} from "../src/matchers";
import {
  compileToolExpectations,
  evaluateAssertionAtPosition,
  evaluateToolExpectations,
  evaluateTurnExpectations,
  type ToolExpectationStep,
} from "../src/tool-expectations";
import {
  TOOL_EXPECTATION_FIXTURES,
  call,
  expectCall,
  interact,
  pinnedCall,
  prompt,
  type FixtureAssertionOutcome,
} from "./tool-expectations.fixtures";

const outcomeOf = (result: {
  passed: boolean;
  failureKind: "missing" | "arguments" | null;
}): FixtureAssertionOutcome =>
  result.passed ? "pass" : (result.failureKind as "missing" | "arguments");

describe("the counterexample fixtures", () => {
  it.each(TOOL_EXPECTATION_FIXTURES.map((fixture) => [fixture.name, fixture]))(
    "%s",
    (_name, fixture) => {
      const turns = compileToolExpectations(fixture.steps, {
        matchOptions: fixture.matchOptions,
        isNegativeTest: fixture.isNegativeTest,
      });
      const evaluation = evaluateToolExpectations(turns, fixture.callsByTurn, {
        skillToolsActive: fixture.skillToolsActive,
      });
      expect(evaluation.turns).toHaveLength(fixture.engine.length);
      expect(evaluation.turns.map((turn) => turn.matcherEquivalent)).toEqual(
        fixture.matcher,
      );

      evaluation.turns.forEach((turn, index) => {
        const want = fixture.engine[index]!;
        expect(turn.passed, `turn ${index} verdict`).toBe(want.passed);
        for (const [stepId, outcome] of Object.entries(want.assertions ?? {})) {
          const result = turn.assertions.find((a) => a.stepId === stepId);
          expect(result, `assertion ${stepId}`).toBeDefined();
          expect(outcomeOf(result!), `assertion ${stepId}`).toBe(outcome);
        }
        if (want.assertions && Object.keys(want.assertions).length === 0) {
          expect(turn.assertions).toEqual([]);
        }
        if (want.sequence !== undefined) {
          expect(turn.sequence.passed, `turn ${index} sequence`).toBe(
            want.sequence,
          );
        }
        if (want.extras !== undefined) {
          expect(turn.extras.passed, `turn ${index} extras`).toBe(want.extras);
        }
        if (want.negative !== undefined) {
          expect(turn.negative.passed, `turn ${index} no-tool`).toBe(
            want.negative,
          );
        }
      });
    },
  );

  it("names an intended difference wherever the engine and the matcher disagree, and only there", () => {
    for (const fixture of TOOL_EXPECTATION_FIXTURES) {
      const disagrees = fixture.engine.some(
        (turn, index) => turn.passed !== fixture.matcher[index],
      );
      expect(
        Boolean(fixture.intendedDifference),
        `${fixture.name}: ${
          disagrees
            ? "differs from the matcher without saying why"
            : "names a difference that is not there"
        }`,
      ).toBe(disagrees);
    }
  });
});

describe("compile", () => {
  it("groups steps into turns the way stepsToPromptTurns does", () => {
    const turns = compileToolExpectations([
      expectCall("lead", "A"),
      prompt("p1"),
      interact("i1"),
      expectCall("a1", "B"),
      pinnedCall("c1"),
      expectCall("a2", "C"),
      prompt("p2"),
    ]);
    expect(
      turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        openedBy: turn.openedBy,
        pinned: turn.pinned,
        steps: turn.expectations.map((e) => e.stepId),
      })),
    ).toEqual([
      { turnIndex: 0, openedBy: undefined, pinned: false, steps: ["lead"] },
      { turnIndex: 1, openedBy: "p1", pinned: false, steps: ["a1"] },
      { turnIndex: 2, openedBy: "c1", pinned: true, steps: ["a2"] },
      { turnIndex: 3, openedBy: "p2", pinned: false, steps: [] },
    ]);
  });

  it("keeps each assert's step id, position, arguments, mode and minCount", () => {
    const [turn] = compileToolExpectations(
      [
        prompt("p1"),
        interact("i1"),
        expectCall("a1", "A", { x: 1 }, { minCount: 3 }),
        expectCall("a2", "B", {}, { argumentMatching: "exact" }),
      ],
      { matchOptions: { argumentMatching: "ignore" } },
    );
    expect(turn!.expectations).toEqual([
      {
        stepId: "a1",
        position: 2,
        toolName: "A",
        args: { x: 1 },
        argumentMatching: "ignore",
        minCount: 3,
      },
      {
        stepId: "a2",
        position: 3,
        toolName: "B",
        args: {},
        argumentMatching: "exact",
        minCount: 1,
      },
    ]);
  });

  it("promotes what stepsToPromptTurns would, and only that", () => {
    const [turn] = compileToolExpectations([
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }, { minCount: 2 }),
      expectCall("adv", "B", {}, { role: "advisory" }),
      {
        id: "w1",
        kind: "assert",
        assertion: { kind: "widgetToolCalled", toolName: "w" },
      },
      { id: "n1", kind: "assert", assertion: { type: "noToolErrors" } },
    ]);
    expect(turn!.legacyExpected).toEqual([
      { toolName: "A", arguments: { x: 1 } },
    ]);
    expect(turn!.expectations.map((e) => e.stepId)).toEqual(["a1"]);
  });

  it.each<[EvalMatchOptions, number | null]>([
    [{}, null],
    [{ maxExtraToolCalls: 2 }, 2],
    [{ maxExtraToolCalls: null }, null],
    [{ allowExtraToolCalls: false }, 0],
    [{ allowExtraToolCalls: true }, null],
    [{ allowExtraToolCalls: false, maxExtraToolCalls: 3 }, 3],
  ])("resolves the extras cap from %j", (matchOptions, cap) => {
    const [turn] = compileToolExpectations([prompt("p1")], { matchOptions });
    expect(turn!.extrasCap).toBe(cap);
  });

  it("refuses a cap the matcher cannot honour, as the matcher does", () => {
    expect(() =>
      compileToolExpectations([prompt("p1")], {
        matchOptions: { maxExtraToolCalls: -1 },
      }),
    ).toThrow(/maxExtraToolCalls/);
  });

  it("flags a non-positive minCount instead of dropping the assert", () => {
    const [turn] = compileToolExpectations([
      prompt("p1"),
      expectCall("a1", "A", {}, { minCount: 0 }),
      expectCall("a2", "A", {}, { minCount: 1.5 }),
    ]);
    expect(turn!.expectations).toMatchObject([
      { stepId: "a1", minCount: 1, invalidMinCount: true },
      { stepId: "a2", minCount: 1, invalidMinCount: true },
    ]);
  });
});

describe("evaluate", () => {
  const compileOne = (
    steps: ToolExpectationStep[],
    matchOptions?: EvalMatchOptions,
  ) => compileToolExpectations(steps, { matchOptions })[0]!;

  it("reports which calls each assertion was paired with, by index and id", () => {
    const turn = compileOne([
      prompt("p1"),
      expectCall("a1", "A"),
      expectCall("a2", "B"),
    ]);
    const result = evaluateTurnExpectations(turn, [
      call("X", {}, "x"),
      call("B", {}, "b"),
      call("A", {}, "a"),
    ]);
    expect(result.assertions).toMatchObject([
      { stepId: "a1", pairedCallIndexes: [2], pairedCallIds: ["a"] },
      { stepId: "a2", pairedCallIndexes: [1], pairedCallIds: ["b"] },
    ]);
  });

  it("indexes paired calls against the calls it was given, skill calls included", () => {
    const turn = compileOne([prompt("p1"), expectCall("a1", "A")]);
    const result = evaluateTurnExpectations(
      turn,
      [call("loadSkill"), call("A", {}, "a")],
      { skillToolsActive: true },
    );
    expect(result.assertions[0]).toMatchObject({
      pairedCallIndexes: [1],
      pairedCallIds: ["a"],
    });
  });

  it("names the wrong-argument call an assertion was paired with", () => {
    const turn = compileOne([prompt("p1"), expectCall("a1", "A", { x: 1 })]);
    const result = evaluateTurnExpectations(turn, [
      call("A", { x: 2 }, "wrong"),
    ]);
    expect(result.assertions[0]).toMatchObject({
      passed: false,
      failureKind: "arguments",
      argumentMismatchSlots: 1,
      pairedCallIds: ["wrong"],
    });
    expect(result.matcher.argumentMismatches).toHaveLength(1);
  });

  it("counts the slots of a minCount separately", () => {
    const turn = compileOne([
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }, { minCount: 3 }),
    ]);
    const result = evaluateTurnExpectations(turn, [
      call("A", { x: 1 }),
      call("A", { x: 2 }),
    ]);
    expect(result.assertions[0]).toMatchObject({
      passed: false,
      failureKind: "missing",
      missingSlots: 1,
      argumentMismatchSlots: 1,
    });
  });

  it("reports a missing call ahead of a wrong-argument one on the same assertion", () => {
    const turn = compileOne([
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }, { minCount: 2 }),
    ]);
    const result = evaluateTurnExpectations(turn, [call("A", { x: 2 })]);
    expect(result.assertions[0]!.failureKind).toBe("missing");
  });

  it("keeps extras, order and no-tool out of the assertions", () => {
    const turn = compileOne([prompt("p1"), expectCall("a1", "A")], {
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
    });
    const result = evaluateTurnExpectations(turn, [call("X"), call("A")]);
    expect(result.assertions[0]!.passed).toBe(true);
    expect(result.sequence).toMatchObject({ passed: false, mode: "strict" });
    expect(result.extras).toMatchObject({ passed: false, count: 2, cap: 0 });
    expect(result.negative).toMatchObject({ active: false, passed: true });
  });

  it("tolerates a missing or non-array calls list", () => {
    const turn = compileOne([prompt("p1"), expectCall("a1", "A")]);
    expect(evaluateTurnExpectations(turn, undefined).passed).toBe(false);
    expect(
      evaluateToolExpectations([turn], []).turns[0]!.assertions[0],
    ).toMatchObject({ failureKind: "missing" });
  });

  describe("timing", () => {
    const turn = compileOne([
      prompt("p1"),
      expectCall("a1", "A", { x: "number" }),
      expectCall("a2", "A", { x: 1 }),
      expectCall("a3", "B"),
    ]);

    it("grades an assertion over the calls made so far, not the turn's final calls", () => {
      expect(
        evaluateAssertionAtPosition(turn, "a3", [call("A", { x: 1 })]),
      ).toMatchObject({ passed: false, failureKind: "missing" });
      expect(
        evaluateAssertionAtPosition(turn, "a3", [
          call("A", { x: 1 }),
          call("A", { x: 2 }),
          call("B"),
        ]),
      ).toMatchObject({ passed: true });
    });

    it("lets an assertion above take calls first, and ignores the ones below", () => {
      const calls = [call("A", { x: 1 })];
      // a1 sees only itself, so it takes the only call.
      expect(evaluateAssertionAtPosition(turn, "a1", calls)).toMatchObject({
        passed: true,
      });
      // a2 sees a1 above it, which took the call: the same greedy answer the
      // turn's own end gives, which is what a fail-fast halt has to agree with.
      expect(evaluateAssertionAtPosition(turn, "a2", calls)).toMatchObject({
        passed: false,
        failureKind: "missing",
      });
    });

    it("agrees with the end-of-turn result once the calls are all in", () => {
      const calls = [call("A", { x: 2 }), call("A", { x: 1 }), call("B")];
      const final = evaluateTurnExpectations(turn, calls);
      for (const assertion of final.assertions) {
        expect(
          evaluateAssertionAtPosition(turn, assertion.stepId, calls),
        ).toEqual(assertion);
      }
    });

    it("keeps a skill call an assertion below names from counting as housekeeping", () => {
      const withSkill = compileOne(
        [prompt("p1"), expectCall("a1", "A"), expectCall("a2", "loadSkill")],
        { maxExtraToolCalls: 0 },
      );
      const calls = [call("loadSkill"), call("A")];
      expect(
        evaluateAssertionAtPosition(withSkill, "a1", calls, {
          skillToolsActive: true,
        }),
      ).toMatchObject({ passed: true, pairedCallIndexes: [1] });
    });

    it("returns nothing for a step that is not an expectation", () => {
      expect(evaluateAssertionAtPosition(turn, "nope", [])).toBeUndefined();
    });
  });

  describe("the roll-up", () => {
    it("passes only when every turn does, and reports today's verdict beside it", () => {
      const turns = compileToolExpectations([
        prompt("p1"),
        expectCall("a1", "A"),
        prompt("p2"),
        expectCall("a2", "A"),
      ]);
      const evaluation = evaluateToolExpectations(turns, [[call("A")], []]);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.matcherEquivalent).toBe(false);
      expect(evaluation.turns.map((turn) => turn.passed)).toEqual([
        true,
        false,
      ]);
    });
  });
});

/**
 * The claim the whole design rests on: wherever the promotion loses nothing
 * (one mode for the case, every `minCount` 1), the engine's verdict IS the
 * matcher's, and every failing pairing is accounted for by a failed assertion
 * or a failed order row, never neither.
 *
 * Seeded, so a failure names its own reproduction.
 */
describe("agreement with the matcher where the promotion loses nothing", () => {
  const TOOLS = ["A", "B", "C"];
  const ARGS: Array<Record<string, unknown>> = [
    {},
    { x: 1 },
    { x: 2 },
    { x: "number" },
    { x: 1, y: "z" },
  ];
  const ORDERS = ["ignore", "strict", "superset"] as const;
  const MODES = ["partial", "exact", "ignore"] as const;
  const CAPS = [null, 0, 1, 2] as const;

  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const pick = <T>(next: () => number, list: readonly T[]): T =>
    list[Math.floor(next() * list.length)]!;

  it("holds over 2,000 random turns", () => {
    const next = random(20260930);
    for (let n = 0; n < 2000; n++) {
      const options: EvalMatchOptions = {
        toolCallOrder: pick(next, ORDERS),
        argumentMatching: pick(next, MODES),
        maxExtraToolCalls: pick(next, CAPS),
      };
      const expectations = Array.from(
        { length: Math.floor(next() * 4) },
        (_, i) => expectCall(`a${i}`, pick(next, TOOLS), pick(next, ARGS)),
      );
      const calls: EvalToolCall[] = Array.from(
        { length: Math.floor(next() * 5) },
        () => ({ toolName: pick(next, TOOLS), arguments: pick(next, ARGS) }),
      );
      const [turn] = compileToolExpectations([prompt("p1"), ...expectations], {
        matchOptions: options,
      });
      const result = evaluateTurnExpectations(turn!, calls);
      const label = `seed case ${n}: ${JSON.stringify({
        options,
        expectations,
        calls,
      })}`;

      // Today's matcher, called directly on what the promotion would hand it.
      const reference =
        turn!.legacyExpected.length === 0
          ? options.maxExtraToolCalls === null ||
            calls.length <= (options.maxExtraToolCalls as number)
          : evaluateToolCalls(turn!.legacyExpected, calls, options).passed;
      expect(result.matcherEquivalent, label).toBe(reference);
      expect(result.passed, label).toBe(reference);

      // Nothing fails without a row that says so.
      const lost = result.assertions.reduce(
        (sum, a) =>
          sum + a.missingSlots + a.argumentMismatchSlots + a.outOfOrderSlots,
        0,
      );
      const bounded = result.extras.passed;
      expect(result.passed, label).toBe(
        result.assertions.every((a) => a.passed) &&
          result.sequence.passed &&
          bounded,
      );
      if (turn!.legacyExpected.length > 0) {
        const matcher = evaluateToolCalls(turn!.legacyExpected, calls, options);
        expect(lost, label).toBe(
          matcher.missing.length + matcher.argumentMismatches.length,
        );
      }
    }
  });
});

describe("an authored minCount", () => {
  it("does not cost time or memory in proportion to itself", () => {
    const [turn] = compileToolExpectations([
      prompt("p1"),
      expectCall("a1", "A", { x: 1 }, { minCount: 1e9 }),
      expectCall("a2", "B"),
    ]);
    const started = Date.now();
    const result = evaluateTurnExpectations(turn!, [
      call("A", { x: 1 }),
      call("B"),
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    // One call for a1 exists; the other 999,999,999 do not.
    expect(result.assertions[0]).toMatchObject({
      passed: false,
      failureKind: "missing",
      missingSlots: 1e9 - 1,
    });
    expect(result.assertions[1]).toMatchObject({ passed: true });
  });

  /**
   * The engine builds at most `calls + 1` slots per assertion and counts the
   * rest as missing. That has to be a saving, not a change: this grades the
   * same turns against a reference that builds every slot.
   */
  it("gives the results of building every slot", () => {
    const TOOLS = ["A", "B"];
    const ARGS: Array<Record<string, unknown>> = [{}, { x: 1 }, { x: 2 }];
    const ORDERS = ["ignore", "strict", "superset"] as const;
    const MODES = ["partial", "exact", "ignore"] as const;
    let state = 424242;
    const next = () =>
      (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(next() * list.length)]!;

    for (let n = 0; n < 3000; n++) {
      const order = pick(ORDERS);
      const argumentMatching = pick(MODES);
      const expectations = Array.from(
        { length: 1 + Math.floor(next() * 3) },
        (_, i) =>
          expectCall(`a${i}`, pick(TOOLS), pick(ARGS), {
            minCount: 1 + Math.floor(next() * 8),
          }),
      );
      const calls: EvalToolCall[] = Array.from(
        { length: Math.floor(next() * 4) },
        () => ({ toolName: pick(TOOLS), arguments: pick(ARGS) }),
      );
      const [turn] = compileToolExpectations([prompt("p1"), ...expectations], {
        matchOptions: { toolCallOrder: order, argumentMatching },
      });
      const label = `case ${n}: ${JSON.stringify({ order, argumentMatching, expectations, calls })}`;
      const result = evaluateTurnExpectations(turn!, calls);

      // The reference: every slot built, graded and classified in the open.
      const slots: EvalToolCall[] = [];
      const owner: number[] = [];
      turn!.expectations.forEach((e, i) => {
        for (let k = 0; k < e.minCount; k++) {
          slots.push({ toolName: e.toolName, arguments: e.args });
          owner.push(i);
        }
      });
      const mode = (slot: number) =>
        turn!.expectations[owner[slot]!]!.argumentMatching;
      const graded = pairToolCalls(slots, calls, order, mode);
      const agnostic = pairToolCalls(slots, calls, "ignore", mode);
      const counts = turn!.expectations.map(() => ({
        missingSlots: 0,
        argumentMismatchSlots: 0,
        outOfOrderSlots: 0,
      }));
      slots.forEach((_, slot) => {
        const lost =
          !graded.expectedToActual.has(slot) ||
          graded.argumentMismatchExpected.includes(slot);
        if (!lost) return;
        const own = counts[owner[slot]!]!;
        if (!agnostic.expectedToActual.has(slot)) own.missingSlots += 1;
        else if (agnostic.argumentMismatchExpected.includes(slot))
          own.argumentMismatchSlots += 1;
        else own.outOfOrderSlots += 1;
      });

      result.assertions.forEach((assertion, i) => {
        expect(
          {
            missingSlots: assertion.missingSlots,
            argumentMismatchSlots: assertion.argumentMismatchSlots,
            outOfOrderSlots: assertion.outOfOrderSlots,
          },
          `${label}, assertion ${i}`,
        ).toEqual(counts[i]);
      });
      expect(result.extras.count, label).toBe(
        calls.length - new Set(graded.expectedToActual.values()).size,
      );
    }
  }, 60000);
});
