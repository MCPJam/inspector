import { describe, it, expect } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  bucketStepToolCallsByPrompt,
  buildStepCheckResults,
  buildStepResultRecords,
  buildStepScriptedCheckFailures,
} from "../step-verdict-adapters";

describe("buildStepResultRecords", () => {
  const steps: TestStep[] = [
    { id: "p0", kind: "prompt", prompt: "show redbull" },
    { id: "a0", kind: "assert", assertion: { type: "toolCalledWith" } } as any,
    {
      id: "i0",
      kind: "interact",
      toolName: "store",
      action: { type: "click" },
    } as any,
    { id: "a1", kind: "assert", assertion: { type: "toolCalledWith" } } as any,
  ];

  it("emits one stepId-keyed row per authored step, covering every kind", () => {
    const state = {
      assertionResults: [
        { stepId: "a0", stepIndex: 1, passed: true, reason: "called search" },
      ],
      interactionFailures: [
        { stepId: "i0", stepIndex: 2, toolName: "store", reason: "locator timeout" },
      ],
      skippedSteps: [
        { stepId: "a1", stepIndex: 3, kind: "assert", reason: "halted at step 2" },
      ],
    };
    expect(buildStepResultRecords(state, steps)).toEqual([
      { stepId: "p0", stepIndex: 0, kind: "prompt", status: "ok" },
      { stepId: "a0", stepIndex: 1, kind: "assert", status: "ok", reason: "called search" },
      { stepId: "i0", stepIndex: 2, kind: "interact", status: "fail", reason: "locator timeout" },
      { stepId: "a1", stepIndex: 3, kind: "assert", status: "skipped", reason: "halted at step 2" },
    ]);
  });

  it("marks an assert with no recorded result as pending (not a false pass)", () => {
    const state = {
      assertionResults: [],
      interactionFailures: [],
      skippedSteps: [],
    };
    const out = buildStepResultRecords(state, steps);
    expect(out.find((r) => r.stepId === "a0")?.status).toBe("pending");
    // prompt + interact (no failure) default to ok.
    expect(out.find((r) => r.stepId === "p0")?.status).toBe("ok");
    expect(out.find((r) => r.stepId === "i0")?.status).toBe("ok");
  });
});

describe("bucketStepToolCallsByPrompt", () => {
  it("densifies the per-turn bucket to one slot per turn", () => {
    const state = {
      toolCallsByTurn: [
        [{ toolName: "search", arguments: { q: "x" } }],
        // turn 1 had no calls (sparse hole)
        ,
        [{ toolName: "view-cart", arguments: {} }],
      ] as any,
    };
    expect(bucketStepToolCallsByPrompt(state, 3)).toEqual([
      [{ toolName: "search", arguments: { q: "x" } }],
      [],
      [{ toolName: "view-cart", arguments: {} }],
    ]);
  });

  it("pads trailing turns with no calls to empty slots", () => {
    const state = { toolCallsByTurn: [[{ toolName: "a", arguments: {} }]] };
    expect(bucketStepToolCallsByPrompt(state, 3)).toEqual([
      [{ toolName: "a", arguments: {} }],
      [],
      [],
    ]);
  });
});

describe("buildStepCheckResults", () => {
  const steps: TestStep[] = [
    { id: "p0", kind: "prompt", prompt: "one" },
    {
      id: "a0",
      kind: "assert",
      assertion: { type: "responseContains", needle: "ok" },
    },
    { id: "p1", kind: "prompt", prompt: "two" },
    {
      id: "a1",
      kind: "assert",
      assertion: { type: "responseContains", needle: "done" },
    },
  ];

  it("scope-tags transcript-predicate asserts by their turn ordinal", () => {
    const state = {
      assertionResults: [
        {
          stepId: "a0",
          stepIndex: 1,
          passed: true,
          reason: "...",
          predicateResult: {
            predicate: { type: "responseContains", needle: "ok" },
            passed: true,
            reason: "contains ok",
          },
        },
        {
          stepId: "a1",
          stepIndex: 3,
          passed: true,
          reason: "...",
          predicateResult: {
            predicate: { type: "responseContains", needle: "done" },
            passed: true,
            reason: "contains done",
          },
        },
      ],
    } as any;
    const results = buildStepCheckResults(state, steps);
    expect(results).toHaveLength(2);
    expect(results[0]!.scope).toEqual({ kind: "turn", promptIndex: 0 });
    expect(results[1]!.scope).toEqual({ kind: "turn", promptIndex: 1 });
  });

  it("excludes widget DOM-assert results (no predicateResult)", () => {
    const state = {
      assertionResults: [
        // A widget DOM assert — gate-only, no predicateResult.
        { stepId: "w0", stepIndex: 1, passed: false, reason: "not visible" },
      ],
    } as any;
    expect(buildStepCheckResults(state, steps)).toEqual([]);
  });
});

describe("buildStepScriptedCheckFailures (§2)", () => {
  it("folds failed interacts + failed widget DOM asserts; excludes transcript asserts + passes", () => {
    const state = {
      interactionFailures: [
        { stepId: "i0", stepIndex: 1, toolName: "search-products", reason: "no widget" },
      ],
      assertionResults: [
        // Failed widget DOM assert (no predicateResult) → included.
        { stepId: "w0", stepIndex: 2, passed: false, reason: "text not visible" },
        // Failed transcript-predicate assert → EXCLUDED (already gates via predicates).
        {
          stepId: "a0",
          stepIndex: 3,
          passed: false,
          reason: "tool not called",
          predicateResult: { predicate: { type: "toolNeverCalled", toolName: "x" }, passed: false, reason: "..." },
        },
        // Passed widget DOM assert → excluded.
        { stepId: "w1", stepIndex: 4, passed: true, reason: "ok" },
      ],
    } as any;
    expect(buildStepScriptedCheckFailures(state)).toEqual([
      { toolName: "search-products", reason: "no widget" },
      { toolName: "widget-assertion", reason: "text not visible" },
    ]);
  });

  it("is empty when nothing failed", () => {
    expect(
      buildStepScriptedCheckFailures({
        interactionFailures: [],
        assertionResults: [{ stepId: "a", stepIndex: 0, passed: true, reason: "ok" }],
      } as any),
    ).toEqual([]);
  });
});
