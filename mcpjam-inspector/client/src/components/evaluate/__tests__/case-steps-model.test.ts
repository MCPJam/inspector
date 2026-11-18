import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import {
  insertStepAfter,
  type InteractStep,
  type TestStep,
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
  flattenCaseSteps,
  groupCaseSteps,
  interactText,
  moveAssertionTo,
  STEP_COPY,
} from "../case-steps/case-steps-model";
import {
  check,
  FIXTURES,
  interact,
  prompt,
  tool,
  toolAssert,
} from "./case-steps-fixtures";

const ids = (steps: { step: TestStep }[]) => steps.map((row) => row.step.id);

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

  it("keeps suite order across groups, a row without an index last", () => {
    const standard: Predicate = { type: "noToolErrors" };
    const card = buildCaseScorecard({
      ...base,
      suiteDefaultPredicates: [standard, D1, D2],
    });
    const groupsWithSuite = card.groups.filter((group) =>
      group.rows.some((row) => row.provenance === "suite"),
    );
    expect(groupsWithSuite.length).toBeGreaterThan(1);
    expect(preds(afterRunSection(card).suiteRows)).toEqual([standard, D1, D2]);
    const groups = card.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) =>
        row.predicate === standard
          ? { ...row, predicateIndex: undefined }
          : row,
      ),
    }));
    expect(preds(afterRunSection({ ...card, groups }).suiteRows)).toEqual([
      D1,
      D2,
      standard,
    ]);
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

describe("STEP_COPY", () => {
  it("names each step kind for the cards and the editor", () => {
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

describe("interactText", () => {
  it.each<[string, InteractStep["action"], string]>([
    ["click", { kind: "click", target: { testId: "x" } }, 'click testId "x"'],
    [
      "click with role",
      { kind: "click", target: { role: { role: "button", name: "Pay" } } },
      'click button "Pay"',
    ],
    [
      "right-click",
      { kind: "click", target: { testId: "x" }, clickType: "right" },
      'right-click testId "x"',
    ],
    [
      "type",
      { kind: "type", target: { testId: "q" }, text: " shoes " },
      'type “shoes” into testId "q"',
    ],
    ["key", { kind: "key", key: "Enter" }, "press Enter"],
    ["scroll", { kind: "scroll", direction: "down" }, "scroll down"],
    ["wait", { kind: "wait", ms: 1500 }, "wait 1,500 ms"],
    ["incomplete click", { kind: "click", target: { testId: " " } }, ""],
    ["incomplete type", { kind: "type", target: { css: "" }, text: "x" }, ""],
    ["empty key", { kind: "key", key: " " }, ""],
  ])("%s", (_name, action, text) => {
    expect(interactText(action)).toBe(text);
  });
});
