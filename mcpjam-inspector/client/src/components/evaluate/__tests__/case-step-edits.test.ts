import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  addAfterRun,
  addAnything,
  addAssertionAt,
  addCasePredicate,
  chooseNoTool,
  chooseTools,
  setCaseKind,
  type CaseStepsDraft,
} from "../case-steps/case-step-edits";

const sketch: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Sketch a tiny flow" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "read_me",
      args: { args: {} },
    },
  },
];

const draft = (over: Partial<CaseStepsDraft> = {}): CaseStepsDraft => ({
  title: "Sketch",
  runs: 1,
  steps: sketch,
  expectedOutput: "",
  toolsChoice: "tools",
  stashedTools: [],
  ...over,
});

const ids = (steps: TestStep[]) => steps.map((step) => step.id);

describe("route rule edits", () => {
  it("No tools parks the tool asserts and Remove brings them back", () => {
    const negative = chooseNoTool(draft());
    expect(negative.toolsChoice).toBe("noTool");
    expect(ids(negative.steps)).toEqual(["p1"]);
    expect(negative.stashedTools.map((tool) => tool.toolName)).toEqual([
      "read_me",
    ]);
    const restored = chooseTools(negative);
    expect(restored.toolsChoice).toBe("tools");
    expect(ids(restored.steps)).toEqual(["p1", "a1"]);
  });

  it("No tools then tools puts each assert back in its own turn, as it was", () => {
    const twoTurns: TestStep[] = [
      ...sketch,
      { id: "p2", kind: "prompt", prompt: "Now share it" },
      {
        id: "a2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "export_to_excalidraw",
          args: { args: { id: "x" }, argumentMatching: "exact" },
        },
      },
    ];
    const negative = chooseNoTool(draft({ steps: twoTurns }));
    expect(ids(negative.steps)).toEqual(["p1", "p2"]);
    const restored = chooseTools(negative);
    expect(restored.steps).toEqual(twoTurns);
  });

  it("No tools then tools keeps an advisory tool assert", () => {
    const withAdvisory: TestStep[] = [
      ...sketch,
      {
        id: "a2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "audit_log",
          args: { args: {} },
          role: "advisory",
        },
      } as TestStep,
    ];
    const negative = chooseNoTool(draft({ steps: withAdvisory }));
    expect(ids(negative.steps)).toEqual(["p1"]);
    expect(chooseTools(negative).steps).toEqual(withAdvisory);
  });

  it("puts a parked assert after the nearest step still there", () => {
    const negative = chooseNoTool(
      draft({
        steps: [
          ...sketch,
          { id: "p2", kind: "prompt", prompt: "Now share it" },
          { ...sketch[1], id: "a2" },
        ],
      }),
    );
    const withoutP2 = { ...negative, steps: negative.steps.slice(0, 1) };
    expect(ids(chooseTools(withoutP2).steps)).toEqual(["p1", "a1", "a2"]);
  });

  it("deleting a middle prompt leaves the other asserts in their turns", () => {
    const exact = (id: string, toolName: string): TestStep => ({
      id,
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName,
        args: { args: { q: id }, argumentMatching: "exact" },
      },
    });
    const prompt = (id: string): TestStep => ({
      id,
      kind: "prompt",
      prompt: id,
    });
    const threeTurns = [
      prompt("p1"),
      exact("a1", "search"),
      prompt("p2"),
      exact("a2", "book"),
      prompt("p3"),
      exact("a3", "pay"),
    ];
    const negative = chooseNoTool(draft({ steps: threeTurns }));
    const withoutP2 = {
      ...negative,
      steps: negative.steps.filter((step) => step.id !== "p2"),
    };
    expect(chooseTools(withoutP2).steps).toEqual([
      threeTurns[0],
      threeTurns[1],
      threeTurns[3],
      threeTurns[4],
      threeTurns[5],
    ]);
  });

  it("a plain stashed tool still comes back through the first turn", () => {
    const negative = draft({
      steps: [sketch[0]],
      toolsChoice: "noTool",
      stashedTools: [{ id: "t1", toolName: "read_me", arguments: {} }],
    });
    expect(ids(chooseTools(negative).steps)).toEqual(["p1", "t1"]);
  });

  it("setCaseKind reads stored match options it does not know", () => {
    const stored = { toolCallOrder: "sideways" } as never;
    expect(() =>
      setCaseKind(draft({ matchOptions: stored }), "regression", undefined),
    ).not.toThrow();
  });

  it("exact order sets the regression kind and strict match options", () => {
    const result = addAfterRun(
      { kind: "route-check", routeKind: "exactOrder" },
      undefined,
      0,
    );
    const next = result!.edit(draft());
    expect(next.kind).toBe("regression");
    expect(next.matchOptions).toMatchObject({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
    });
    expect(result!.openKey).toBe("route");
  });

  it("exact order on a case with no tools adds a blank tool assert after step 1", () => {
    const result = addAfterRun(
      { kind: "route-check", routeKind: "exactOrder" },
      undefined,
      0,
    );
    const next = result!.edit(draft({ steps: [sketch[0]!] }));
    expect(next.steps).toHaveLength(2);
    expect(next.steps[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith" },
    });
  });
});

describe("adding", () => {
  it("a predicate in inherit mode switches the envelope to extend", () => {
    const next = addCasePredicate(
      draft({ predicates: { mode: "inherit", list: [] } }),
      { type: "noToolErrors" },
    );
    expect(next.predicates).toEqual({
      mode: "extend",
      list: [{ type: "noToolErrors" }],
    });
  });

  it("Add assertion inserts after the step's last assertion and opens it", () => {
    const result = addAssertionAt(
      "p1",
      { kind: "check", predicateKind: "noToolErrors" },
      "",
    )!;
    const next = result.edit(draft());
    expect(next.steps).toHaveLength(3);
    expect(next.steps[2]!.id).toBe(result.openKey!.slice("check:".length));
  });

  it("the rail appends a step and routes whole-run kinds to After-run", () => {
    const context = {
      lastActionId: "p1",
      suiteServers: ["excalidraw"],
      viewTool: "",
      suiteDefaultMatchOptions: undefined,
      nextCaseIndex: 0,
    };
    const step = addAnything({ kind: "step", stepKind: "toolCall" }, context)!;
    const withStep = step.edit(draft());
    expect(withStep.steps.at(-1)).toMatchObject({
      kind: "toolCall",
      serverName: "excalidraw",
    });
    expect(step.openKey).toBe(`action:${withStep.steps.at(-1)!.id}`);

    const budget = addAnything(
      { kind: "check", predicateKind: "tokenBudgetUnder" },
      context,
    )!;
    expect(budget.edit(draft()).predicates?.list).toHaveLength(1);
    expect(budget.openKey).toBe("case:0");
  });
});
