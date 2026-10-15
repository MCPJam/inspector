import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  afterTheRunRows,
  canRemoveAction,
  deleteActionPlan,
  isQuietCase,
  moveActionBlock,
  removeActionWithChecks,
  replaceActionTools,
  reorderSpineSteps,
  reorderRouteToolChecks,
  spineStatus,
  toolsByLaterAction,
} from "../case-spine/case-spine-model";

const prompt = (id: string): TestStep => ({
  id,
  kind: "prompt",
  prompt: "ask",
});
const check = (id: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "noToolErrors" },
});
const click = (id: string): TestStep => ({
  id,
  kind: "interact",
  toolName: "cart_view",
  action: { kind: "click", target: { testId: "x" } },
});

describe("reorderRouteToolChecks", () => {
  it("reorders complete expected calls without moving other steps", () => {
    const a: TestStep = {
      id: "a",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "a",
        args: { args: { id: 1 }, argumentMatching: "exact" },
        minCount: 2,
      },
    };
    const b: TestStep = {
      id: "b",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "b",
        args: { args: { id: 2 } },
      },
    };
    const steps = [prompt("p"), a, check("c"), click("i"), b];
    expect(reorderRouteToolChecks(steps, "a", "b")).toEqual([
      steps[0],
      b,
      steps[2],
      steps[3],
      a,
    ]);
    expect(reorderRouteToolChecks(steps, "missing", "b")).toBe(steps);
    expect(reorderRouteToolChecks(steps, "a", "a")).toBe(steps);
  });
});

describe("reorderSpineSteps", () => {
  it("moves checks in either direction without changing their data", () => {
    const steps = [prompt("p"), check("a"), check("b"), check("c")];
    const down = reorderSpineSteps(steps, "a", "c");
    expect(down).toEqual([steps[0], steps[2], steps[3], steps[1]]);
    expect(reorderSpineSteps(down, "a", "b")).toEqual(steps);
    expect(down[3]).toBe(steps[1]);
    expect(steps.map((step) => step.id)).toEqual(["p", "a", "b", "c"]);
  });

  it("moves an action together with its checks", () => {
    const steps = [
      prompt("p"),
      check("a"),
      click("i1"),
      check("b"),
      click("i2"),
      check("c"),
    ];
    const moved = reorderSpineSteps(steps, "i2", "i1");
    expect(moved.map((step) => step.id)).toEqual([
      "p",
      "a",
      "i2",
      "c",
      "i1",
      "b",
    ]);
    expect(reorderSpineSteps(moved, "i2", "i1")).toEqual(steps);
  });

  it("can explicitly move a check to a different action", () => {
    const steps = [prompt("p"), check("a"), click("i1"), check("b")];
    expect(reorderSpineSteps(steps, "a", "b").map((step) => step.id)).toEqual([
      "p",
      "i1",
      "b",
      "a",
    ]);
  });

  it("keeps prompts anchored and ignores incompatible or missing targets", () => {
    const steps = [prompt("p"), check("a"), click("i1"), check("b")];
    for (const [from, to] of [
      ["p", "i1"],
      ["i1", "p"],
      ["a", "i1"],
      ["i1", "b"],
      ["missing", "a"],
      ["a", "a"],
    ]) {
      expect(reorderSpineSteps(steps, from!, to!)).toBe(steps);
    }
  });
});

describe("afterTheRunRows", () => {
  it("lists case rows in list order, then suite rows — not in stage order", () => {
    // These all grade the same finished transcript, so the chain stage they
    // file under is not a distinction the reader can act on. `responseContains`
    // and `tokenBudgetUnder` sit in different groups on the suite table; here
    // they are consecutive because the author wrote them that way.
    const card = buildCaseScorecard({
      steps: [prompt("s1")],
      toolsChoice: "unset",
      predicates: {
        mode: "extend",
        list: [
          { type: "responseContains", needle: "ok" },
          { type: "tokenBudgetUnder", tokens: 500 },
        ],
      },
      suiteDefaultPredicates: [{ type: "noToolErrors" }],
    });
    const rows = afterTheRunRows(card);
    expect(rows.map((row) => [row.provenance, row.predicateIndex])).toEqual([
      ["case", 0],
      ["case", 1],
      ["suite", 0],
    ]);
  });

  it("never includes the judge — it renders as its own block, not a row", () => {
    const card = buildCaseScorecard({
      steps: [prompt("s1")],
      toolsChoice: "unset",
      expectedOutput: "states the email",
      suiteJudgeConfig: { goalCompletion: { enabled: true } },
    });
    expect(afterTheRunRows(card).some((r) => r.provenance === "judge")).toBe(
      false,
    );
  });

  it("never includes step rows — those hang under their action", () => {
    const card = buildCaseScorecard({
      steps: [prompt("s1"), check("a1")],
      toolsChoice: "unset",
    });
    expect(afterTheRunRows(card).some((r) => r.provenance === "step")).toBe(
      false,
    );
  });

  it("replaces case and suite rows with the snapshot when inspecting", () => {
    const card = buildCaseScorecard({
      steps: [prompt("s1")],
      toolsChoice: "unset",
      predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
      suiteDefaultPredicates: [{ type: "finalAssistantMessageNonEmpty" }],
      snapshotPredicates: [{ type: "responseContains", needle: "x" }],
    });
    expect(afterTheRunRows(card).map((r) => r.provenance)).toEqual([
      "snapshot",
    ]);
  });
});

