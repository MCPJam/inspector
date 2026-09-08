import { describe, expect, it } from "vitest";
import {
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
} from "@/shared/eval-matching";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { type TestStep } from "@/shared/steps";
import {
  caseHasOwnAssertion,
  deriveCaseKind,
  displayCaseKind,
  inAppStepLabel,
  initialToolsChoice,
  isPromptFirst,
  isSimpleCaseShape,
  isToolCalledWithAssert,
  isStepCheckAssert,
  leftoverSteps,
  matchOptionsForKind,
  readSimpleCase,
  readStepChecks,
  resolveToolsQuestion,
  updateStepCheck,
  writeSimpleCase,
} from "../simple-case/simple-case-model";

const prompt = (id: string, text: string): TestStep => ({
  id,
  kind: "prompt",
  prompt: text,
});

const toolCalledWith = (
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
): TestStep => ({
  id,
  kind: "assert",
  assertion: {
    type: "toolCalledWith",
    toolName,
    args: { args },
  },
});

describe("deriveCaseKind", () => {
  it("reads capability from SDK defaults (no matchOptions, no migration)", () => {
    expect(deriveCaseKind(MATCH_OPTIONS_DEFAULTS)).toBe("capability");
    expect(deriveCaseKind(resolveMatchOptions())).toBe("capability");
  });

  it("reads regression from the strict-order + zero-extras pair", () => {
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("regression");
  });

  it("does not treat argumentMatching as part of the discriminant", () => {
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("regression");
    expect(
      deriveCaseKind({
        toolCallOrder: "ignore",
        maxExtraToolCalls: 0,
      }),
    ).toBe("capability");
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: null,
      }),
    ).toBe("capability");
  });

  it("resolves through suite defaults then case override", () => {
    expect(
      deriveCaseKind(
        resolveMatchOptions(
          { toolCallOrder: "strict", maxExtraToolCalls: 0 },
          undefined,
        ),
      ),
    ).toBe("regression");
    expect(
      deriveCaseKind(
        resolveMatchOptions(
          { toolCallOrder: "strict", maxExtraToolCalls: 0 },
          { toolCallOrder: "ignore" },
        ),
      ),
    ).toBe("capability");
    expect(
      deriveCaseKind(
        resolveMatchOptions(undefined, {
          toolCallOrder: "strict",
          maxExtraToolCalls: 0,
        }),
      ),
    ).toBe("regression");
  });

  it("lets a persisted kind win over derived matchOptions", () => {
    expect(displayCaseKind("regression", MATCH_OPTIONS_DEFAULTS)).toBe(
      "regression",
    );
    expect(
      displayCaseKind("capability", {
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("capability");
    expect(displayCaseKind(undefined, MATCH_OPTIONS_DEFAULTS)).toBe(
      "capability",
    );
  });
});

describe("initialToolsChoice", () => {
  it("is unset for a prompt-only unfinished case", () => {
    expect(initialToolsChoice({ tools: [], isNegativeTest: false })).toBe(
      "unset",
    );
  });

  it("is noTool when the saved case is already negative", () => {
    expect(initialToolsChoice({ tools: [], isNegativeTest: true })).toBe(
      "noTool",
    );
  });

  it("is tools when toolCalledWith asserts exist", () => {
    expect(
      initialToolsChoice({
        tools: [{ id: "a1", toolName: "search", arguments: {} }],
      }),
    ).toBe("tools");
  });
});

describe("matchOptionsForKind", () => {
  it("writes capability as byte-identical MATCH_OPTIONS_DEFAULTS", () => {
    expect(matchOptionsForKind("capability")).toEqual(MATCH_OPTIONS_DEFAULTS);
  });

  it("writes regression as strict order, 0 extras, partial args", () => {
    expect(matchOptionsForKind("regression")).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching: "partial",
    });
  });
});

