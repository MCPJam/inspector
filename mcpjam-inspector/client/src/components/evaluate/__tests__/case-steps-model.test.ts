import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import {
  insertStepAfter,
  type InteractStep,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import {
  buildCaseScorecard,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";
import {
  moveActionBlock,
  removeActionWithChecks,
} from "../case-spine/case-spine-model";
import {
  afterRunSection,
  buildExecutionPreview,
  flattenCaseSteps,
  groupCaseSteps,
  moveAssertionTo,
  STEP_COPY,
  type ExecutionPreviewInput,
  type PreviewItem,
} from "../case-steps/case-steps-model";

const prompt = (id: string, text = "ask"): TestStep => ({
  id,
  kind: "prompt",
  prompt: text,
});
const check = (id: string, assertion: Predicate = { type: "noToolErrors" }) =>
  ({ id, kind: "assert", assertion }) satisfies TestStep;
const widget = (id: string, assertion: WidgetAssertion): TestStep => ({
  id,
  kind: "assert",
  assertion,
});
const interact = (
  id: string,
  action: InteractStep["action"] = { kind: "click", target: { testId: "x" } },
  toolName = "cart_view",
): TestStep => ({ id, kind: "interact", toolName, action });
const tool = (id: string, toolName = "get_me"): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "accounts",
  toolName,
  arguments: {},
});
const toolAssert = (id: string, toolName: string) =>
  check(id, { type: "toolCalledWith", toolName, args: { args: {} } });

const ids = (steps: { step: TestStep }[]) => steps.map((row) => row.step.id);

const FIXTURES: [string, TestStep[]][] = [
  ["no steps", []],
  ["[p]", [prompt("p")]],
  ["[a]", [check("a")]],
  ["[a, p, a]", [check("a0"), prompt("p"), check("a1")]],
  [
    "[p, a, i, a, a, t]",
    [
      prompt("p"),
      check("a1"),
      interact("i"),
      check("a2"),
      check("a3"),
      tool("t"),
    ],
  ],
  ["[p, p]", [prompt("p1"), prompt("p2")]],
  ["[t, a]", [tool("t"), check("a")]],
];

describe("groupCaseSteps", () => {
  it.each<[string, TestStep[], string[], [string, number, string[]][]]>([
    ["no steps", [], [], []],
    ["[p]", [prompt("p")], [], [["p", 1, []]]],
    ["[a]", [check("a")], ["a"], []],
    [
      "[a, p, a]",
      [check("a0"), prompt("p"), check("a1")],
      ["a0"],
      [["p", 1, ["a1"]]],
    ],
    [
      "[p, a, i, a, a, t]",
      FIXTURES[4]![1],
      [],
      [
        ["p", 1, ["a1"]],
        ["i", 2, ["a2", "a3"]],
        ["t", 3, []],
      ],
    ],
    [
      "[p, p]",
      [prompt("p1"), prompt("p2")],
      [],
      [
        ["p1", 1, []],
        ["p2", 2, []],
      ],
    ],
    ["[t, a]", [tool("t"), check("a")], [], [["t", 1, ["a"]]]],
  ])("%s", (_name, steps, leading, expected) => {
    const groups = groupCaseSteps(steps);
    expect(ids(groups.leading)).toEqual(leading);
    expect(
      groups.steps.map((action) => [
        action.step.id,
        action.ordinal,
        ids(action.checks),
      ]),
    ).toEqual(expected);
    expect(groups.outcomeOrdinal).toBe(expected.length + 1);
    expect(groups.afterRunOrdinal).toBe(expected.length + 2);
  });

  it("numbers Expected outcome 1 and After-run 2 when there are no steps", () => {
    expect(groupCaseSteps([])).toMatchObject({
      outcomeOrdinal: 1,
      afterRunOrdinal: 2,
    });
  });
});

