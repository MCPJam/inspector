import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  addAfterRunAssertion,
  applyAddChoice,
  editAfterRunAssertion,
} from "../case-steps-edits";

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Draw a box" },
  { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
  { id: "p2", kind: "prompt", prompt: "Now an arrow" },
];

describe("applyAddChoice", () => {
  it("adds a turn-scoped assertion at the end of the anchor step's block", () => {
    const result = applyAddChoice({
      steps,
      predicates: undefined,
      anchorStepId: "p1",
      choice: { kind: "check", predicateKind: "noToolErrors" },
      suiteServers: [],
    });
    expect(result.steps.map((step) => step.id).slice(0, 2)).toEqual([
      "p1",
      "a1",
    ]);
    expect(result.steps[2]?.kind).toBe("assert");
    expect(result.steps[3]?.id).toBe("p2");
    expect(result.addedKey).toBe(`step:${result.steps[2]?.id}`);
  });

  it("appends a new step after the last block when there is no anchor", () => {
    const result = applyAddChoice({
      steps,
      predicates: undefined,
      anchorStepId: null,
      choice: { kind: "step", stepKind: "prompt" },
      suiteServers: [],
    });
    expect(result.steps).toHaveLength(4);
    expect(result.steps[3]?.kind).toBe("prompt");
    expect(result.addedKey).toBe(`action:${result.steps[3]?.id}`);
  });

  it("leaves the case alone for choices the editor does not author here", () => {
    for (const choice of [
      { kind: "outcome" } as const,
      { kind: "route-check", routeKind: "noTools" } as const,
    ]) {
      const result = applyAddChoice({
        steps,
        predicates: undefined,
        anchorStepId: "p1",
        choice,
        suiteServers: [],
      });
      expect(result.steps).toBe(steps);
      expect(result.addedKey).toBeNull();
    }
  });
});

describe("after-run assertions", () => {
  it("switches an inheriting case to extend so the new assertion runs", () => {
    const result = addAfterRunAssertion(
      steps,
      { mode: "inherit", list: [{ type: "noToolErrors" }] },
      { type: "finalAssistantMessageNonEmpty" },
    );
    expect(result.predicates).toEqual({
      mode: "extend",
      list: [{ type: "finalAssistantMessageNonEmpty" }],
    });
    expect(result.addedKey).toBe("case:0");
  });

  it("keeps replace mode", () => {
    const result = addAfterRunAssertion(
      steps,
      { mode: "replace", list: [] },
      { type: "noToolErrors" },
    );
    expect(result.predicates?.mode).toBe("replace");
  });

  it("replaces or removes one assertion by index", () => {
    const predicates = {
      mode: "extend" as const,
      list: [
        { type: "noToolErrors" as const },
        { type: "finalAssistantMessageNonEmpty" as const },
      ],
    };
    expect(editAfterRunAssertion(predicates, 0, null)?.list).toEqual([
      { type: "finalAssistantMessageNonEmpty" },
    ]);
    expect(
      editAfterRunAssertion(predicates, 1, { type: "noToolErrors" })?.list,
    ).toEqual([{ type: "noToolErrors" }, { type: "noToolErrors" }]);
  });
});