describe("isSimpleCaseShape", () => {
  it("accepts a prompt-only case", () => {
    expect(isSimpleCaseShape([prompt("p1", "What is the status?")])).toBe(true);
  });

  it("accepts a prompt plus toolCalledWith asserts", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "List incidents"),
        toolCalledWith("a1", "list_incidents"),
        toolCalledWith("a2", "get_incident", { id: "1" }),
      ]),
    ).toBe(true);
  });

  it("rejects empty steps", () => {
    expect(isSimpleCaseShape([])).toBe(false);
  });

  it("rejects a toolCall step", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "c1",
          kind: "toolCall",
          serverName: "srv",
          toolName: "list_incidents",
          arguments: {},
        },
      ]),
    ).toBe(false);
  });

  it("accepts an interact step after the prompt", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "i1",
          kind: "interact",
          toolName: "create_view",
          action: { kind: "click", target: { testId: "canvas" } },
        },
      ]),
    ).toBe(true);
  });

  it("accepts a widget assert after the prompt", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "w1",
          kind: "assert",
          assertion: {
            kind: "textVisible",
            toolName: "create_view",
            text: "ok",
          },
        },
      ]),
    ).toBe(true);
  });

  it("rejects a non-toolCalledWith inline predicate", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "a1",
          kind: "assert",
          assertion: { type: "responseContains", needle: "ok" },
        },
      ]),
    ).toBe(false);
  });

  it("rejects a second prompt", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "first"),
        toolCalledWith("a1", "search"),
        prompt("p2", "second"),
      ]),
    ).toBe(false);
  });
});

describe("readSimpleCase / writeSimpleCase", () => {
  it("round-trips prompt, tool ids, and args", () => {
    const steps: TestStep[] = [
      prompt("p1", "Find the latest incidents"),
      toolCalledWith("a1", "list_incidents", { limit: 5 }),
      toolCalledWith("a2", "get_incident", { id: "abc" }),
    ];
    const view = readSimpleCase(steps);
    expect(view).toEqual({
      prompt: "Find the latest incidents",
      inApp: [],
      noTool: false,
      tools: [
        { id: "a1", toolName: "list_incidents", arguments: { limit: 5 } },
        { id: "a2", toolName: "get_incident", arguments: { id: "abc" } },
      ],
    });
    expect(writeSimpleCase(steps, view)).toEqual(steps);
  });

  it("keeps step 0's id when rewriting the prompt", () => {
    const next = writeSimpleCase([prompt("turn-1", "old")], {
      prompt: "new",
      tools: [],
      noTool: false,
    });
    expect(next[0]).toEqual({ id: "turn-1", kind: "prompt", prompt: "new" });
  });

  it("noTool drops only toolCalledWith asserts", () => {
    const steps: TestStep[] = [
      prompt("p1", "Do not call anything"),
      toolCalledWith("a1", "search"),
      {
        id: "extra",
        kind: "assert",
        assertion: { type: "responseContains", needle: "ok" },
      },
    ];
    const next = writeSimpleCase(steps, {
      prompt: "Do not call anything",
      tools: [{ id: "a1", toolName: "search", arguments: {} }],
      noTool: true,
    });
    expect(next).toEqual([
      prompt("p1", "Do not call anything"),
      {
        id: "extra",
        kind: "assert",
        assertion: { type: "responseContains", needle: "ok" },
      },
    ]);
    expect(next.some((s) => s.id === "a1")).toBe(false);
  });

  it("reuses existing tool assert ids by index when ids are omitted", () => {
    const prev: TestStep[] = [
      prompt("p1", "go"),
      toolCalledWith("a1", "search", { q: "old" }),
    ];
    const next = writeSimpleCase(prev, {
      prompt: "go",
      noTool: false,
      tools: [{ toolName: "search", arguments: { q: "new" } }],
    });
    expect(next[1]).toEqual(toolCalledWith("a1", "search", { q: "new" }));
  });

  it("preserves executor order on a read/write round-trip", () => {
    const interact: TestStep = {
      id: "i1",
      kind: "interact",
      toolName: "create_view",
      action: { kind: "click", target: { testId: "canvas" } },
    };
    const widget: TestStep = {
      id: "w1",
      kind: "assert",
      assertion: {
        kind: "textVisible",
        toolName: "create_view",
        text: "ok",
      },
    };
    const prev: TestStep[] = [
      prompt("p1", "Draw a box"),
      interact,
      toolCalledWith("a1", "create_view"),
      widget,
    ];
    const view = readSimpleCase(prev);
    expect(view.inApp).toEqual([interact, widget]);
    expect(writeSimpleCase(prev, view)).toEqual(prev);
    expect(
      writeSimpleCase(prev, {
        prompt: view.prompt,
        tools: [...view.tools, { toolName: "search", arguments: {} }],
        noTool: false,
      }).map((step) => step.id),
    ).toEqual(["p1", "i1", "a1", expect.any(String), "w1"]);
  });

  it("does not let interact steps flip the tools-assert set", () => {
    const interact: TestStep = {
      id: "i1",
      kind: "interact",
      toolName: "create_view",
      action: { kind: "click", target: { testId: "canvas" } },
    };
    const withTool = [prompt("p1", "go"), toolCalledWith("a1", "search")];
    const withToolAndInteract = [
      prompt("p1", "go"),
      interact,
      toolCalledWith("a1", "search"),
    ];
    expect(withTool.some(isToolCalledWithAssert)).toBe(
      withToolAndInteract.some(isToolCalledWithAssert),
    );
    expect([prompt("p1", "go")].some(isToolCalledWithAssert)).toBe(
      [prompt("p1", "go"), interact].some(isToolCalledWithAssert),
    );
    expect(
      writeSimpleCase(withToolAndInteract, readSimpleCase(withToolAndInteract)),
    ).toEqual(withToolAndInteract);
  });
});

