import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  afterTheRunRows,
  deleteActionPlan,
  isQuietCase,
  moveActionBlock,
  removeActionWithChecks,
  spineStatus,
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