describe("spineStatus", () => {
  const byId = new Map([["a1", "fail" as const]]);
  const byTurn = new Map([[0, "ok" as const]]);

  it("prefers this step's own verdict over the turn's", () => {
    expect(
      spineStatus({ stepId: "a1", kind: "assert", turnIndex: 0, byId, byTurn }),
    ).toEqual({ status: "fail", perStep: true });
  });

  it("paints a turn verdict on an action that has none of its own", () => {
    expect(
      spineStatus({ stepId: "s1", kind: "prompt", turnIndex: 0, byTurn }),
    ).toEqual({ status: "ok", perStep: false });
  });

  it("does NOT paint a turn verdict on a check", () => {
    // "The turn passed" is not "this check passed" — the check may not have run
    // at all. Borrowing the turn's tone would claim a measurement.
    expect(
      spineStatus({ stepId: "a9", kind: "assert", turnIndex: 0, byTurn }),
    ).toEqual({ status: undefined, perStep: false });
  });

  it("does let a running turn show a check as running", () => {
    expect(
      spineStatus({
        stepId: "a9",
        kind: "assert",
        turnIndex: 0,
        byTurn: new Map([[0, "running" as const]]),
      }),
    ).toEqual({ status: "running", perStep: false });
  });

  it("reports nothing when neither map has an entry", () => {
    expect(
      spineStatus({ stepId: "zz", kind: "prompt", turnIndex: 3, byId, byTurn }),
    ).toEqual({ status: undefined, perStep: false });
  });
});

describe("canRemoveAction", () => {
  it("keeps the only prompt and lets every extra prompt go", () => {
    const steps = [prompt("s1"), prompt("s2")];
    expect(canRemoveAction(steps, "s1")).toBe(true);
    expect(canRemoveAction(steps, "s2")).toBe(true);
    expect(canRemoveAction([prompt("s1")], "s1")).toBe(false);
  });

  it("lets a click go while the only prompt stays", () => {
    const steps = [prompt("s1"), click("i1")];
    expect(canRemoveAction(steps, "s1")).toBe(false);
    expect(canRemoveAction(steps, "i1")).toBe(true);
  });
});

describe("deleteActionPlan", () => {
  it("says nothing needs confirming when the action stands alone", () => {
    const plan = deleteActionPlan([prompt("s1"), prompt("s2")], "s2");
    expect(plan.needsConfirm).toBe(false);
  });

  it("counts the checks that would re-parent, and names their new owner", () => {
    const steps = [
      prompt("s1"),
      check("a1"),
      prompt("s2"),
      check("a2"),
      check("a3"),
    ];
    const plan = deleteActionPlan(steps, "s2");
    expect(plan).toMatchObject({
      needsConfirm: true,
      movedChecks: 2,
      becomesLeading: false,
      reparentTo: { ordinal: 1, stepId: "s1" },
    });
  });

  it("flags the case where the checks would run before any prompt", () => {
    const plan = deleteActionPlan([prompt("s1"), check("a1")], "s1");
    expect(plan).toMatchObject({
      needsConfirm: true,
      movedChecks: 1,
      becomesLeading: true,
      reparentTo: null,
    });
  });

  it("counts a later click's checks in the same turn as followers", () => {
    // Removing the prompt folds the click AND its check into the previous turn.
    const steps = [prompt("s1"), prompt("s2"), click("i1"), check("a1")];
    expect(deleteActionPlan(steps, "s2").movedFollowers).toBe(1);
  });

  it("returns the empty plan for an id that is not an action", () => {
    expect(
      deleteActionPlan([prompt("s1"), check("a1")], "a1").needsConfirm,
    ).toBe(false);
  });
});

describe("removeActionWithChecks", () => {
  it("removes the action and everything nested under it", () => {
    const steps = [prompt("s1"), check("a1"), prompt("s2"), check("a2")];
    expect(removeActionWithChecks(steps, "s1").map((s) => s.id)).toEqual([
      "s2",
      "a2",
    ]);
  });

  it("leaves the list alone for an unknown id", () => {
    const steps = [prompt("s1")];
    expect(removeActionWithChecks(steps, "nope")).toEqual(steps);
  });
});

