/**
 * The spine's three primitives: one id minter, one action projection, one
 * splice.
 *
 * The splice matters most. Before it there were four different insertion
 * policies in this app, two of which are GRADING-relevant: `writeSimpleCase`
 * places a route tool after the last `toolCalledWith` in turn 1, and the
 * recorder appends at the end of a turn. A `toolCalledWith` is evaluated WHERE
 * IT SITS, and a later position sees widget-initiated tool calls, so moving one
 * of those insertions is a grading change wearing a refactor's clothes. The
 * property test at the bottom pins the recorder case against a verbatim copy of
 * the loop it replaces.
 */
import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  actionRows,
  insertStepAfter,
  lastStepIdOfTurn,
  newStepId,
  stepTurnIndices,
  turnOfStep,
} from "@/shared/steps";

const prompt = (id: string, text = "ask"): TestStep => ({
  id,
  kind: "prompt",
  prompt: text,
});
const assert = (id: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "noToolErrors" },
});
const interact = (id: string): TestStep => ({
  id,
  kind: "interact",
  toolName: "cart_view",
  action: { kind: "click", target: { testId: "cart" } },
});
const toolCall = (id: string): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "srv",
  toolName: "get_order",
  arguments: {},
});

/** The ten authored shapes this program has to keep working. */
const SHAPES: Array<{ name: string; steps: TestStep[] }> = [
  { name: "empty", steps: [] },
  { name: "prompt only", steps: [prompt("s1")] },
  {
    name: "golden (prompt + 3 checks)",
    steps: [prompt("s1"), assert("a1"), assert("a2"), assert("a3")],
  },
  {
    name: "two turn",
    steps: [prompt("s1"), assert("a1"), prompt("s2"), assert("a2")],
  },
  { name: "pinned first (model free)", steps: [toolCall("t1"), assert("a1")] },
  {
    name: "pinned then prompt",
    steps: [toolCall("t1"), prompt("s1"), assert("a1")],
  },
  {
    name: "prompt + interact + widget assert",
    steps: [prompt("s1"), interact("i1"), assert("a1")],
  },
  {
    name: "interleaved clicks",
    steps: [
      prompt("s1"),
      assert("a1"),
      interact("i1"),
      assert("a2"),
      interact("i2"),
    ],
  },
  { name: "leading assert", steps: [assert("a0"), prompt("s1"), assert("a1")] },
  { name: "actions only", steps: [prompt("s1"), interact("i1"), prompt("s2")] },
];

describe("newStepId", () => {
  it("keeps the kind prefix and the two-segment suffix every caller matches", () => {
    expect(newStepId("assert")).toMatch(/^assert-\d+-\d+$/);
    expect(newStepId("interact")).toMatch(/^interact-\d+-\d+$/);
  });

  it("is unique across a burst, so a loop of inserts cannot collide", () => {
    // The bug this replaces: `migrated-assert-${i}` restarted at 0 on a second
    // migration and reused ids still present on the case.
    const ids = new Set(
      Array.from({ length: 1000 }, () => newStepId("assert")),
    );
    expect(ids.size).toBe(1000);
  });

  it("increases monotonically within a millisecond", () => {
    const a = newStepId("assert");
    const b = newStepId("assert");
    const tail = (id: string) => Number(id.split("-")[2]);
    expect(tail(b)).toBeGreaterThan(tail(a));
  });
});

describe("turnOfStep / lastStepIdOfTurn", () => {
  it.each(SHAPES)("agrees with stepTurnIndices on $name", ({ steps }) => {
    const turns = stepTurnIndices(steps);
    steps.forEach((step, i) => {
      expect(turnOfStep(steps, step.id)).toBe(turns[i]);
    });
  });

  it("returns undefined for an id that is not in the list", () => {
    expect(turnOfStep([prompt("s1")], "nope")).toBeUndefined();
    expect(lastStepIdOfTurn([prompt("s1")], 7)).toBeUndefined();
  });

  it("names the LAST step of the turn, not the first", () => {
    const steps = [prompt("s1"), assert("a1"), assert("a2"), prompt("s2")];
    expect(lastStepIdOfTurn(steps, 0)).toBe("a2");
    expect(lastStepIdOfTurn(steps, 1)).toBe("s2");
  });
});

describe("actionRows", () => {
  it.each(SHAPES)(
    "reproduces $name exactly (nothing dropped, nothing reordered)",
    ({ steps }) => {
      const { leading, actions } = actionRows(steps);
      const flat = [
        ...leading.map((c) => c.step),
        ...actions.flatMap((a) => [a.step, ...a.checks.map((c) => c.step)]),
      ];
      expect(flat).toEqual(steps);
    },
  );

  it.each(SHAPES)("numbers actions 1..N on $name", ({ steps }) => {
    const { actions } = actionRows(steps);
    expect(actions.map((a) => a.ordinal)).toEqual(actions.map((_, i) => i + 1));
  });

  it.each(SHAPES)(
    "carries the same turn index stepTurnIndices does on $name",
    ({ steps }) => {
      const turns = stepTurnIndices(steps);
      for (const action of actionRows(steps).actions) {
        expect(action.turnIndex).toBe(turns[action.index]);
      }
    },
  );

  it("nests each check under the action it follows, not under the turn", () => {
    // The interact is its own ACTION but shares turn 0 with the prompt: a2
    // belongs to the click, and numbering it under the prompt would tell the
    // author the wrong thing about what it grades.
    const steps = [prompt("s1"), assert("a1"), interact("i1"), assert("a2")];
    const { actions } = actionRows(steps);
    expect(
      actions.map((a) => [a.step.id, a.checks.map((c) => c.step.id)]),
    ).toEqual([
      ["s1", ["a1"]],
      ["i1", ["a2"]],
    ]);
    expect(actions.every((a) => a.turnIndex === 0)).toBe(true);
  });

  it("keeps a leading assert visible instead of dropping it", () => {
    const { leading, actions } = actionRows([assert("a0"), prompt("s1")]);
    expect(leading.map((c) => c.step.id)).toEqual(["a0"]);
    expect(actions.map((a) => a.step.id)).toEqual(["s1"]);
  });

  it("reports lastIndex as the block's end", () => {
    const steps = [prompt("s1"), assert("a1"), assert("a2"), prompt("s2")];
    const { actions } = actionRows(steps);
    expect(actions[0]!.lastIndex).toBe(2);
    expect(actions[1]!.lastIndex).toBe(3);
  });
});

