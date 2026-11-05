import { describe, expect, it } from "vitest";
import {
  resolveCasePredicates,
  type CasePredicates,
  type Predicate,
} from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import {
  AFTER_RUN_ASSERTIONS_LABEL,
  buildExecutionPreview,
  flattenCaseSteps,
  groupCaseSteps,
} from "../case-steps-model";

const prompt = (id: string): TestStep => ({ id, kind: "prompt", prompt: id });
const call = (id: string): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "srv",
  toolName: "search",
  arguments: {},
});
const click = (id: string): TestStep => ({
  id,
  kind: "interact",
  toolName: "widget",
  action: { kind: "click", target: { text: "Go" } },
});
const assert = (id: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "noToolErrors" },
});

const p1 = prompt("p1");
const p2 = prompt("p2");
const t1 = call("t1");
const i1 = click("i1");
const a1 = assert("a1");
const a2 = assert("a2");
const a3 = assert("a3");

/** Grouped shape as `[label, stepId, assertionIds]`, plus leading ids. */
function shape(steps: TestStep[]) {
  const grouped = groupCaseSteps(steps);
  return {
    leading: grouped.leadingAssertions.map((a) => a.step.id),
    steps: grouped.steps.map((s) => [
      s.label,
      s.step.id,
      s.assertions.map((a) => a.step.id),
    ]),
  };
}

const cases: Array<{
  name: string;
  steps: TestStep[];
  leading: string[];
  grouped: Array<[string, string, string[]]>;
}> = [
  { name: "empty case", steps: [], leading: [], grouped: [] },
  {
    name: "prompt with no assertions",
    steps: [p1],
    leading: [],
    grouped: [["User prompt", "p1", []]],
  },
  {
    name: "consecutive asserts nest under the step they follow",
    steps: [p1, a1, a2, p2, a3],
    leading: [],
    grouped: [
      ["User prompt", "p1", ["a1", "a2"]],
      ["User prompt", "p2", ["a3"]],
    ],
  },
  {
    name: "leading asserts stay above step 1",
    steps: [a1, a2, p1, a3],
    leading: ["a1", "a2"],
    grouped: [["User prompt", "p1", ["a3"]]],
  },
  {
    name: "only assertions",
    steps: [a1, a2],
    leading: ["a1", "a2"],
    grouped: [],
  },
  {
    name: "interact is its own step and owns the asserts after it",
    steps: [p1, a1, i1, a2, a3],
    leading: [],
    grouped: [
      ["User prompt", "p1", ["a1"]],
      ["Interact", "i1", ["a2", "a3"]],
    ],
  },
  {
    name: "tool call steps",
    steps: [t1, a1, i1, p1],
    leading: [],
    grouped: [
      ["Tool call", "t1", ["a1"]],
      ["Interact", "i1", []],
      ["User prompt", "p1", []],
    ],
  },
];

describe("groupCaseSteps", () => {
  it.each(cases)("$name", ({ steps, leading, grouped }) => {
    expect(shape(steps)).toEqual({ leading, steps: grouped });
  });

  it.each(cases)("round-trips: $name", ({ steps }) => {
    const flat = flattenCaseSteps(groupCaseSteps(steps));
    expect(flat).toEqual(steps);
    flat.forEach((step, i) => expect(step).toBe(steps[i]));
  });

  it("numbers editor steps and keeps stored indices and turns", () => {
    const grouped = groupCaseSteps([a1, p1, a2, i1, p2]);
    expect(grouped.steps.map((s) => [s.ordinal, s.index, s.turnIndex])).toEqual(
      [
        [1, 1, 1],
        [2, 3, 1],
        [3, 4, 2],
      ],
    );
    expect(grouped.leadingAssertions).toEqual([{ step: a1, index: 0 }]);
    expect(grouped.steps[0]!.assertions).toEqual([{ step: a2, index: 2 }]);
  });
});

const suiteA: Predicate = { type: "noToolErrors" };
const suiteB: Predicate = { type: "finalAssistantMessageNonEmpty" };
const caseX: Predicate = { type: "responseContains", text: "done" };