function expectRoundTrip(steps: TestStep[]) {
  const flat = flattenCaseSteps(groupCaseSteps(steps));
  expect(flat).not.toBe(steps);
  expect(flat).toEqual(steps);
  flat.forEach((step, index) => expect(step).toBe(steps[index]));
}

describe("round trip", () => {
  it.each(FIXTURES)("%s", (_name, steps) => expectRoundTrip(steps));

  const largest = FIXTURES[4]![1];
  it.each<[string, TestStep[]]>([
    ["moveActionBlock", moveActionBlock(largest, "i", -1)],
    ["removeActionWithChecks", removeActionWithChecks(largest, "i")],
    ["insertStepAfter", insertStepAfter(largest, "i", check("new"))],
    ["moveAssertionTo", moveAssertionTo(largest, "a2", "t")],
  ])("after %s", (_name, steps) => expectRoundTrip(steps));

  it("reads only .step from the groups", () => {
    const groups = groupCaseSteps(largest);
    const scrambled = {
      leading: groups.leading,
      steps: groups.steps.map((action) => ({
        ...action,
        index: 99,
        ordinal: 99,
        turnIndex: 99,
        lastIndex: 99,
      })),
    };
    expect(flattenCaseSteps(scrambled)).toEqual(largest);
  });
});

describe("moveAssertionTo", () => {
  const steps = [
    check("a0"),
    prompt("p"),
    check("a1"),
    check("a2"),
    interact("i"),
    check("a3"),
  ];
  const order = (next: TestStep[]) => next.map((step) => step.id);

  it.each<[string, string, string | null, string[]]>([
    ["to a later step", "a1", "i", ["a0", "p", "a2", "i", "a3", "a1"]],
    ["to an earlier step", "a3", "p", ["a0", "p", "a1", "a2", "a3", "i"]],
    [
      "to its own step (end of block)",
      "a1",
      "p",
      ["a0", "p", "a2", "a1", "i", "a3"],
    ],
    ["to null (index 0)", "a3", null, ["a3", "a0", "p", "a1", "a2", "i"]],
  ])("%s", (_name, assertId, stepId, expected) => {
    const before = [...steps];
    const next = moveAssertionTo(steps, assertId, stepId);
    expect(order(next)).toEqual(expected);
    expect(steps).toEqual(before);
    expect(next.find((step) => step.id === assertId)).toBe(
      steps.find((step) => step.id === assertId),
    );
  });

  it.each<[string, string, string | null]>([
    ["unknown assert id", "nope", "p"],
    ["a step id passed as the assert", "p", "i"],
    ["unknown target", "a1", "nope"],
    ["an assert id passed as the target", "a1", "a3"],
  ])("returns the same array for %s", (_name, assertId, stepId) => {
    expect(moveAssertionTo(steps, assertId, stepId)).toBe(steps);
  });
});

// ── after-run section ────────────────────────────────────────────

const D1: Predicate = { type: "responseContains", needle: "hello" };
const D2: Predicate = { type: "responseMatches", pattern: "ok" };
const C1: Predicate = { type: "responseContains", needle: "case one" };
const C2: Predicate = { type: "responseContains", needle: "case two" };

const base: CaseScorecardInput = {
  steps: [prompt("p")],
  toolsChoice: "unset",
  numbering: "action",
};

const section = (input: Partial<CaseScorecardInput>) =>
  afterRunSection(buildCaseScorecard({ ...base, ...input }));
const preds = (rows: { predicate?: Predicate }[]) =>
  rows.map((row) => row.predicate);