describe("insertStepAfter", () => {
  const x = assert("NEW");

  it("rule 1: a null anchor inserts before everything", () => {
    expect(insertStepAfter([prompt("s1")], null, x).map((s) => s.id)).toEqual([
      "NEW",
      "s1",
    ]);
  });

  it("rule 2: an unknown anchor appends instead of throwing", () => {
    // A suggestion carries a step id from the trial's frozen snapshot; a draft
    // edited since may not contain it. Appending keeps the check.
    expect(
      insertStepAfter([prompt("s1"), assert("a1")], "gone", x).map((s) => s.id),
    ).toEqual(["s1", "a1", "NEW"]);
  });

  it("rule 3: an action anchor inserts after that action's whole block", () => {
    const steps = [prompt("s1"), assert("a1"), assert("a2"), prompt("s2")];
    expect(insertStepAfter(steps, "s1", x).map((s) => s.id)).toEqual([
      "s1",
      "a1",
      "a2",
      "NEW",
      "s2",
    ]);
  });

  it("rule 3: the block is the ACTION's, not the turn's", () => {
    // Pressed under the prompt, the check must land under the prompt — a
    // turn-end rule would put it after a2, visibly under the click.
    const steps = [prompt("s1"), assert("a1"), interact("i1"), assert("a2")];
    expect(insertStepAfter(steps, "s1", x).map((s) => s.id)).toEqual([
      "s1",
      "a1",
      "NEW",
      "i1",
      "a2",
    ]);
  });

  it("rule 4: an assert anchor inserts immediately after it", () => {
    const steps = [prompt("s1"), assert("a1"), assert("a2")];
    expect(insertStepAfter(steps, "a1", x).map((s) => s.id)).toEqual([
      "s1",
      "a1",
      "NEW",
      "a2",
    ]);
  });

  it("never mutates the input", () => {
    const steps = [prompt("s1"), assert("a1")];
    const before = steps.map((s) => s.id);
    insertStepAfter(steps, "s1", x);
    expect(steps.map((s) => s.id)).toEqual(before);
  });

  it("appends when the anchor is the last action with no checks", () => {
    expect(
      insertStepAfter([prompt("s1"), prompt("s2")], "s2", x).map((s) => s.id),
    ).toEqual(["s1", "s2", "NEW"]);
  });
});

describe("insertStepAfter replaces the recorder's own splice, byte for byte", () => {
  /**
   * The loop being replaced, copied verbatim from `appendWidgetStepToTurn` in
   * `test-template-editor.tsx` as it stood before this change. It is the ORACLE
   * — if the two ever disagree, a recorded click lands in a different turn and
   * grades a different part of the run.
   */
  function oldAppendWidgetStepToTurn(
    currentSteps: TestStep[],
    turnIndex: number,
    step: TestStep,
  ): TestStep[] {
    const turnOf = stepTurnIndices(currentSteps);
    let insertAt = currentSteps.length;
    for (let i = currentSteps.length - 1; i >= 0; i--) {
      if (turnOf[i] === turnIndex) {
        insertAt = i + 1;
        break;
      }
    }
    const next = [...currentSteps];
    next.splice(insertAt, 0, step);
    return next;
  }

  /** What the caller becomes. */
  function viaHelper(
    steps: TestStep[],
    turnIndex: number,
    step: TestStep,
  ): TestStep[] {
    return insertStepAfter(
      steps,
      lastStepIdOfTurn(steps, turnIndex) ?? steps[steps.length - 1]?.id ?? null,
      step,
    );
  }

  it.each(SHAPES)("agrees on every turn index of $name", ({ steps }) => {
    const turnCount = stepTurnIndices(steps).length
      ? Math.max(...stepTurnIndices(steps)) + 1
      : 0;
    for (let t = 0; t <= turnCount; t += 1) {
      const step = assert(`w-${t}`);
      expect(viaHelper(steps, t, step).map((s) => s.id)).toEqual(
        oldAppendWidgetStepToTurn(steps, t, step).map((s) => s.id),
      );
    }
  });

  it("agrees on 500 random step lists", () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 20260907;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const kinds = ["prompt", "assert", "interact", "toolCall"] as const;
    for (let n = 0; n < 500; n += 1) {
      const len = Math.floor(rand() * 9);
      const steps: TestStep[] = [];
      for (let i = 0; i < len; i += 1) {
        const kind = kinds[Math.floor(rand() * kinds.length)]!;
        const id = `${kind}-${n}-${i}`;
        steps.push(
          kind === "prompt"
            ? prompt(id)
            : kind === "assert"
              ? assert(id)
              : kind === "interact"
                ? interact(id)
                : toolCall(id),
        );
      }
      const turnIndex = Math.floor(rand() * (len + 2));
      const step = assert(`w-${n}`);
      expect(viaHelper(steps, turnIndex, step).map((s) => s.id)).toEqual(
        oldAppendWidgetStepToTurn(steps, turnIndex, step).map((s) => s.id),
      );
    }
  });
});
