import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import {
  emitBrowserEvalMetrics,
  summarizeBrowserEvalMetrics,
} from "../browser-eval-metrics";
import { logger } from "../../../utils/logger";

const obs = (
  o: Partial<RunnerWidgetRenderObservation> = {},
): RunnerWidgetRenderObservation => ({
  toolCallId: "tc-a",
  toolName: "show_seats",
  serverId: "flights",
  status: "rendered",
  elapsedMs: 100,
  ts: 1,
  promptIndex: 0,
  ...o,
});

const step = (
  s: Partial<RunnerBrowserInteractionStep> = {},
): RunnerBrowserInteractionStep => ({
  toolCallId: "tc-a",
  stepIndex: 0,
  promptIndex: 0,
  action: "left_click",
  elapsedMs: 10,
  ts: 1,
  ...s,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summarizeBrowserEvalMetrics", () => {
  it("returns zeroed metrics for empty input", () => {
    const m = summarizeBrowserEvalMetrics([], []);
    expect(m).toMatchObject({
      renderCount: 0,
      renderedCount: 0,
      browserUnavailable: false,
      statusCounts: {},
      widgetCount: 0,
      totalSteps: 0,
      maxStepsPerWidget: 0,
      meanStepsPerWidget: 0,
      screenshotCount: 0,
      meanActionElapsedMs: 0,
      maxActionElapsedMs: 0,
      meanRenderElapsedMs: 0,
    });
  });

  it("aggregates statuses, steps-per-widget, screenshots, budgets, and latency", () => {
    const observations = [
      obs({ status: "rendered", screenshotBase64: "x" }),
      obs({ status: "rendered", screenshotBase64: "x", elapsedMs: 200 }),
      obs({ status: "bridge_timeout", elapsedMs: 300 }),
      obs({ status: "browser_unavailable", elapsedMs: 5 }),
    ];
    const steps = [
      step({ toolCallId: "tc-a", stepIndex: 0, screenshotBase64: "x", elapsedMs: 10 }),
      step({ toolCallId: "tc-a", stepIndex: 1, screenshotBase64: "x", elapsedMs: 20 }),
      step({
        toolCallId: "tc-a",
        stepIndex: 2,
        elapsedMs: 30,
        note: "step_budget_exceeded",
      }),
      step({
        toolCallId: "tc-b",
        stepIndex: 0,
        elapsedMs: 40,
        note: "no_rendered_widget",
      }),
    ];

    const m = summarizeBrowserEvalMetrics(observations, steps);

    expect(m.renderCount).toBe(4);
    expect(m.renderedCount).toBe(2);
    expect(m.browserUnavailable).toBe(true);
    expect(m.statusCounts).toEqual({
      rendered: 2,
      bridge_timeout: 1,
      browser_unavailable: 1,
    });
    expect(m.widgetCount).toBe(2);
    expect(m.totalSteps).toBe(4);
    expect(m.maxStepsPerWidget).toBe(3); // tc-a has 3
    expect(m.meanStepsPerWidget).toBe(2); // (3 + 1) / 2
    expect(m.screenshotCount).toBe(4); // 2 obs + 2 steps with a shot
    expect(m.stepBudgetExceededCount).toBe(1);
    expect(m.screenshotBudgetExceededCount).toBe(0);
    expect(m.noRenderedWidgetCount).toBe(1);
    expect(m.meanActionElapsedMs).toBe(25); // (10+20+30+40)/4
    expect(m.maxActionElapsedMs).toBe(40);
    expect(m.meanRenderElapsedMs).toBe(151); // round((100+200+300+5)/4)
  });
});

describe("emitBrowserEvalMetrics", () => {
  it("does NOT emit when there are no browser artifacts", () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    emitBrowserEvalMetrics([], []);
    emitBrowserEvalMetrics(undefined, undefined);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("emits one structured metric record with the summary", () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    emitBrowserEvalMetrics([obs()], [step()]);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      "[evals-metric] browser_eval",
      expect.objectContaining({ renderCount: 1, totalSteps: 1 }),
    );
  });

  it("never throws if logging fails (best-effort)", () => {
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("axiom down");
    });
    expect(() => emitBrowserEvalMetrics([obs()], [step()])).not.toThrow();
  });
});