describe("afterRunSection", () => {
  it("inherit with 2 defaults lists the defaults only", () => {
    const s = section({ suiteDefaultPredicates: [D1, D2] });
    expect(preds(s.suiteRows)).toEqual([D1, D2]);
    expect(s.caseRows).toEqual([]);
    expect(s.replacedSuiteCount).toBe(0);
    expect(s.isEmpty).toBe(false);
  });

  it("extend lists suite defaults first, then the case's, each in index order", () => {
    const s = section({
      suiteDefaultPredicates: [D1, D2],
      predicates: { mode: "extend", list: [C1, C2] },
    });
    expect(preds(s.suiteRows)).toEqual([D1, D2]);
    expect(preds(s.caseRows)).toEqual([C1, C2]);
    expect(s.suiteRows.map((row) => row.predicateIndex)).toEqual([0, 1]);
    expect(s.caseRows.map((row) => row.predicateIndex)).toEqual([0, 1]);
  });

  it("replace drops the suite rows and counts them", () => {
    const s = section({
      suiteDefaultPredicates: [D1, D2],
      predicates: { mode: "replace", list: [C1] },
    });
    expect(s.suiteRows).toEqual([]);
    expect(preds(s.caseRows)).toEqual([C1]);
    expect(s.replacedSuiteCount).toBe(2);
  });

  it("puts a noTool route first", () => {
    const s = section({ toolsChoice: "noTool" });
    expect(s.route?.kind).toBe("noTools");
    expect(s.route?.row.provenance).toBe("route");
    expect(s.isEmpty).toBe(false);
  });

  it("names the tools of a regression route, '?' for an empty name", () => {
    const s = section({
      steps: [prompt("p"), toolAssert("a1", "get_me"), toolAssert("a2", " ")],
      toolsChoice: "tools",
      kind: "regression",
    });
    expect(s.route).toMatchObject({
      kind: "exactOrder",
      toolNames: ["get_me", "?"],
    });
  });

  it("gives no route row for a capability route", () => {
    const s = section({
      steps: [prompt("p"), toolAssert("a1", "get_me")],
      toolsChoice: "tools",
      kind: "capability",
    });
    expect(s.route).toBeNull();
  });

  it.each<[string, TestStep[]]>([
    ["leading assertion (pinnedFirst)", [check("a0"), prompt("p")]],
    ["model-free case", [tool("t"), check("a")]],
  ])("gives no route row for a locked route: %s", (_name, steps) => {
    const s = section({ steps, toolsChoice: "noTool" });
    expect(s.route).toBeNull();
  });

  it("does not list a suppressed standard default", () => {
    const s = section({
      suiteDefaultPredicates: [{ type: "noToolErrors" }, D1],
      suppressedSuiteStandardCheckIds: ["response.errors"],
    });
    expect(preds(s.suiteRows)).toEqual([D1]);
  });

  it("is empty when nothing is graded after the run", () => {
    expect(section({})).toEqual({
      route: null,
      suiteRows: [],
      caseRows: [],
      replacedSuiteCount: 0,
      isEmpty: true,
    });
  });
});

// ── execution preview ────────────────────────────────────────────

const workedSteps: TestStep[] = [
  prompt("p0", "Draw a rectangle"),
  check("a1"),
  check("a2", { type: "responseContains", needle: "rectangle" }),
  interact("i3", { kind: "click", target: { testId: "save" } }, "canvas"),
  widget("a4", { kind: "textVisible", toolName: "canvas", text: "Saved" }),
];

const worked: ExecutionPreviewInput = {
  steps: workedSteps,
  toolsChoice: "noTool",
  suiteDefaultPredicates: [D1, D2],
  predicates: { mode: "extend", list: [C1] },
  expectedOutput: "A rectangle is on the canvas",
  suiteJudgeConfig: { goalCompletion: { autoRun: true } },
};