describe("buildExecutionPreview", () => {
  const envelopes: Array<{
    name: string;
    predicates?: CasePredicates;
    afterRun: Predicate[];
    suite: Predicate[];
    replacedCount: number;
  }> = [
    {
      name: "no envelope runs suite defaults only",
      afterRun: [],
      suite: [suiteA, suiteB],
      replacedCount: 0,
    },
    {
      name: "inherit ignores a stored list",
      predicates: { mode: "inherit", list: [caseX] },
      afterRun: [],
      suite: [suiteA, suiteB],
      replacedCount: 0,
    },
    {
      name: "extend runs both",
      predicates: { mode: "extend", list: [caseX] },
      afterRun: [caseX],
      suite: [suiteA, suiteB],
      replacedCount: 0,
    },
    {
      name: "replace runs the case list only",
      predicates: { mode: "replace", list: [caseX] },
      afterRun: [caseX],
      suite: [],
      replacedCount: 2,
    },
    {
      name: "replace with an empty list runs nothing",
      predicates: { mode: "replace", list: [] },
      afterRun: [],
      suite: [],
      replacedCount: 2,
    },
  ];

  it.each(envelopes)(
    "$name",
    ({ predicates, afterRun, suite, replacedCount }) => {
      const preview = buildExecutionPreview({
        steps: [p1, a1],
        predicates,
        suiteDefaultPredicates: [suiteA, suiteB],
      });
      expect(preview.afterRunAssertions).toEqual({
        label: AFTER_RUN_ASSERTIONS_LABEL,
        assertions: afterRun,
      });
      expect(preview.suiteDefaultEvaluators).toEqual({
        assertions: suite,
        replacedCount,
      });
      // Together the two sections are exactly what the runner evaluates.
      expect([
        ...preview.suiteDefaultEvaluators.assertions,
        ...preview.afterRunAssertions.assertions,
      ]).toEqual(resolveCasePredicates([suiteA, suiteB], predicates) ?? []);
    },
  );

  const suppressionRows: Array<{
    name: string;
    predicates?: CasePredicates;
    suite: Predicate[];
    replaced: number;
  }> = [
    { name: "inherit", suite: [suiteB], replaced: 0 },
    {
      name: "replace",
      predicates: { mode: "replace", list: [caseX] },
      suite: [],
      replaced: 1,
    },
  ];
  it.each(suppressionRows)(
    "suppressed suite defaults neither run nor count as replaced ($name)",
    (row) => {
      const preview = buildExecutionPreview({
        steps: [p1],
        predicates: row.predicates,
        suiteDefaultPredicates: [suiteA, suiteB],
        suppressedSuiteStandardCheckIds: ["response.errors"],
      });
      expect(preview.suiteDefaultEvaluators).toEqual({
        assertions: row.suite,
        replacedCount: row.replaced,
      });
    },
  );

  it("labels after-run assertions per DD1", () => {
    expect(AFTER_RUN_ASSERTIONS_LABEL).toBe("After-run assertions");
  });

  it("orders steps with their assertions, leading assertions apart", () => {
    const steps = [a1, p1, a2, i1, a3];
    const preview = buildExecutionPreview({ steps });
    expect(preview.leadingAssertions).toEqual(
      groupCaseSteps(steps).leadingAssertions,
    );
    expect(preview.steps).toEqual(groupCaseSteps(steps).steps);
    expect(flattenCaseSteps(preview)).toEqual(steps);
  });

  it.each([
    { expectedOutput: undefined, outcome: null },
    { expectedOutput: null, outcome: null },
    { expectedOutput: "   ", outcome: null },
    { expectedOutput: "  Draws a box. ", outcome: "Draws a box." },
  ])("expected outcome $expectedOutput → $outcome", (row) => {
    const preview = buildExecutionPreview({
      steps: [p1],
      expectedOutput: row.expectedOutput,
    });
    expect(preview.expectedOutcome).toBe(row.outcome);
  });

  it("empty case has empty sections", () => {
    expect(buildExecutionPreview({ steps: [] })).toEqual({
      leadingAssertions: [],
      steps: [],
      afterRunAssertions: { label: AFTER_RUN_ASSERTIONS_LABEL, assertions: [] },
      expectedOutcome: null,
      suiteDefaultEvaluators: { assertions: [], replacedCount: 0 },
    });
  });
});
