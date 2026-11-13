import { track } from "@/lib/analytics";

/**
 * View events for a run's results. Every event names the run whose page is
 * open, so a run visit (a distinct PostHog session and run id, counted when
 * the metric is read) can be joined to the case and iteration views made
 * during it, including views of a sibling run's column; `result_run_id` keeps
 * the run that owns the viewed result. Nothing is
 * deduplicated here: a per-tab guard would count pages opened in new tabs as
 * extra visits, which the drawers never were.
 */
type RunRef = { suiteId: string; runId: string };

export type RunViewSurface = "grid" | "case_page" | "iteration_page";
export type ResultSurface = "drawer" | "page";
export type IterationVia = "grid" | "pager" | "link";

const LOCATION = "evaluate_tab";

export function trackRunViewed(run: RunRef, surface: RunViewSurface): void {
  track("eval_run_viewed", {
    location: LOCATION,
    suite_id: run.suiteId,
    run_id: run.runId,
    surface,
  });
}

export function trackCaseResultViewed(
  run: RunRef,
  resultRunId: string,
  surface: ResultSurface,
): void {
  track("eval_case_result_viewed", {
    location: LOCATION,
    suite_id: run.suiteId,
    run_id: run.runId,
    result_run_id: resultRunId,
    surface,
  });
}

export function trackIterationViewed(
  run: RunRef,
  resultRunId: string,
  surface: ResultSurface,
  via: IterationVia,
): void {
  track("eval_iteration_viewed", {
    location: LOCATION,
    suite_id: run.suiteId,
    run_id: run.runId,
    result_run_id: resultRunId,
    surface,
    via,
  });
}