describe("buildExecutionPreview: order and keys", () => {
  it("lists the worked case item by item", () => {
    expect(buildExecutionPreview(worked)).toEqual<PreviewItem[]>([
      {
        key: "action:p0",
        marker: "agent",
        title: "Step 1 · User prompt",
        badge: "agent runs",
        detail: "“Draw a rectangle”",
      },
      {
        key: "check:a1",
        marker: "check",
        title: "No tool errors so far",
        detail: "Blocking: a miss fails the run and skips later steps.",
      },
      {
        key: "check:a2",
        marker: "check",
        title: "Response contains “rectangle”",
        detail: "Blocking: a miss fails the run and skips later steps.",
      },
      {
        key: "action:i3",
        marker: "runner",
        title: "Step 2 · Interact",
        badge: "no model",
        detail: `MCPJam's runner will click testId "save" in the canvas view.`,
      },
      {
        key: "check:a4",
        marker: "check",
        title: "Text visible “Saved”",
        detail: "Checked in the live view. Blocking.",
      },
      {
        key: "outcome",
        marker: "outcome",
        title: "Expected outcome",
        detail: "“A rectangle is on the canvas”",
      },
      {
        key: "after-run",
        marker: "agent",
        title: "End-of-run evaluation",
        lines: [
          {
            suite: true,
            text: "Judge grades the expected outcome (non-blocking)",
          },
          { suite: true, text: "2 suite evaluators" },
          { suite: false, text: "No tools called · 1 case assertion" },
        ],
      },
    ]);
  });

  it("flattens the worked groups back to the same objects", () => {
    expectRoundTrip(workedSteps);
  });

  it("leads with leading assertions, and a leading assert locks the route", () => {
    const items = buildExecutionPreview({
      ...worked,
      steps: [check("a0"), ...workedSteps],
    });
    expect(items.map((item) => item.key)).toEqual([
      "check:a0",
      "action:p0",
      "check:a1",
      "check:a2",
      "action:i3",
      "check:a4",
      "outcome",
      "after-run",
    ]);
    expect(items.at(-1)?.lines?.at(-1)).toEqual({
      suite: false,
      text: "1 case assertion",
    });
  });

  it("lists only Expected outcome and End-of-run for an empty case", () => {
    const items = buildExecutionPreview({ steps: [], toolsChoice: "unset" });
    expect(items.map((item) => [item.key, item.marker])).toEqual([
      ["outcome", "outcome"],
      ["after-run", "agent"],
    ]);
  });

  it("marks a tool call as runner", () => {
    const [item] = buildExecutionPreview({
      steps: [tool("t")],
      toolsChoice: "unset",
    });
    expect(item).toMatchObject({
      key: "action:t",
      marker: "runner",
      title: "Step 1 · Call tool",
      badge: "no model",
    });
  });
});

const detailOf = (step: TestStep) =>
  buildExecutionPreview({
    steps: [prompt("p"), step],
    toolsChoice: "unset",
  })[1];