describe("matchOptionsForKind carries argument matching over", () => {
  it("keeps an authored exact when the kind flips", () => {
    expect(
      matchOptionsForKind("regression", { argumentMatching: "exact" }),
    ).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching: "exact",
    });
    expect(
      matchOptionsForKind("capability", { argumentMatching: "exact" }),
    ).toEqual({ ...MATCH_OPTIONS_DEFAULTS, argumentMatching: "exact" });
  });

  it("falls back to the SDK default without a current value", () => {
    expect(matchOptionsForKind("capability")).toEqual(MATCH_OPTIONS_DEFAULTS);
  });
});

/*
 * The partition guard moved. It used to pin `MORE_CHECK_GROUPS` — the form's
 * own three-way grouping — against the predicate catalog. That grouping is
 * gone; the equivalent invariant now lives in `case-scorecard-model.test.ts`
 * as "offers every predicate kind exactly once, or the route owns it", over
 * the shared scorer library. The guard is the same: a kind added to the
 * catalog fails until somebody files it, rather than silently disappearing
 * from the only place it can be authored.
 */

describe("inAppStepLabel", () => {
  it("names a role locator by its accessible name, never by the role object", () => {
    expect(
      inAppStepLabel({
        id: "i1",
        kind: "interact",
        toolName: "cart",
        action: {
          kind: "click",
          target: { role: { role: "button", name: "Add to cart" } },
        },
      }),
    ).toBe("Click Add to cart");
    expect(
      inAppStepLabel({
        id: "i2",
        kind: "interact",
        toolName: "cart",
        action: { kind: "click", target: { role: { role: "button" } } },
      }),
    ).toBe("Click button");
  });

  it("follows the recorder's precedence: testId, role name, text, css", () => {
    expect(
      inAppStepLabel({
        id: "i3",
        kind: "interact",
        toolName: "cart",
        action: {
          kind: "type",
          target: { testId: "qty", role: { role: "textbox", name: "Qty" } },
          text: "2",
        },
      }),
    ).toBe("Type qty");
    expect(
      inAppStepLabel({
        id: "i4",
        kind: "interact",
        toolName: "cart",
        action: { kind: "click", target: { css: ".buy" } },
      }),
    ).toBe("Click .buy");
  });

  it("labels widget asserts with a role-located target", () => {
    expect(
      inAppStepLabel({
        id: "w1",
        kind: "assert",
        assertion: {
          kind: "elementVisible",
          toolName: "cart",
          target: { role: { role: "heading", name: "Your cart" } },
        },
      }),
    ).toContain("Your cart");
  });
});

const stepCheck = (id: string, assertion: any): TestStep => ({
  id,
  kind: "assert",
  assertion,
});

/** The shape every CLI- and SDK-authored case has. */
const goldenSteps: TestStep[] = [
  prompt("s1", "Who am I signed in as?"),
  stepCheck("a1", { type: "firstToolWas", toolName: "get_me" }),
  stepCheck("a2", {
    type: "responseContains",
    needle: "marcelo@mcpjam.com",
  }),
  stepCheck("a3", { type: "noToolErrors" }),
];

describe("resolveToolsQuestion", () => {
  it("is tools whenever a route is named, whatever else the case carries", () => {
    expect(
      resolveToolsQuestion({
        choice: "noTool",
        hasToolAsserts: true,
        hasOwnAssertion: true,
      }),
    ).toBe("tools");
  });

  it("is noTool only when the author chose it", () => {
    expect(
      resolveToolsQuestion({
        choice: "noTool",
        hasToolAsserts: false,
        hasOwnAssertion: true,
      }),
    ).toBe("noTool");
  });

  it("is checks for a positive case graded by what it carries", () => {
    expect(
      resolveToolsQuestion({
        choice: "unset",
        hasToolAsserts: false,
        hasOwnAssertion: true,
      }),
    ).toBe("checks");
  });

  it("is unset for a draft that asserts nothing", () => {
    expect(
      resolveToolsQuestion({
        choice: "unset",
        hasToolAsserts: false,
        hasOwnAssertion: false,
      }),
    ).toBe("unset");
  });

  it("falls back to unset when a stale tools choice has no rows left", () => {
    // The stored tri-state could say "tools" after the last row was removed;
    // that used to pass the block and save as a derived negative test.
    expect(
      resolveToolsQuestion({
        choice: "tools",
        hasToolAsserts: false,
        hasOwnAssertion: false,
      }),
    ).toBe("unset");
  });
});

