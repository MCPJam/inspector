import { describe, expect, it } from "vitest";
import { buildStageAuthoredCase } from "../stage-inputs.js";
import type { TestStep } from "@mcpjam/sdk/contract";

// =============================================================================
// `buildStageAuthoredCase` decides stage APPLICABILITY for every inspector
// iteration, which is what separates "this stage does not apply to this case"
// from "this stage was not measured". Getting it wrong does not crash anything
// — it silently reports a stage the case never exercised as an evidence gap,
// or drops a stage the case really does assert. Hence the branch-by-branch
// coverage here.
// =============================================================================

const promptStep = (id: string): TestStep =>
  ({ id, kind: "prompt", prompt: "do the thing" }) as TestStep;

const toolCallStep = (id: string): TestStep =>
  ({ id, kind: "toolCall", toolName: "list_files", arguments: {} }) as TestStep;

const predicateAssertStep = (id: string): TestStep =>
  ({
    id,
    kind: "assert",
    assertion: { type: "noToolErrors" },
  }) as TestStep;

const widgetAssertStep = (id: string): TestStep =>
  ({
    id,
    kind: "assert",
    assertion: { kind: "textVisible", text: "Refunded" },
  }) as TestStep;

describe("buildStageAuthoredCase", () => {
  it("reads an expected tool call from the case's top-level field", () => {
    const result = buildStageAuthoredCase({
      test: { expectedToolCalls: [{ toolName: "list_files", arguments: {} }] },
      caseNeedsModel: true,
    });
    expect(result).toEqual({
      mode: "model_driven",
      expectsToolCall: true,
      expectsWidgetRender: false,
      assertionCount: 0,
    });
  });

  it("reads an expected tool call from a turn when the case has none", () => {
    const result = buildStageAuthoredCase({
      test: {},
      turns: [
        { expectedToolCalls: [] },
        { expectedToolCalls: [{ toolName: "search" }] },
      ],
      caseNeedsModel: true,
    });
    expect(result.expectsToolCall).toBe(true);
  });

  it("reads an expected tool call from an authored toolCall step", () => {
    const result = buildStageAuthoredCase({
      test: {},
      steps: [promptStep("s1"), toolCallStep("s2")],
      caseNeedsModel: true,
    });
    expect(result.expectsToolCall).toBe(true);
  });

  it("treats a legacy widget_probe case as asserting a render", () => {
    const result = buildStageAuthoredCase({
      test: { caseType: "widget_probe" },
      caseNeedsModel: false,
    });
    expect(result.mode).toBe("model_free");
    expect(result.expectsWidgetRender).toBe(true);
  });

  it("treats a widget assertion step as asserting a render", () => {
    const result = buildStageAuthoredCase({
      test: {},
      steps: [widgetAssertStep("s1")],
      caseNeedsModel: true,
    });
    expect(result.expectsWidgetRender).toBe(true);
    // The assert step still counts toward user-value assertions.
    expect(result.assertionCount).toBe(1);
  });

  it("does not mistake a PREDICATE assertion for a widget one", () => {
    // The two payloads are disjoint by discriminator (`kind` vs `type`), and
    // conflating them would demand render evidence the case never asked for.
    const result = buildStageAuthoredCase({
      test: {},
      steps: [predicateAssertStep("s1")],
      caseNeedsModel: true,
    });
    expect(result.expectsWidgetRender).toBe(false);
    expect(result.assertionCount).toBe(1);
  });

  it("counts predicates, expectedOutput and assert steps together", () => {
    const result = buildStageAuthoredCase({
      test: {
        successPredicates: [{ type: "noToolErrors" }, { type: "toolCalled" }],
        expectedOutput: "Refunded",
      },
      steps: [predicateAssertStep("s1")],
      caseNeedsModel: true,
    });
    expect(result.assertionCount).toBe(4);
  });

  it("reports model_free when no turn needs the model", () => {
    expect(
      buildStageAuthoredCase({ test: {}, caseNeedsModel: false }).mode
    ).toBe("model_free");
  });

  it("an empty case asserts nothing and expects nothing", () => {
    const result = buildStageAuthoredCase({
      test: {},
      steps: [],
      turns: [],
      caseNeedsModel: true,
    });
    expect(result).toEqual({
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
    });
  });

  // ── UVH-IN1: the per-kind tool-call predicate matrix ─────────────────────
  //
  // The three kinds do NOT share applicability, and treating them as one group
  // gets a case wrong in both directions: a positive assertion that leaves
  // `call` inapplicable, or a forbidden-call assertion that demands evidence
  // of the very call it exists to rule out.

  const toolPredicateStep = (id: string, type: string): TestStep =>
    ({
      id,
      kind: "assert",
      assertion: { type, toolName: "get_project" },
    }) as TestStep;

  it.each(["toolCalledAtLeastOnce", "firstToolWas"])(
    "%s expects a tool call and is not a user-value assertion",
    (type) => {
      const result = buildStageAuthoredCase({
        test: {},
        steps: [toolPredicateStep("a1", type)],
        caseNeedsModel: true,
      });
      expect(result).toEqual({
        mode: "model_driven",
        expectsToolCall: true,
        expectsWidgetRender: false,
        // Routed to `selection`, so it cannot also be what grades user value.
        assertionCount: 0,
      });
    }
  );

  it("toolNeverCalled does NOT expect a tool call", () => {
    // The asymmetry that makes this a matrix rather than a set. A case whose
    // only tool assertion forbids a call expects none; turning `call` on would
    // demand evidence of the thing the case exists to forbid.
    const result = buildStageAuthoredCase({
      test: {},
      steps: [toolPredicateStep("a1", "toolNeverCalled")],
      caseNeedsModel: true,
    });
    expect(result).toEqual({
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
    });
  });

  it("excludes tool-call predicates from assertionCount, keeping the rest", () => {
    const result = buildStageAuthoredCase({
      test: {
        successPredicates: [
          { type: "toolCalledAtLeastOnce", toolName: "get_project" },
          { type: "responseContains", needle: "Refunded" },
        ],
      },
      steps: [
        toolPredicateStep("a1", "toolNeverCalled"),
        predicateAssertStep("a2"),
      ],
      caseNeedsModel: true,
    });
    // Two user-value assertions survive: `responseContains` and `noToolErrors`.
    expect(result.assertionCount).toBe(2);
    expect(result.expectsToolCall).toBe(true);
  });

  it("a widget assertion is never mistaken for a predicate kind", () => {
    // Widget assertions are keyed by `kind`, not `type`, so reading `.type`
    // off one must not accidentally match a selection kind.
    const result = buildStageAuthoredCase({
      test: {},
      steps: [widgetAssertStep("a1")],
      caseNeedsModel: true,
    });
    expect(result.assertionCount).toBe(1);
    expect(result.expectsWidgetRender).toBe(true);
    expect(result.expectsToolCall).toBe(false);
  });

  it("carries isNegativeTest through only when the case sets it", () => {
    expect(
      "isNegativeTest" in
        buildStageAuthoredCase({ test: {}, caseNeedsModel: true })
    ).toBe(false);
    expect(
      buildStageAuthoredCase({
        test: { isNegativeTest: true },
        caseNeedsModel: true,
      }).isNegativeTest
    ).toBe(true);
  });
});