describe("buildExecutionPreview: strings", () => {
  it.each<[string, string]>([
    ["", "No prompt written yet."],
    ["   ", "No prompt written yet."],
    ["  Hi  ", "“Hi”"],
  ])("prompt %j", (text, detail) => {
    const [item] = buildExecutionPreview({
      steps: [prompt("p", text)],
      toolsChoice: "unset",
    });
    expect(item?.detail).toBe(detail);
  });

  const runner = (text: string, view = "cart_view") =>
    `MCPJam's runner will ${text} in the ${view} view.`;
  it.each<[string, TestStep, string]>([
    ["click", interact("i"), runner('click testId "x"')],
    [
      "click with role",
      interact("i", {
        kind: "click",
        target: { role: { role: "button", name: "Pay" } },
      }),
      runner('click button "Pay"'),
    ],
    [
      "type",
      interact("i", { kind: "type", target: { testId: "q" }, text: " shoes " }),
      runner('type “shoes” into testId "q"'),
    ],
    [
      "key",
      interact("i", { kind: "key", key: "Enter" }),
      runner("press Enter"),
    ],
    [
      "scroll",
      interact("i", { kind: "scroll", direction: "down" }),
      runner("scroll down"),
    ],
    [
      "wait",
      interact("i", { kind: "wait", ms: 1500 }),
      runner("wait 1,500 ms"),
    ],
    ["no tool", interact("i", undefined, " "), "Pick a view and a target."],
    [
      "incomplete click locator",
      interact("i", { kind: "click", target: { testId: " " } }),
      "Pick a view and a target.",
    ],
    [
      "incomplete type locator",
      interact("i", { kind: "type", target: { css: "" }, text: "x" }),
      "Pick a view and a target.",
    ],
    [
      "empty key",
      interact("i", { kind: "key", key: " " }),
      "Pick a view and a target.",
    ],
    [
      "call tool",
      tool("t", "get_me"),
      "MCPJam calls get_me on accounts directly.",
    ],
    ["call tool with no name", tool("t", ""), "Pick a tool."],
  ])("step detail: %s", (_name, step, detail) => {
    expect(detailOf(step)?.detail).toBe(detail);
  });

  it.each<[string, WidgetAssertion, string]>([
    [
      "textVisible",
      { kind: "textVisible", toolName: "v", text: " Saved " },
      "Text visible “Saved”",
    ],
    [
      "elementVisible",
      { kind: "elementVisible", toolName: "v", target: { testId: "ok" } },
      'Element visible “testId "ok"”',
    ],
    [
      "elementHidden",
      { kind: "elementHidden", toolName: "v", target: { text: "Busy" } },
      'Element hidden “text "Busy"”',
    ],
    [
      "elementVisible, incomplete locator",
      { kind: "elementVisible", toolName: "v", target: { testId: " " } },
      "Element visible",
    ],
    [
      "inputValue",
      {
        kind: "inputValue",
        toolName: "v",
        target: { testId: "qty" },
        equals: "2",
      },
      'Input value equals “testId "qty" = “2””',
    ],
    [
      "inputValue, empty equals",
      {
        kind: "inputValue",
        toolName: "v",
        target: { testId: "qty" },
        equals: "",
      },
      "Input value equals",
    ],
    [
      "widgetToolCalled",
      { kind: "widgetToolCalled", toolName: "v", calledToolName: "checkout" },
      "View called a tool “checkout”",
    ],
  ])("widget title: %s", (_name, assertion, title) => {
    expect(detailOf(widget("w", assertion))).toEqual({
      key: "check:w",
      marker: "check",
      title,
      detail: "Checked in the live view. Blocking.",
    });
  });

  it.each<[string, Predicate, string, string]>([
    [
      "required",
      { type: "responseContains", needle: "x" },
      "Response contains “x”",
      "Blocking: a miss fails the run and skips later steps.",
    ],
    [
      "advisory",
      { type: "responseContains", needle: "x", role: "advisory" },
      "Response contains “x”",
      "Non-blocking: a miss only warns.",
    ],
    [
      "ellipsis label quotes its operand",
      {
        type: "toolCalledWith",
        toolName: "read_me",
        args: { args: {} },
      },
      "Tool was called with “read_me”",
      "Blocking: a miss fails the run and skips later steps.",
    ],
    [
      "inline label",
      { type: "noToolErrors", role: "advisory" },
      "No tool errors so far",
      "Non-blocking: a miss only warns.",
    ],
  ])("predicate assertion: %s", (_name, predicate, title, detail) => {
    expect(detailOf(check("c", predicate))).toMatchObject({ title, detail });
  });

  it.each<[string | undefined, string]>([
    [undefined, "No expected outcome written yet."],
    ["", "No expected outcome written yet."],
    ["   ", "No expected outcome written yet."],
    [" Done ", "“Done”"],
  ])("expected outcome %j", (expectedOutput, detail) => {
    const items = buildExecutionPreview({
      steps: [],
      toolsChoice: "unset",
      expectedOutput,
    });
    expect(items[0]?.detail).toBe(detail);
  });

  it("exports the step copy the editor shares", () => {
    expect(STEP_COPY).toEqual({
      prompt: {
        title: "User prompt",
        subtitle: "The agent runs and chooses tools.",
      },
      interact: {
        title: "Interact",
        subtitle: "MCPJam acts in the rendered view. No model.",
      },
      toolCall: {
        title: "Call tool",
        subtitle: "MCPJam calls the tool directly. No model.",
      },
    });
  });
});

