import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import {
  addAfterRun,
  addAnything,
  addAssertionAt,
  addCasePredicate,
  chooseNoTool,
  chooseTools,
  setCaseKind,
  setCasePredicates,
  setEnvelopeMode,
  type CaseStepsDraft,
} from "../case-steps/case-step-edits";
import { matchOptionsForKind } from "../simple-case/simple-case-model";
import { moveAssertionTo } from "../case-steps/case-steps-model";
import { check, FIXTURES, prompt, toolAssert } from "./case-steps-fixtures";

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

const advisoryTool = check("adv", {
  type: "toolCalledWith",
  toolName: "get_me",
  args: { args: {} },
  role: "advisory",
} as Predicate);
const TOOL_FIXTURES: [string, TestStep[]][] = [
  ["[p, tool]", [prompt("p"), toolAssert("t1", "get_me")]],
  ["advisory tool", [prompt("p"), advisoryTool, check("a")]],
  [
    "multi-turn tools",
    [
      prompt("p1"),
      toolAssert("t1", "get_me"),
      check("a1"),
      prompt("p2"),
      toolAssert("t2", "list_items"),
    ],
  ],
];
const hasToolCalledWith = (steps: TestStep[]) =>
  steps.some(
    (step) =>
      step.kind === "assert" &&
      "type" in step.assertion &&
      step.assertion.type === "toolCalledWith",
  );

describe("No tools and back", () => {
  it("puts a tool check that led the case back first", () => {
    const steps = [toolAssert("t0", "get_me"), prompt("p1")];
    const parked = chooseNoTool(draft({ steps }));
    expect(ids(parked.steps)).toEqual(["p1"]);
    expect(ids(chooseTools(parked).steps)).toEqual(["t0", "p1"]);
  });

  it("keeps a tool check under its own step when a check before it moved", () => {
    const steps = [
      prompt("p1"),
      check("n1"),
      toolAssert("t1", "get_me"),
      prompt("p2"),
    ];
    const parked = chooseNoTool(draft({ steps }));
    const moved = {
      ...parked,
      steps: moveAssertionTo(parked.steps, "n1", "p2"),
    };
    expect(ids(moved.steps)).toEqual(["p1", "p2", "n1"]);
    expect(ids(chooseTools(moved).steps)).toEqual(["p1", "t1", "p2", "n1"]);
  });

  it.each([
    ...FIXTURES.filter(([, steps]) => steps.length > 0),
    ...TOOL_FIXTURES,
  ])("gives back the same steps: %s", (_name, steps) => {
    const parked = chooseNoTool(draft({ steps }));
    // The backend rejects a negative case that keeps a toolCalledWith.
    expect(hasToolCalledWith(parked.steps)).toBe(false);
    expect(chooseTools(parked).steps).toEqual(steps);
  });

  it("on an empty case adds only the first, empty prompt", () => {
    const parked = chooseNoTool(draft({ steps: [] }));
    expect(parked.steps).toMatchObject([{ kind: "prompt", prompt: "" }]);
    expect(chooseTools(parked).steps).toEqual(parked.steps);
  });

  it("changes nothing when No tools is already on", () => {
    const once = chooseNoTool(draft());
    expect(once.stashedTools).toHaveLength(1);
    expect(chooseNoTool(once)).toEqual(once);
  });
});

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

  it("exact order on a case with no steps adds no leading tool assert", () => {
    const result = addAfterRun(
      { kind: "route-check", routeKind: "exactOrder" },
      undefined,
      0,
    );
    const next = result!.edit(draft({ steps: [] }));
    expect(next.steps).toEqual([]);
    expect(next.kind).toBe("regression");
  });
});

describe("envelope", () => {
  it.each(["replace", "extend"] as const)(
    "setEnvelopeMode(%s) keeps the case's list",
    (mode) => {
      const list: Predicate[] = [{ type: "noToolErrors" }];
      const next = setEnvelopeMode(
        draft({ predicates: { mode: "extend", list } }),
        mode,
      );
      expect(next.predicates).toEqual({ mode, list });
    },
  );

  it("setEnvelopeMode from inherit doesn't switch on its inactive list", () => {
    const stale: Predicate[] = [{ type: "noToolErrors" }];
    const next = setEnvelopeMode(
      draft({ predicates: { mode: "inherit", list: stale } }),
      "replace",
    );
    expect(next.predicates).toEqual({ mode: "replace", list: [] });
  });

  it("setEnvelopeMode on a case with no envelope starts an empty list", () => {
    expect(setEnvelopeMode(draft(), "replace").predicates).toEqual({
      mode: "replace",
      list: [],
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

  it("an edit in inherit mode starts an empty extend list", () => {
    const stale = { type: "noToolErrors" } as const;
    const next = setCasePredicates(
      draft({ predicates: { mode: "inherit", list: [stale] } }),
      (list) => [...list, { type: "responseContains", needle: "ok" }],
    );
    expect(next.predicates).toEqual({
      mode: "extend",
      list: [{ type: "responseContains", needle: "ok" }],
    });
  });

  it("a tool assertion on a No tools case turns tools back on", () => {
    const noTool = chooseNoTool(draft());
    const result = addAssertionAt(
      "p1",
      { kind: "check", predicateKind: "toolCalledWith" },
      "",
    )!;
    const next = result.edit(noTool);
    expect(next.toolsChoice).toBe("tools");
    expect(hasToolCalledWith(next.steps)).toBe(true);
  });

  it("the No tools route opens the route row", () => {
    const result = addAfterRun(
      { kind: "route-check", routeKind: "noTools" },
      undefined,
      0,
    )!;
    expect(result.openKey).toBe("route");
    expect(result.edit(draft()).toolsChoice).toBe("noTool");
  });

  it("removing the exact-order route drops the strict match options", () => {
    const strict = draft({
      kind: "regression",
      matchOptions: matchOptionsForKind("regression"),
    });
    // The suite's defaults are capability, so the case inherits them again.
    const next = setCaseKind(strict, "capability", undefined);
    expect(next.kind).toBeUndefined();
    expect(next.matchOptions).toBeUndefined();
  });

  it("keeps an override the suite's options don't give", () => {
    const strictSuite = matchOptionsForKind("regression");
    const next = setCaseKind(draft(), "capability", strictSuite);
    expect(next.kind).toBe("capability");
    expect(next.matchOptions).toEqual(matchOptionsForKind("capability"));
    const back = setCaseKind(next, "regression", strictSuite);
    expect(back.kind).toBeUndefined();
    expect(back.matchOptions).toBeUndefined();
  });

  it.each<[string, TestStep[]]>([
    ["an empty case", []],
    ["a case with only leading assertions", [check("a0"), check("a1")]],
  ])("the rail puts a new step last in %s", (_name, steps) => {
    const result = addAnything(
      { kind: "step", stepKind: "toolCall" },
      {
        lastActionId: null,
        suiteServers: ["excalidraw"],
        viewTool: "",
        suiteDefaultMatchOptions: undefined,
        nextCaseIndex: 0,
      },
    )!;
    const next = result.edit(draft({ steps }));
    expect(ids(next.steps).slice(0, -1)).toEqual(ids(steps));
    expect(next.steps.at(-1)).toMatchObject({ kind: "toolCall" });
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
