import { describe, expect, it } from "vitest";
import {
  collectModelVisibleWidgetCalls,
  buildEvalWidgetContextSystemPrompt,
  withWidgetContextSystemPrompt,
} from "../widget-interaction-context";
import type { RunnerBrowserInteractionStep } from "@/shared/eval-trace";

function step(
  widgetToolCalls: RunnerBrowserInteractionStep["widgetToolCalls"]
): RunnerBrowserInteractionStep {
  return {
    toolCallId: "t1",
    stepIndex: 0,
    action: "left_click",
    ok: true,
    elapsedMs: 0,
    ts: 1,
    ...(widgetToolCalls ? { widgetToolCalls } : {}),
  } as RunnerBrowserInteractionStep;
}

const okCall = (over: Record<string, unknown> = {}) => ({
  name: "add-to-cart",
  args: {},
  ok: true,
  elapsedMs: 1,
  result: { content: [{ type: "text", text: "added redbull" }] },
  ...over,
});

describe("collectModelVisibleWidgetCalls", () => {
  it("includes calls with absent/model visibility", () => {
    const calls = collectModelVisibleWidgetCalls([
      step([okCall()]), // visibility absent ⇒ default model-visible
      step([okCall({ name: "m", visibility: ["model"] })]),
      step([okCall({ name: "mb", visibility: ["model", "app"] })]),
    ]);
    expect(calls.map((c) => c.toolName)).toEqual(["add-to-cart", "m", "mb"]);
  });

  it("excludes app-only calls (visibility exactly [app])", () => {
    const calls = collectModelVisibleWidgetCalls([
      step([okCall({ name: "refresh", visibility: ["app"] })]),
    ]);
    expect(calls).toEqual([]);
  });

  it("excludes error calls and calls without a recorded result", () => {
    const calls = collectModelVisibleWidgetCalls([
      step([{ name: "boom", args: {}, ok: false, error: "x", elapsedMs: 1 }]),
      step([{ name: "legacy", args: {}, ok: true, elapsedMs: 1 }]), // no result
    ]);
    expect(calls).toEqual([]);
  });

  it("returns [] for steps with no widget calls", () => {
    expect(collectModelVisibleWidgetCalls([step(undefined)])).toEqual([]);
  });
});

describe("buildEvalWidgetContextSystemPrompt", () => {
  it("returns empty string when there are no model-visible calls", () => {
    expect(
      buildEvalWidgetContextSystemPrompt([
        step([okCall({ visibility: ["app"] })]),
      ])
    ).toBe("");
  });

  it("renders the tool name and result content", () => {
    const prompt = buildEvalWidgetContextSystemPrompt([step([okCall()])]);
    expect(prompt).toContain("add-to-cart");
    expect(prompt).toContain("added redbull");
    expect(prompt).toContain("current app state");
  });
});

describe("withWidgetContextSystemPrompt", () => {
  it("returns the base unchanged when there is no widget context", () => {
    expect(withWidgetContextSystemPrompt("BASE", [])).toBe("BASE");
  });

  it("appends the addendum after the base, separated by a blank line", () => {
    const out = withWidgetContextSystemPrompt("BASE", [step([okCall()])]);
    expect(out.startsWith("BASE\n\n")).toBe(true);
    expect(out).toContain("add-to-cart");
  });
});