const linesOf = (input: Partial<ExecutionPreviewInput>) =>
  buildExecutionPreview({
    steps: [prompt("p")],
    toolsChoice: "unset",
    ...input,
  }).at(-1)?.lines;

describe("End-of-run lines", () => {
  const skip = { goalCompletion: { enabled: false } };
  it.each<
    [string, Partial<ExecutionPreviewInput>, { suite: boolean; text: string }]
  >([
    [
      "off",
      { suiteJudgeConfig: { goalCompletion: { enabled: false } } },
      { suite: true, text: "Judge: off for this suite" },
    ],
    [
      "off and skipped (off wins)",
      {
        suiteJudgeConfig: { goalCompletion: { enabled: false } },
        judgeConfigOverride: skip,
      },
      { suite: true, text: "Judge: off for this suite" },
    ],
    [
      "skipped",
      {
        suiteJudgeConfig: { goalCompletion: { autoRun: true } },
        judgeConfigOverride: skip,
      },
      { suite: false, text: "Judge: skipped for this case" },
    ],
    ["unknown", {}, { suite: true, text: "Judge: state unavailable" }],
    [
      "automatic advisory",
      { suiteJudgeConfig: { goalCompletion: { autoRun: true } } },
      { suite: true, text: "Judge grades the expected outcome (non-blocking)" },
    ],
    [
      "gating required",
      { suiteJudgeConfig: { goalCompletion: { role: "required" } } },
      { suite: true, text: "Judge grades the expected outcome (blocking)" },
    ],
  ])("judge: %s", (_name, input, line) => {
    expect(linesOf(input)?.[0]).toEqual(line);
  });

  it.each<
    [string, Partial<ExecutionPreviewInput>, { suite: boolean; text: string }]
  >([
    ["0", {}, { suite: true, text: "0 suite evaluators" }],
    [
      "1",
      { suiteDefaultPredicates: [D1] },
      { suite: true, text: "1 suite evaluator" },
    ],
    [
      "2",
      { suiteDefaultPredicates: [D1, D2] },
      { suite: true, text: "2 suite evaluators" },
    ],
    [
      "suppressed not counted",
      {
        suiteDefaultPredicates: [{ type: "noToolErrors" }, D1],
        suppressedSuiteStandardCheckIds: ["response.errors"],
      },
      { suite: true, text: "1 suite evaluator" },
    ],
    [
      "replaced",
      {
        suiteDefaultPredicates: [D1, D2],
        predicates: { mode: "replace", list: [C1] },
      },
      { suite: false, text: "Suite evaluators: replaced for this case" },
    ],
  ])("suite: %s", (_name, input, line) => {
    expect(linesOf(input)?.[1]).toEqual(line);
  });

  it.each<[string, Partial<ExecutionPreviewInput>, string | undefined]>([
    ["absent", {}, undefined],
    ["route only", { toolsChoice: "noTool" }, "No tools called"],
    [
      "exact-order route",
      {
        steps: [prompt("p"), toolAssert("a", "get_me")],
        toolsChoice: "tools",
        kind: "regression",
      },
      "Tools in exact order",
    ],
    [
      "1 predicate",
      { predicates: { mode: "extend", list: [C1] } },
      "1 case assertion",
    ],
    [
      "2 predicates",
      { predicates: { mode: "replace", list: [C1, C2] } },
      "2 case assertions",
    ],
    [
      "both",
      { toolsChoice: "noTool", predicates: { mode: "extend", list: [C1, C2] } },
      "No tools called · 2 case assertions",
    ],
  ])("case: %s", (_name, input, text) => {
    const lines = linesOf(input);
    if (text === undefined) {
      expect(lines).toHaveLength(2);
      return;
    }
    expect(lines).toHaveLength(3);
    expect(lines?.[2]).toEqual({ suite: false, text });
  });
});