describe("caseHasOwnAssertion", () => {
  it("counts an assert step, a rubric, or an explicit predicate list", () => {
    expect(caseHasOwnAssertion({ steps: goldenSteps })).toBe(true);
    expect(
      caseHasOwnAssertion({
        steps: [prompt("s1", "hi")],
        expectedOutput: " the answer ",
      }),
    ).toBe(true);
    expect(
      caseHasOwnAssertion({
        steps: [prompt("s1", "hi")],
        predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
      }),
    ).toBe(true);
  });

  it("does not count an inherit-mode list — the editor blanks it on save", () => {
    expect(
      caseHasOwnAssertion({
        steps: [prompt("s1", "hi")],
        predicates: { mode: "inherit", list: [{ type: "noToolErrors" }] },
      }),
    ).toBe(false);
  });

  it("is false for a prompt-only draft with an empty rubric", () => {
    expect(
      caseHasOwnAssertion({
        steps: [prompt("s1", "hi")],
        expectedOutput: "  ",
      }),
    ).toBe(false);
  });
});

describe("readStepChecks / updateStepCheck", () => {
  it("reads non-widget, non-route asserts in execution order", () => {
    expect(readStepChecks(goldenSteps)).toEqual([
      { stepId: "a1", predicate: { type: "firstToolWas", toolName: "get_me" } },
      {
        stepId: "a2",
        predicate: {
          type: "responseContains",
          needle: "marcelo@mcpjam.com",
        },
      },
      { stepId: "a3", predicate: { type: "noToolErrors" } },
    ]);
  });

  it("leaves the tool route and widget asserts to their own sections", () => {
    const steps: TestStep[] = [
      prompt("s1", "go"),
      toolCalledWith("t1", "search"),
      stepCheck("w1", { kind: "widgetRendered", toolName: "search" }),
    ];
    expect(readStepChecks(steps)).toEqual([]);
  });

  it("rewrites one check without moving or re-keying any step", () => {
    const next = updateStepCheck(goldenSteps, "a2", {
      type: "responseContains",
      needle: "nacho@mcpjam.com",
    });
    expect(next.map((step) => step.id)).toEqual(["s1", "a1", "a2", "a3"]);
    expect(next[2]).toMatchObject({
      id: "a2",
      kind: "assert",
      assertion: { type: "responseContains", needle: "nacho@mcpjam.com" },
    });
    expect(next[1]).toBe(goldenSteps[1]);
  });
});

describe("leftoverSteps", () => {
  const shownIds = (steps: TestStep[]) => {
    const view = readSimpleCase(steps);
    return [
      ...(steps[0] && isPromptFirst(steps) ? [steps[0].id] : []),
      ...view.inApp.map((step) => step.id),
      ...view.tools.map((tool) => tool.id),
      ...readStepChecks(steps).map((check) => check.stepId),
    ];
  };

  const cases: Array<[string, TestStep[]]> = [
    ["golden", goldenSteps],
    [
      "two-turn",
      [
        prompt("s1", "first"),
        toolCalledWith("t1", "search"),
        prompt("s2", "second"),
      ],
    ],
    [
      "pinned first",
      [
        {
          id: "call-1",
          kind: "toolCall",
          serverName: "srv",
          toolName: "render",
          arguments: {},
        } as TestStep,
      ],
    ],
    [
      "in the app",
      [
        prompt("s1", "go"),
        {
          id: "i1",
          kind: "interact",
          action: { kind: "click", target: { testId: "row" } },
        } as TestStep,
      ],
    ],
  ];

  it.each(cases)(
    "every step is either shown or listed as leftover (%s)",
    (_name, steps) => {
      const accounted = [
        ...shownIds(steps),
        ...leftoverSteps(steps).map((step) => step.id),
      ].sort();
      expect(accounted).toEqual(steps.map((step) => step.id).sort());
    },
  );

  it("keeps step-authored checks out of the leftover list", () => {
    expect(leftoverSteps(goldenSteps)).toEqual([]);
  });
});

