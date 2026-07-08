import { describe, it, expect } from "vitest";
import {
  testStepSchema,
  stepsSchema,
  needsModel,
  countModelSteps,
  isModelFree,
  normalizeSteps,
  normalizeStepsForSignature,
  isWidgetAssertion,
  promptTurnsToSteps,
  deriveQuery,
  deriveExpectedToolCalls,
  stepsToPromptTurns,
  stepTurnIndices,
  type TestStep,
} from "../steps";
import type { PromptTurn } from "../steps";

describe("TestStep schema", () => {
  it("parses each step kind", () => {
    const steps: unknown[] = [
      { id: "a", kind: "prompt", prompt: "Draw a cat" },
      {
        id: "b",
        kind: "toolCall",
        serverName: "amazon",
        toolName: "create_view",
        arguments: { q: "cat" },
      },
      {
        id: "c",
        kind: "interact",
        toolName: "create_view",
        action: { kind: "click", target: { testId: "canvas" } },
      },
      {
        id: "d",
        kind: "assert",
        assertion: { type: "widgetRendered", toolName: "create_view" },
      },
      {
        id: "e",
        kind: "assert",
        assertion: { kind: "textVisible", toolName: "create_view", text: "Hello" },
      },
    ];
    for (const s of steps) expect(testStepSchema.safeParse(s).success).toBe(true);
    expect(stepsSchema.safeParse(steps).success).toBe(true);
  });

  it("rejects an assertion inside an interact action (no asserts in Interact)", () => {
    const bad = {
      id: "x",
      kind: "interact",
      toolName: "t",
      action: { kind: "assert", assertion: { type: "textVisible", text: "y" } },
    };
    expect(testStepSchema.safeParse(bad).success).toBe(false);
  });

  it("discriminates WidgetAssertion (kind) from Predicate (type)", () => {
    expect(
      isWidgetAssertion({ kind: "textVisible", toolName: "t", text: "x" }),
    ).toBe(true);
    expect(isWidgetAssertion({ type: "widgetRendered", toolName: "t" })).toBe(
      false,
    );
  });
});

describe("selectors", () => {
  const steps: TestStep[] = [
    { id: "1", kind: "prompt", prompt: "a" },
    { id: "2", kind: "assert", assertion: { type: "widgetRendered" } },
    { id: "3", kind: "prompt", prompt: "b" },
  ];
  it("counts model steps / needsModel / isModelFree", () => {
    expect(countModelSteps(steps)).toBe(2);
    expect(needsModel(steps)).toBe(true);
    expect(isModelFree(steps)).toBe(false);
  });
  it("isModelFree true when only toolCall/assert steps", () => {
    const mf: TestStep[] = [
      {
        id: "1",
        kind: "toolCall",
        serverName: "s",
        toolName: "t",
        arguments: {},
      },
      { id: "2", kind: "assert", assertion: { type: "widgetRendered" } },
    ];
    expect(isModelFree(mf)).toBe(true);
    expect(needsModel(mf)).toBe(false);
  });
});

