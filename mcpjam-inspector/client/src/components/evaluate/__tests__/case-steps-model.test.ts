import { describe, expect, it } from "vitest";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { TestStep } from "@/shared/steps";
import type { EvalJudgeConfig } from "@/components/evals/types";
import {
  buildCaseScorecard,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";
import {
  buildExecutionPreview,
  flattenEditorSteps,
  groupEditorSteps,
  type ExecutionPreviewItem,
} from "../case-steps/case-steps-model";

const prompt = (id: string): TestStep => ({
  id,
  kind: "prompt",
  prompt: "ask",
});
const call = (id: string): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "srv",
  toolName: "fetch",
  arguments: {},
});
const click = (id: string): TestStep => ({
  id,
  kind: "interact",
  toolName: "cart_view",
  action: { kind: "click", target: { testId: "x" } },
});
const check = (id: string, advisory = false): TestStep => ({
  id,
  kind: "assert",
  assertion: advisory
    ? { type: "noToolErrors", role: "advisory" }
    : { type: "noToolErrors" },
});
const tool = (id: string, toolName: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "toolCalledWith", toolName, args: { args: {} } },
});
const widget = (id: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { kind: "textVisible", toolName: "cart_view", text: "Added" },
});

const ids = (list: { anchor: string }[]) => list.map((item) => item.anchor);

describe("groupEditorSteps", () => {
  const cases: {
    name: string;
    steps: TestStep[];
    leading: string[];
    blocks: [string, number, string, string[]][];
  }[] = [
    {
      name: "an empty draft still has an outcome and after-run step",
      steps: [],
      leading: [],
      blocks: [
        ["outcome", 1, "Expected outcome", []],
        ["after-run", 2, "After-run assertions", []],
      ],
    },
    {
      name: "a prompt with its assertions nested under it",
      steps: [prompt("p"), tool("t1", "read_me"), tool("t2", "create_view")],
      leading: [],
      blocks: [
        ["step:p", 1, "User prompt", ["t1", "t2"]],
        ["outcome", 2, "Expected outcome", []],
        ["after-run", 3, "After-run assertions", []],
      ],
    },
    {
      name: "an assertion grades the action right before it",
      steps: [prompt("p"), check("a"), click("i"), widget("w"), call("c")],
      leading: [],
      blocks: [
        ["step:p", 1, "User prompt", ["a"]],
        ["step:i", 2, "Interact", ["w"]],
        ["step:c", 3, "Call tool", []],
        ["outcome", 4, "Expected outcome", []],
        ["after-run", 5, "After-run assertions", []],
      ],
    },
    {
      name: "assertions before any action stay leading",
      steps: [check("a"), prompt("p"), check("b")],
      leading: ["a"],
      blocks: [
        ["step:p", 1, "User prompt", ["b"]],
        ["outcome", 2, "Expected outcome", []],
        ["after-run", 3, "After-run assertions", []],
      ],
    },
  ];

  it.each(cases)("$name", ({ steps, leading, blocks }) => {
    const grouped = groupEditorSteps(steps);
    expect(grouped.leading.map((step) => step.id)).toEqual(leading);
    expect(
      grouped.steps.map((item) => [
        item.anchor,
        item.number,
        item.title,
        "assertions" in item ? item.assertions.map((step) => step.id) : [],
      ]),
    ).toEqual(blocks);
  });

  it.each(cases)(
    "flattening gives back the stored list: $name",
    ({ steps }) => {
      expect(flattenEditorSteps(groupEditorSteps(steps))).toEqual(steps);
    },
  );
});

const judgeOn: EvalJudgeConfig = {
  goalCompletion: { enabled: true, autoRun: true, role: "advisory" },
};
const suiteDefault: Predicate = { type: "toolCallCountUnder", count: 5 };
const caseOwn: Predicate = { type: "responseContains", needle: "done" };

function preview(
  steps: TestStep[],
  input: Partial<CaseScorecardInput> = {},
): ExecutionPreviewItem[] {
  return buildExecutionPreview(
    steps,
    buildCaseScorecard({
      steps,
      toolsChoice: "tools",
      numbering: "action",
      suiteJudgeConfig: judgeOn,
      ...input,
    }),
  );
}

describe("buildExecutionPreview: order", () => {
  it.each<{ name: string; steps: TestStep[]; order: string[] }>([
    {
      name: "prompt, its assertions, outcome, end of run",
      steps: [prompt("p"), tool("t1", "read_me"), tool("t2", "create_view")],
      order: ["step:p", "assertion:t1", "assertion:t2", "outcome", "after-run"],
    },
    {
      name: "leading assertions run first",
      steps: [check("a"), prompt("p")],
      order: ["assertion:a", "step:p", "outcome", "after-run"],
    },
    {
      name: "several actions keep stored order",
      steps: [prompt("p"), click("i"), widget("w"), prompt("p2"), check("b")],
      order: [
        "step:p",
        "step:i",
        "assertion:w",
        "step:p2",
        "assertion:b",
        "outcome",
        "after-run",
      ],
    },
  ])("$name", ({ steps, order }) => {
    const items = preview(steps);
    expect(ids(items)).toEqual(order);
    expect(items.map((item) => item.number)).toEqual(
      order.map((_, index) => index + 1),
    );
  });
});

