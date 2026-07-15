import type {
  EvalTraceWidgetRenderStatus,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";

/**
 * PR 13 — observability for browser-rendered MCP App evals.
 *
 * Emits one structured `[evals-metric] browser_eval` record per iteration that
 * exercised the headless-Chromium harness, computed entirely from the
 * already-collected `widgetRenderObservations` + `browserInteractionSteps`
 * arrays at the shared `finalizeEvalIteration` choke point (covers both the
 * stream and non-stream paths). `logger.info` ingests to Axiom, so rates are
 * aggregated downstream — this is the per-iteration sample those rates sum over.
 *
 * What the budget defaults can be defended with (HarnessBudgets):
 *   - `maxStepsPerWidget` / `meanStepsPerWidget` → maxBrowserStepsPerWidget (12)
 *   - `screenshotCount`                          → totalScreenshotsPerIteration (60)
 *   - `stepBudgetExceededCount` /
 *     `screenshotBudgetExceededCount`            → cap-hit rate
 *   - `browserUnavailable`                       → browser_unavailable rate
 *   - `statusCounts`                             → render status distribution
 *   - `meanActionElapsedMs` / `maxActionElapsedMs` → Computer Use latency
 */
export type BrowserEvalMetrics = {
  /** Total render attempts recorded this iteration. */
  renderCount: number;
  /** How many ended `rendered`. */
  renderedCount: number;
  /** True if any render fell back to `browser_unavailable` (Chromium missing). */
  browserUnavailable: boolean;
  /** Counts keyed by render status (only non-zero statuses present). */
  statusCounts: Partial<Record<EvalTraceWidgetRenderStatus, number>>;
  /** Distinct widgets (toolCallIds) the model interacted with. */
  widgetCount: number;
  /** Total Computer Use steps across all widgets. */
  totalSteps: number;
  maxStepsPerWidget: number;
  meanStepsPerWidget: number;
  /** Screenshots captured (render + step), the per-iteration budget signal. */
  screenshotCount: number;
  stepBudgetExceededCount: number;
  screenshotBudgetExceededCount: number;
  noRenderedWidgetCount: number;
  meanActionElapsedMs: number;
  maxActionElapsedMs: number;
  meanRenderElapsedMs: number;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function summarizeBrowserEvalMetrics(
  observations: RunnerWidgetRenderObservation[],
  steps: RunnerBrowserInteractionStep[],
): BrowserEvalMetrics {
  const statusCounts: Partial<Record<EvalTraceWidgetRenderStatus, number>> = {};
  for (const obs of observations) {
    statusCounts[obs.status] = (statusCounts[obs.status] ?? 0) + 1;
  }

  const stepsByWidget = new Map<string, number>();
  for (const step of steps) {
    stepsByWidget.set(
      step.toolCallId,
      (stepsByWidget.get(step.toolCallId) ?? 0) + 1,
    );
  }
  const perWidgetCounts = [...stepsByWidget.values()];

  const screenshotCount =
    observations.filter((o) => Boolean(o.screenshotBase64)).length +
    steps.filter((s) => Boolean(s.screenshotBase64)).length;

  const stepElapsed = steps.map((s) => s.elapsedMs);

  return {
    renderCount: observations.length,
    renderedCount: statusCounts.rendered ?? 0,
    browserUnavailable: (statusCounts.browser_unavailable ?? 0) > 0,
    statusCounts,
    widgetCount: stepsByWidget.size,
    totalSteps: steps.length,
    maxStepsPerWidget:
      perWidgetCounts.length > 0 ? Math.max(...perWidgetCounts) : 0,
    meanStepsPerWidget: mean(perWidgetCounts),
    screenshotCount,
    stepBudgetExceededCount: steps.filter(
      (s) => s.note === "step_budget_exceeded",
    ).length,
    screenshotBudgetExceededCount: steps.filter(
      (s) => s.note === "screenshot_budget_exceeded",
    ).length,
    noRenderedWidgetCount: steps.filter((s) => s.note === "no_rendered_widget")
      .length,
    meanActionElapsedMs: mean(stepElapsed),
    maxActionElapsedMs: stepElapsed.length > 0 ? Math.max(...stepElapsed) : 0,
    meanRenderElapsedMs: mean(observations.map((o) => o.elapsedMs)),
  };
}

/**
 * Emit the per-iteration browser-eval metric. No-op when the iteration didn't
 * touch the harness (no observations and no steps) so non-browser evals stay
 * silent. Best-effort: never throws into the finalize path.
 */
export function emitBrowserEvalMetrics(
  observations: RunnerWidgetRenderObservation[] | undefined,
  steps: RunnerBrowserInteractionStep[] | undefined,
): void {
  const obs = observations ?? [];
  const stp = steps ?? [];
  if (obs.length === 0 && stp.length === 0) return;
  try {
    logger.info(
      "[evals-metric] browser_eval",
      summarizeBrowserEvalMetrics(obs, stp),
    );
  } catch {
    /* metrics are best-effort; never break finalize */
  }
}