describe("normalize", () => {
  it("drops junk entries; signature stable for equal input", () => {
    const raw = [
      { id: "1", kind: "prompt", prompt: "a" },
      { nope: true },
      null,
    ];
    expect(normalizeSteps(raw)).toHaveLength(1);
    const a = normalizeStepsForSignature(raw);
    const b = normalizeStepsForSignature(raw);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("promptTurnsToSteps migration", () => {
  it("maps prompt + expectedToolCalls + widgetChecks + checks in order", () => {
    const turns: PromptTurn[] = [
      {
        id: "turn-1",
        prompt: "Draw a cat",
        expectedToolCalls: [{ toolName: "create_view", arguments: { q: "cat" } }],
        widgetChecks: [
          {
            toolName: "create_view",
            steps: [
              { kind: "click", target: { testId: "canvas" } },
              { kind: "assert", assertion: { type: "textVisible", text: "Hello" } },
            ],
          },
        ],
        checks: [{ type: "noToolErrors" }],
      },
    ];
    const steps = promptTurnsToSteps(turns);
    expect(steps.map((s) => s.kind)).toEqual([
      "prompt",
      "assert", // expected tool call → toolCalledWith
      "interact", // widget click
      "assert", // widget textVisible
      "assert", // per-turn check
    ]);
    const expectAssert = steps[1];
    if (expectAssert.kind !== "assert") throw new Error("expected assert");
    expect(expectAssert.assertion).toMatchObject({
      type: "toolCalledWith",
      toolName: "create_view",
      args: { args: { q: "cat" } },
    });
    const widgetAssert = steps[3];
    if (widgetAssert.kind !== "assert") throw new Error("expected assert");
    expect(widgetAssert.assertion).toMatchObject({
      kind: "textVisible",
      toolName: "create_view",
      text: "Hello",
    });
    // The whole migration output is schema-valid.
    expect(stepsSchema.safeParse(steps).success).toBe(true);
  });

  it("maps a pinned turn to a toolCall step (model-free)", () => {
    const turns: PromptTurn[] = [
      {
        id: "turn-1",
        prompt: "",
        expectedToolCalls: [],
        pinnedToolCall: {
          serverName: "amazon",
          toolName: "create_view",
          arguments: { q: "fryer" },
        },
      },
    ];
    const steps = promptTurnsToSteps(turns);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "toolCall",
      serverName: "amazon",
      toolName: "create_view",
      arguments: { q: "fryer" },
    });
    expect(isModelFree(steps)).toBe(true);
  });
});

describe("stepsToPromptTurns (inverse / round-trip)", () => {
  it("round-trips a multi-turn case through steps and back", () => {
    const turns: PromptTurn[] = [
      {
        id: "turn-1",
        prompt: "Draw a cat",
        expectedToolCalls: [
          { toolName: "create_view", arguments: { q: "cat" } },
        ],
        widgetChecks: [
          {
            toolName: "create_view",
            steps: [
              { kind: "click", target: { testId: "canvas" } },
              { kind: "assert", assertion: { type: "textVisible", text: "Hi" } },
            ],
          },
        ],
        checks: [{ type: "noToolErrors" }],
      },
      {
        id: "turn-2",
        prompt: "",
        expectedToolCalls: [],
        pinnedToolCall: {
          serverName: "amazon",
          toolName: "search",
          arguments: { q: "fryer" },
        },
      },
    ];
    const back = stepsToPromptTurns(promptTurnsToSteps(turns));
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({
      prompt: "Draw a cat",
      expectedToolCalls: [{ toolName: "create_view", arguments: { q: "cat" } }],
      widgetChecks: [
        {
          toolName: "create_view",
          steps: [
            { kind: "click", target: { testId: "canvas" } },
            { kind: "assert", assertion: { type: "textVisible", text: "Hi" } },
          ],
        },
      ],
      checks: [{ type: "noToolErrors" }],
    });
    expect(back[1]).toMatchObject({
      pinnedToolCall: { serverName: "amazon", toolName: "search", arguments: { q: "fryer" } },
    });
  });

  it("represents a tool-call assert as an expected tool call (matcher path, both run paths)", () => {
    // A `toolCalledWith` always maps to `expectedToolCalls` — regardless of
    // whether it's authored before or after an interact — so the matcher
    // (which runs on both local + hosted paths) evaluates it. Per-turn `checks`
    // are NOT evaluated on the hosted/free path, so we must not route it there.
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "show cart" },
      {
        id: "i",
        kind: "interact",
        toolName: "view-cart",
        action: { kind: "click", target: { role: { role: "button", name: "Add to cart" } } },
      },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "clear-cart", args: { args: {} } },
      },
    ];
    const [turn] = stepsToPromptTurns(steps);
    // The assert lands in expectedToolCalls (gated by the matcher) — NOT in
    // `turn.checks` (which the hosted path silently ignores).
    expect(turn!.expectedToolCalls).toEqual([
      { toolName: "clear-cart", arguments: {} },
    ]);
    expect(turn!.checks ?? []).toEqual([]);
  });

  it("preserves a check authored BEFORE interacts across the editor round-trip", () => {
    // The bug: a `widgetRendered` check dragged above the interacts snapped back
    // below them, because the turn buckets re-emit checks after widgetChecks.
    // `childOrder` records the authored position so the move sticks.
    const reordered: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "Show me a redbull" },
      { id: "a", kind: "assert", assertion: { type: "widgetRendered" } },
      {
        id: "i1",
        kind: "interact",
        toolName: "search-products",
        action: { kind: "click", target: { role: { role: "button", name: "Add to cart" } } },
      },
      {
        id: "i2",
        kind: "interact",
        toolName: "search-products",
        action: { kind: "click", target: { testId: "cart" } },
      },
    ];
    const back = promptTurnsToSteps(stepsToPromptTurns(reordered));
    expect(back.map((s) => s.kind)).toEqual([
      "prompt",
      "assert", // widgetRendered stays ABOVE the interacts
      "interact",
      "interact",
    ]);
    // Idempotent: a second pass keeps the same order (no snap-back).
    expect(promptTurnsToSteps(stepsToPromptTurns(back)).map((s) => s.kind)).toEqual(
      back.map((s) => s.kind),
    );
  });

  it("preserves a check INTERLEAVED between two interacts", () => {
    const interleaved: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "go" },
      {
        id: "i1",
        kind: "interact",
        toolName: "w",
        action: { kind: "click", target: { testId: "first" } },
      },
      { id: "c", kind: "assert", assertion: { type: "widgetRendered" } },
      {
        id: "i2",
        kind: "interact",
        toolName: "w",
        action: { kind: "click", target: { testId: "second" } },
      },
    ];
    const back = promptTurnsToSteps(stepsToPromptTurns(interleaved));
    expect(back.map((s) => s.kind)).toEqual([
      "prompt",
      "interact",
      "assert", // check sits BETWEEN the two interacts
      "interact",
    ]);
    // The two interacts keep their authored relative order (replay correctness).
    const interacts = back.filter((s) => s.kind === "interact");
    expect(interacts).toHaveLength(2);
  });

  it("keeps a tool-call assert BEFORE interacts as an expected tool call", () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "show cart" },
      {
        id: "a",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "view-cart", args: { args: {} } },
      },
      {
        id: "i",
        kind: "interact",
        toolName: "view-cart",
        action: { kind: "click", target: { role: { role: "button", name: "Add" } } },
      },
    ];
    const [turn] = stepsToPromptTurns(steps);
    // No interact preceded the assert → stays an expected tool call (emitted
    // before widget steps), so authoring order is preserved both ways.
    expect(turn!.expectedToolCalls).toEqual([
      { toolName: "view-cart", arguments: {} },
    ]);
    expect(promptTurnsToSteps(stepsToPromptTurns(steps)).map((s) => s.kind)).toEqual([
      "prompt",
      "assert",
      "interact",
    ]);
  });
});