describe("moveActionBlock", () => {
  it("carries a check with the action it grades", () => {
    const steps = [prompt("s1"), check("a1"), prompt("s2"), check("a2")];
    expect(moveActionBlock(steps, "s1", 1).map((s) => s.id)).toEqual([
      "s2",
      "a2",
      "s1",
      "a1",
    ]);
  });

  it("is a no-op at either end", () => {
    const steps = [prompt("s1"), prompt("s2")];
    expect(moveActionBlock(steps, "s1", -1)).toEqual(steps);
    expect(moveActionBlock(steps, "s2", 1)).toEqual(steps);
  });

  it("leaves leading checks where they are", () => {
    // A leading check belongs to no action; dragging it along would change the
    // turn it runs in.
    const steps = [check("a0"), prompt("s1"), prompt("s2")];
    expect(moveActionBlock(steps, "s1", 1).map((s) => s.id)).toEqual([
      "a0",
      "s2",
      "s1",
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const steps = [prompt("s1")];
    expect(moveActionBlock(steps, "nope", 1)).toEqual(steps);
  });
});

describe("isQuietCase", () => {
  it("is quiet for a bare prompt, with or without a goal sentence", () => {
    expect(isQuietCase({ steps: [prompt("s1")] })).toBe(true);
  });

  it("is quiet for an empty draft — a new case starts with nothing", () => {
    expect(isQuietCase({ steps: [] })).toBe(true);
  });

  it("stops being quiet once the case carries a check", () => {
    expect(isQuietCase({ steps: [prompt("s1"), check("a1")] })).toBe(false);
  });

  it("stops being quiet once there is a second action", () => {
    expect(isQuietCase({ steps: [prompt("s1"), click("i1")] })).toBe(false);
  });

  it("stops being quiet once a whole-run check exists", () => {
    expect(
      isQuietCase({
        steps: [prompt("s1")],
        predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
      }),
    ).toBe(false);
  });

  it("stays quiet with an INHERITED suite list — the author authored nothing", () => {
    expect(
      isQuietCase({
        steps: [prompt("s1")],
        predicates: { mode: "inherit", list: [] },
      }),
    ).toBe(true);
  });

  it('stops being quiet once "no tool" is the answer', () => {
    // It adds no step, but it is the negative case's whole assertion.
    expect(isQuietCase({ steps: [prompt("s1")], toolsChoice: "noTool" })).toBe(
      false,
    );
  });

  it("stops being quiet for a pinned-first (model-free) case", () => {
    const pinned: TestStep = {
      id: "t1",
      kind: "toolCall",
      serverName: "srv",
      toolName: "get",
      arguments: {},
    };
    expect(isQuietCase({ steps: [pinned] })).toBe(false);
  });

  it("stops being quiet with a leading check", () => {
    expect(isQuietCase({ steps: [check("a0"), prompt("s1")] })).toBe(false);
  });
});

describe("each later prompt's own tools", () => {
  const expectTool = (id: string, toolName: string): TestStep => ({
    id,
    kind: "assert",
    assertion: { type: "toolCalledWith", toolName, args: { args: {} } },
  });
  const steps: TestStep[] = [
    prompt("p1"),
    expectTool("t1", "diagnose"),
    prompt("p2"),
    expectTool("t2", "generate"),
    check("c2"),
    prompt("p3"),
    expectTool("t3", "run"),
  ];

  it("keys each later prompt's tools by that prompt, leaving the first prompt's alone", () => {
    const byAction = toolsByLaterAction(steps);
    expect([...byAction.keys()]).toEqual(["p2", "p3"]);
    expect(byAction.get("p2")!.map((tool) => tool.toolName)).toEqual([
      "generate",
    ]);
    expect(byAction.get("p3")!.map((tool) => tool.id)).toEqual(["t3"]);
  });

  it("skips an advisory tool check, which is an ordinary assertion", () => {
    const advisory: TestStep = {
      id: "t2",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "generate",
        args: { args: {} },
        role: "advisory",
      },
    };
    expect(
      toolsByLaterAction([prompt("p1"), prompt("p2"), advisory]).size,
    ).toBe(0);
  });

  it("rewrites, removes and appends within one prompt's block only", () => {
    const current = toolsByLaterAction(steps).get("p2")!;
    const next = replaceActionTools(steps, "p2", current, [
      { ...current[0]!, toolName: "generate_cases" },
      { toolName: "list_suites", arguments: {} },
    ]);
    const ids = next.map((step) => step.id);
    // The kept tool stays in place, the new one lands at the END of prompt
    // 2's block (after its other check), and prompt 3 is untouched.
    expect(ids.slice(0, 5)).toEqual(["p1", "t1", "p2", "t2", "c2"]);
    expect(ids.slice(6)).toEqual(["p3", "t3"]);
    const added = next[5]!;
    expect(added).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list_suites" },
    });
    expect(next[3]).toMatchObject({
      id: "t2",
      assertion: { toolName: "generate_cases" },
    });

    const removed = replaceActionTools(steps, "p2", current, []);
    expect(removed.map((step) => step.id)).toEqual([
      "p1",
      "t1",
      "p2",
      "c2",
      "p3",
      "t3",
    ]);
  });
});
