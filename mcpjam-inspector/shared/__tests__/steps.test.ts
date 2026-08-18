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
        assertion: {
          kind: "textVisible",
          toolName: "create_view",
          text: "Hello",
        },
      },
    ];
    for (const s of steps)
      expect(testStepSchema.safeParse(s).success).toBe(true);
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

  it("rejects an unknown field on a step, and on a step's sub-objects", () => {
    // The step union is CLOSED. A mis-mapped import field must fail here
    // rather than be stripped: the Convex mirror is built from `v.object` and
    // has always rejected unknown keys, so a permissive schema meant the two
    // validators disagreed about the same case — discovered at ingest, far
    // from the converter that wrote it.
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "prompt",
        prompt: "hi",
        retries: 3,
      }).success
    ).toBe(false);
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "interact",
        toolName: "t",
        action: {
          kind: "click",
          target: { testId: "confirm", xpath: "//button[1]" },
        },
      }).success
    ).toBe(false);
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "assert",
        assertion: {
          kind: "textVisible",
          toolName: "t",
          text: "y",
          negate: true,
        },
      }).success
    ).toBe(false);
  });

  it("closes every strict action and assertion variant", () => {
    // Table-driven so a variant cannot be closed in the schema and left
    // untested here — an untested closure is one a later edit silently
    // reopens. `base` is a valid step; `stray` is the one undeclared key.
    const cases: Array<{ label: string; step: unknown }> = [
      {
        label: "interact/key",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: { kind: "key", key: "Enter", modifiers: ["shift"] },
        },
      },
      {
        label: "interact/scroll",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: { kind: "scroll", direction: "down", smooth: true },
        },
      },
      {
        label: "interact/wait",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: { kind: "wait", ms: 100, reason: "settle" },
        },
      },
      {
        label: "interact/type",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: {
            kind: "type",
            target: { testId: "q" },
            text: "hi",
            delayMs: 10,
          },
        },
      },
      {
        label: "toolCall",
        step: {
          id: "x",
          kind: "toolCall",
          serverName: "s",
          toolName: "t",
          arguments: {},
          timeoutMs: 1000,
        },
      },
      {
        label: "assert/elementVisible",
        step: {
          id: "x",
          kind: "assert",
          assertion: {
            kind: "elementVisible",
            toolName: "t",
            target: { testId: "q" },
            within: 500,
          },
        },
      },
      {
        label: "assert/inputValue",
        step: {
          id: "x",
          kind: "assert",
          assertion: {
            kind: "inputValue",
            toolName: "t",
            target: { testId: "q" },
            equals: "x",
            trim: true,
          },
        },
      },
      {
        label: "assert/widgetToolCalled",
        step: {
          id: "x",
          kind: "assert",
          assertion: {
            kind: "widgetToolCalled",
            toolName: "t",
            calledToolName: "u",
            times: 2,
          },
        },
      },
      {
        label: "locator/role",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: {
            kind: "click",
            target: { role: { role: "button", label: "Confirm" } },
          },
        },
      },
    ];
    for (const { label, step } of cases) {
      expect(testStepSchema.safeParse(step).success, label).toBe(false);
    }
  });

  it("rejects null and empty values where a value is required", () => {
    const bad: Array<{ label: string; step: unknown }> = [
      { label: "null step", step: null },
      { label: "empty object", step: {} },
      {
        label: "null arguments",
        step: {
          id: "x",
          kind: "toolCall",
          serverName: "s",
          toolName: "t",
          arguments: null,
        },
      },
      {
        label: "empty serverName",
        step: {
          id: "x",
          kind: "toolCall",
          serverName: "",
          toolName: "t",
          arguments: {},
        },
      },
      {
        label: "locator with no reference point",
        step: {
          id: "x",
          kind: "interact",
          toolName: "t",
          action: { kind: "click", target: {} },
        },
      },
      {
        label: "null assertion",
        step: { id: "x", kind: "assert", assertion: null },
      },
    ];
    for (const { label, step } of bad) {
      expect(testStepSchema.safeParse(step).success, label).toBe(false);
    }
    // Two emptys the STRUCTURAL schema accepts on purpose, recorded so the
    // boundary is stated rather than assumed. An empty prompt string is a
    // legitimate (if useless) authored value, and an empty `id` is caught one
    // layer up — `assertValidSteps` in the Convex mirror requires a non-empty
    // id, as does the suite-file validator. Tightening `id` here is a change
    // to the union's field TYPES, not to its unknown-key policy, so it is not
    // made as a side effect of closing the objects.
    expect(
      testStepSchema.safeParse({ id: "x", kind: "prompt", prompt: "" }).success
    ).toBe(true);
    expect(
      testStepSchema.safeParse({ id: "", kind: "prompt", prompt: "hi" }).success
    ).toBe(true);
  });

  it("leaves the reused predicate union open", () => {
    // The stated exception. Predicates are a separate contract module with
    // their own mirror and their own fixtures; closing them is a change made
    // there, so a stray key inside one must still parse here — otherwise this
    // union quietly acquired a second contract's policy.
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "assert",
        assertion: {
          type: "widgetRendered",
          toolName: "t",
          somethingThePredicateContractDoesNotDeclare: true,
        },
      }).success
    ).toBe(true);
  });

  it("keeps a tool call's own arguments object open", () => {
    // `arguments` is the SERVER's input shape, not ours. Closing it would mean
    // this contract had to know every tool's parameters.
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "toolCall",
        serverName: "s",
        toolName: "t",
        arguments: { anythingTheServerDeclares: true, nested: { ok: 1 } },
      }).success
    ).toBe(true);
  });

  it("refuses an assertion declaring BOTH discriminators", () => {
    // Ambiguous by construction, and resolving it is worse than refusing it:
    // the widget branch is closed and rejects the stray `type`, while the
    // predicate branch is open and would accept the same object, strip every
    // widget field, and silently turn "the word 'Refunded' is on screen" into
    // "no tool errors occurred" — which passes almost always. A green eval
    // checking something nobody asked for is the worst outcome available.
    expect(
      testStepSchema.safeParse({
        id: "x",
        kind: "assert",
        assertion: {
          kind: "textVisible",
          type: "noToolErrors",
          toolName: "t",
          text: "Refunded",
        },
      }).success
    ).toBe(false);
  });

  it("discriminates WidgetAssertion (kind) from Predicate (type)", () => {
    expect(
      isWidgetAssertion({ kind: "textVisible", toolName: "t", text: "x" })
    ).toBe(true);
    expect(isWidgetAssertion({ type: "widgetRendered", toolName: "t" })).toBe(
      false
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
  it("strips unknown keys instead of dropping the whole step", () => {
    // `normalizeSteps` is NOT a contract boundary. It runs on the editor load
    // path, the execution paths, and the LLM case-GENERATION path, where the
    // input is model output nobody validated. Letting the union's strictness
    // reach here would turn "the generator invented a field" into "the whole
    // step disappeared" — a generated case silently losing a prompt is a worse
    // outcome than the stray key ever was. The strict boundaries (route Zod,
    // Convex `v.object`) still reject loudly; this one cleans and keeps.
    const generated = [
      { id: "1", kind: "prompt", prompt: "a", confidence: 0.9 },
      {
        id: "2",
        kind: "interact",
        toolName: "t",
        action: {
          kind: "click",
          target: { testId: "confirm", xpath: "//button" },
        },
      },
      {
        id: "3",
        kind: "assert",
        assertion: {
          kind: "textVisible",
          toolName: "t",
          text: "ok",
          negate: false,
        },
      },
    ];
    const normalized = normalizeSteps(generated);
    expect(normalized).toHaveLength(3);
    expect(normalized[0]).toEqual({ id: "1", kind: "prompt", prompt: "a" });
    expect(normalized[1]).toEqual({
      id: "2",
      kind: "interact",
      toolName: "t",
      action: { kind: "click", target: { testId: "confirm" } },
    });
    expect(normalized[2]).toEqual({
      id: "3",
      kind: "assert",
      assertion: { kind: "textVisible", toolName: "t", text: "ok" },
    });
  });

  it("drops — never throws — when an unknown value cannot be cloned", () => {
    // The values under unrecognized keys are precisely the ones nothing has
    // validated, so a function or a symbol can reach here (a client draft
    // holding an event handler, say). `structuredClone` throws on those, and
    // letting it escape would take down the whole array over one bad step —
    // strictly worse than the drop it replaced.
    const steps = [
      { id: "1", kind: "prompt", prompt: "kept" },
      { id: "2", kind: "prompt", prompt: "b", onChange: () => undefined },
      { id: "3", kind: "prompt", prompt: "also kept" },
    ];
    expect(() => normalizeSteps(steps)).not.toThrow();
    expect(normalizeSteps(steps).map((s) => s.id)).toEqual(["1", "3"]);
  });

  it("still drops a step that is broken for any OTHER reason", () => {
    // The re-validation is what makes stripping safe: nothing survives that
    // does not parse cleanly afterwards.
    expect(
      normalizeSteps([
        { id: "1", kind: "navigate", url: "https://example.com" },
        {
          id: "2",
          kind: "interact",
          toolName: "t",
          action: { kind: "click", target: {} },
        },
        { id: "3", kind: "prompt" },
        { id: "4", kind: "prompt", prompt: "kept", stray: 1 },
      ]).map((s) => s.id)
    ).toEqual(["4"]);
  });

  it("recovers the INTENDED assertion when both discriminators appear", () => {
    // The contract boundaries refuse this payload outright. Here — the
    // shape-normalizer on the generation and load paths — the recovery is to
    // strip the stray discriminator and keep the widget assertion the author
    // wrote, which is exactly what the schema did before it closed. What must
    // never happen is the other resolution: quietly keeping `type` and
    // discarding the DOM check.
    const [step] = normalizeSteps([
      {
        id: "1",
        kind: "assert",
        assertion: {
          kind: "textVisible",
          type: "noToolErrors",
          toolName: "t",
          text: "Refunded",
        },
      },
    ]);
    expect(step).toEqual({
      id: "1",
      kind: "assert",
      assertion: { kind: "textVisible", toolName: "t", text: "Refunded" },
    });
  });

  it("ACCEPTS a predicate carrying an undeclared field", () => {
    // Predicates are the stated exception: the step PARSES rather than
    // failing, so it survives whole. The stray key itself is dropped by zod's
    // ordinary strip on a non-strict object — which is what this normalizer
    // has always returned, and is unchanged by closing the step objects.
    const [step] = normalizeSteps([
      {
        id: "1",
        kind: "assert",
        assertion: { type: "widgetRendered", toolName: "t", extra: true },
      },
    ]);
    expect(step).toEqual({
      id: "1",
      kind: "assert",
      assertion: { type: "widgetRendered", toolName: "t" },
    });
  });

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
        expectedToolCalls: [
          { toolName: "create_view", arguments: { q: "cat" } },
        ],
        widgetChecks: [
          {
            toolName: "create_view",
            steps: [
              { kind: "click", target: { testId: "canvas" } },
              {
                kind: "assert",
                assertion: { type: "textVisible", text: "Hello" },
              },
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
              {
                kind: "assert",
                assertion: { type: "textVisible", text: "Hi" },
              },
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
      pinnedToolCall: {
        serverName: "amazon",
        toolName: "search",
        arguments: { q: "fryer" },
      },
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
        action: {
          kind: "click",
          target: { role: { role: "button", name: "Add to cart" } },
        },
      },
      {
        id: "a",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "clear-cart",
          args: { args: {} },
        },
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
        action: {
          kind: "click",
          target: { role: { role: "button", name: "Add to cart" } },
        },
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
    expect(
      promptTurnsToSteps(stepsToPromptTurns(back)).map((s) => s.kind)
    ).toEqual(back.map((s) => s.kind));
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
        assertion: {
          type: "toolCalledWith",
          toolName: "view-cart",
          args: { args: {} },
        },
      },
      {
        id: "i",
        kind: "interact",
        toolName: "view-cart",
        action: {
          kind: "click",
          target: { role: { role: "button", name: "Add" } },
        },
      },
    ];
    const [turn] = stepsToPromptTurns(steps);
    // No interact preceded the assert → stays an expected tool call (emitted
    // before widget steps), so authoring order is preserved both ways.
    expect(turn!.expectedToolCalls).toEqual([
      { toolName: "view-cart", arguments: {} },
    ]);
    expect(
      promptTurnsToSteps(stepsToPromptTurns(steps)).map((s) => s.kind)
    ).toEqual(["prompt", "assert", "interact"]);
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