describe("buildExecutionPreview: items", () => {
  const items = preview([
    check("lead"),
    prompt("p"),
    check("soft", true),
    click("i"),
    widget("w"),
    call("c"),
  ]);
  const byAnchor = (anchor: string) =>
    items.find((item) => item.anchor === anchor);

  it.each<[string, Record<string, unknown>]>([
    ["assertion:lead", { gradesStep: null, blocking: true }],
    ["step:p", { stepNumber: 1, performer: "agent", title: "User prompt" }],
    [
      "assertion:soft",
      { gradesStep: 1, blocking: false, evaluatedIn: "transcript" },
    ],
    ["step:i", { stepNumber: 2, performer: "runner", title: "Interact" }],
    ["assertion:w", { gradesStep: 2, blocking: true, evaluatedIn: "widget" }],
    ["step:c", { stepNumber: 3, performer: "runner", title: "Call tool" }],
  ])("%s", (anchor, expected) => {
    expect(byAnchor(anchor)).toMatchObject(expected);
  });
});

describe("buildExecutionPreview: outcome and end of run", () => {
  const endOfRun = (items: ExecutionPreviewItem[]) => {
    const last = items.at(-1);
    if (last?.kind !== "endOfRun") throw new Error("no end-of-run item");
    return {
      judge: last.judge.state,
      judgeBlocking: last.judge.blocking,
      assertions: last.assertions.map(
        (entry) => `${entry.provenance}:${entry.row.label}`,
      ),
      replaced: last.replacedSuiteDefaults,
    };
  };

  it("carries the trimmed expected outcome", () => {
    const outcome = preview([prompt("p")], {
      expectedOutput: "  Two boxes and an arrow.  ",
    }).find((item) => item.kind === "outcome");
    expect(outcome).toMatchObject({
      expectedOutput: "Two boxes and an arrow.",
    });
  });

  const steps = [prompt("p"), tool("t", "read_me")];

  it.each<{
    name: string;
    input: Partial<CaseScorecardInput>;
    judge: string;
    provenances: string[];
    replaced: number;
  }>([
    {
      name: "inherit: suite defaults only",
      input: { suiteDefaultPredicates: [suiteDefault] },
      judge: "runs",
      provenances: ["suite"],
      replaced: 0,
    },
    {
      name: "extend: suite defaults, then the case's own",
      input: {
        suiteDefaultPredicates: [suiteDefault],
        predicates: { mode: "extend", list: [caseOwn] },
      },
      judge: "runs",
      provenances: ["suite", "case"],
      replaced: 0,
    },
    {
      name: "replace: only the case's own, suite defaults counted as replaced",
      input: {
        suiteDefaultPredicates: [suiteDefault],
        predicates: { mode: "replace", list: [caseOwn] },
      },
      judge: "runs",
      provenances: ["case"],
      replaced: 1,
    },
    {
      name: "a case that skips the judge",
      input: {
        judgeConfigOverride: { goalCompletion: { enabled: false } },
      },
      judge: "skipped",
      provenances: [],
      replaced: 0,
    },
    {
      name: "a suite with the judge off",
      input: {
        suiteJudgeConfig: { goalCompletion: { enabled: false } },
      },
      judge: "off",
      provenances: [],
      replaced: 0,
    },
    {
      name: "a frozen run shows one snapshot block",
      input: {
        suiteDefaultPredicates: [suiteDefault],
        snapshotPredicates: [suiteDefault, caseOwn],
      },
      judge: "runs",
      provenances: ["snapshot", "snapshot"],
      replaced: 0,
    },
  ])("$name", ({ input, judge, provenances, replaced }) => {
    const result = endOfRun(preview(steps, input));
    expect(result.judge).toBe(judge);
    expect(result.judgeBlocking).toBe(false);
    expect(result.assertions.map((entry) => entry.split(":")[0])).toEqual(
      provenances,
    );
    expect(result.replaced).toBe(replaced);
  });

  it("carries each whole-run assertion's predicate and role", () => {
    const last = preview(steps, {
      suiteDefaultPredicates: [suiteDefault],
      predicates: {
        mode: "extend",
        list: [{ ...caseOwn, role: "advisory" }],
      },
    }).at(-1);
    expect(last?.kind === "endOfRun" && last.assertions).toEqual([
      expect.objectContaining({
        blocking: true,
        row: expect.objectContaining({ predicate: suiteDefault }),
      }),
      expect.objectContaining({ blocking: false, provenance: "case" }),
    ]);
  });

  it.each<{
    name: string;
    steps: TestStep[];
    input: Partial<CaseScorecardInput>;
    route: boolean;
  }>([
    {
      name: "no tool called leads the end of run",
      steps: [prompt("p")],
      input: { toolsChoice: "noTool" },
      route: true,
    },
    {
      name: "an exact tool order leads the end of run",
      steps: [prompt("p"), tool("a", "read_me"), tool("b", "create_view")],
      input: { kind: "regression" },
      route: true,
    },
    {
      name: "tools merely reached stay step assertions only",
      steps: [prompt("p"), tool("a", "read_me")],
      input: { kind: "capability" },
      route: false,
    },
  ])("$name", ({ steps: caseSteps, input, route }) => {
    const result = endOfRun(preview(caseSteps, input));
    expect(result.assertions[0]?.startsWith("route:") ?? false).toBe(route);
  });
});