describe("round-trip id stability (editor edit loop)", () => {
  // The flat step-list editor re-derives `TestStep[]` from `promptTurns` on
  // every render and writes edits back via `stepsToPromptTurns`. If step ids
  // grew each pass, React keys would change and editor inputs would lose focus
  // on every keystroke. The primary action step must reuse the turn id verbatim
  // so the loop is idempotent.
  it("keeps step ids stable across repeated turns→steps→turns passes", () => {
    const turns: PromptTurn[] = [
      {
        id: "turn-1",
        prompt: "Draw a cat",
        expectedToolCalls: [
          { toolName: "create_view", arguments: { q: "cat" } },
        ],
      },
      {
        id: "turn-2",
        prompt: "",
        expectedToolCalls: [],
        pinnedToolCall: {
          serverName: "amazon",
          toolName: "search",
          arguments: { q: "fryer" },
        },
      },
    ];
    const firstIds = promptTurnsToSteps(turns).map((s) => s.id);
    let current = turns;
    for (let i = 0; i < 5; i++) {
      const steps = promptTurnsToSteps(current);
      expect(steps.map((s) => s.id)).toEqual(firstIds);
      current = stepsToPromptTurns(steps);
    }
  });
});

describe("derived display fields", () => {
  it("query = first prompt; expectedToolCalls = toolCalledWith asserts", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "hello" },
      {
        id: "2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "t",
          args: { args: { a: 1 } },
        },
      },
    ];
    expect(deriveQuery(steps)).toBe("hello");
    expect(deriveExpectedToolCalls(steps)).toEqual([
      { toolName: "t", arguments: { a: 1 } },
    ]);
  });
});

describe("stepTurnIndices (card → implicit turn mapping)", () => {
  const click: TestStep = {
    id: "click",
    kind: "interact",
    toolName: "search-products",
    action: { kind: "click", target: { role: { role: "button" } } },
  };
  const assertCalled: TestStep = {
    id: "assert",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "search-products",
      args: { args: {} },
    },
  };

  it("folds interact/assert into the preceding prompt's turn (redbull case)", () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "Show me a redbull" },
      assertCalled,
      click,
      { ...click, id: "click2" },
    ];
    expect(stepTurnIndices(steps)).toEqual([0, 0, 0, 0]);
  });

  it("opens a new turn per prompt/toolCall step", () => {
    const steps: TestStep[] = [
      { id: "p1", kind: "prompt", prompt: "a" },
      assertCalled,
      { id: "p2", kind: "prompt", prompt: "b" },
      click,
    ];
    expect(stepTurnIndices(steps)).toEqual([0, 0, 1, 1]);
  });

  it("opens turn 0 for an interact/assert before any prompt (ensureTurn)", () => {
    const steps: TestStep[] = [click, { id: "p", kind: "prompt", prompt: "a" }];
    expect(stepTurnIndices(steps)).toEqual([0, 1]);
  });

  it("agrees with stepsToPromptTurns on the turn count", () => {
    const steps: TestStep[] = [
      { id: "p1", kind: "prompt", prompt: "a" },
      {
        id: "t1",
        kind: "toolCall",
        serverName: "amazon",
        toolName: "search-products",
        arguments: { query: "redbull" },
      },
      click,
    ];
    const indices = stepTurnIndices(steps);
    expect(indices).toEqual([0, 1, 1]);
    expect(Math.max(...indices) + 1).toBe(stepsToPromptTurns(steps).length);
  });
});
