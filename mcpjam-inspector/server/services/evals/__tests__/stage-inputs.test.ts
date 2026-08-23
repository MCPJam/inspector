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