describe("writeSimpleCase keeps other turns where they are", () => {
  it("round-trips a golden case without touching its checks", () => {
    const view = readSimpleCase(goldenSteps);
    const next = writeSimpleCase(goldenSteps, {
      prompt: view.prompt,
      tools: view.tools,
      noTool: false,
    });
    expect(next).toEqual(goldenSteps);
  });

  it("attaches a newly chosen tool to the FIRST turn, not the last", () => {
    const steps: TestStep[] = [
      prompt("s1", "first"),
      toolCalledWith("t1", "search"),
      prompt("s2", "second"),
      toolCalledWith("t2", "get"),
    ];
    const next = writeSimpleCase(steps, {
      prompt: "first",
      tools: [
        { id: "t1", toolName: "search", arguments: {} },
        { id: "t2", toolName: "get", arguments: {} },
        { toolName: "list", arguments: {} },
      ],
      noTool: false,
    });
    expect(next.map((step) => step.id).slice(0, 3)).toEqual([
      "s1",
      "t1",
      next[2]!.id,
    ]);
    expect(next[2]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list" },
    });
    expect(next.slice(3).map((step) => step.id)).toEqual(["s2", "t2"]);
  });

  it("never prepends a prompt turn to a case that starts with a pinned call", () => {
    const steps: TestStep[] = [
      {
        id: "call-1",
        kind: "toolCall",
        serverName: "srv",
        toolName: "render",
        arguments: {},
      } as TestStep,
    ];
    expect(
      writeSimpleCase(steps, { prompt: "", tools: [], noTool: true }),
    ).toEqual(steps);
  });
});

describe("isPromptFirst", () => {
  it("is true for an empty draft and a normal case, false for a pinned head", () => {
    expect(isPromptFirst([])).toBe(true);
    expect(isPromptFirst(goldenSteps)).toBe(true);
    expect(
      isPromptFirst([
        {
          id: "call-1",
          kind: "toolCall",
          serverName: "srv",
          toolName: "render",
          arguments: {},
        } as TestStep,
      ]),
    ).toBe(false);
  });
});

describe("an advisory tool assert is not the route", () => {
  const advisoryTool = {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "get_me",
      args: { args: {} },
      role: "advisory",
      severity: "warn",
    },
  } as unknown as TestStep;
  const gatingTool = {
    id: "a2",
    kind: "assert",
    assertion: { type: "toolCalledWith", toolName: "get_me", args: { args: {} } },
  } as unknown as TestStep;

  it("routes only on a gating tool assert", () => {
    // `deriveExpectedToolCalls` and `stepsToPromptTurns` both skip an advisory
    // `toolCalledWith`, so it never becomes a matcher expectation. Reading it
    // as the route would show a Gate route on a case the backend does not
    // route at all.
    expect(isToolCalledWithAssert(gatingTool)).toBe(true);
    expect(isToolCalledWithAssert(advisoryTool)).toBe(false);
  });

  it("files the advisory one as a step scorer instead, so it stays visible", () => {
    expect(isStepCheckAssert(advisoryTool)).toBe(true);
    expect(isStepCheckAssert(gatingTool)).toBe(false);
    expect(readStepChecks([prompt("p1", "go"), advisoryTool])).toHaveLength(1);
  });

  it("keeps it out of the tool list the route question renders", () => {
    expect(readSimpleCase([prompt("p1", "go"), advisoryTool]).tools).toEqual([]);
    expect(readSimpleCase([prompt("p1", "go"), gatingTool]).tools).toHaveLength(1);
  });

  it("does not strand it in the leftover list", () => {
    // `leftoverSteps` is the complement of what the form renders; a step that
    // is neither the route nor a step check would vanish from every editor.
    expect(leftoverSteps([prompt("p1", "go"), advisoryTool])).toEqual([]);
  });
});

describe("readSimpleCase on an empty draft", () => {
  it("reads a case with no steps at all instead of throwing", () => {
    // A brand-new case has nothing until the first keystroke; the narrowing
    // helpers dereference `.kind`, so an unguarded `steps[0]` crashes the pane.
    expect(readSimpleCase([])).toMatchObject({ prompt: "", tools: [] });
  });
});

describe("writeSimpleCase on an empty draft", () => {
  it("mints the first prompt instead of throwing", () => {
    const next = writeSimpleCase([], {
      prompt: "hi",
      tools: [],
      noTool: false,
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "prompt", prompt: "hi" });
  });
});
