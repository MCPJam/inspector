import { track } from "@/lib/analytics";

/** Where a run starts from, for the `conformance_run_triggered` event. */
export type ConformanceRunAnalyticsLocation =
  | "conformance_tab"
  | "score_runner"
  | "compat_page"
  | "compat_detail_modal";

/**
 * One event per UI run, however many suite requests it makes. The CLI and
 * the SDK send the same name with their own `run_source`.
 */
export function trackConformanceRunTriggered(
  location: ConformanceRunAnalyticsLocation,
): void {
  track("conformance_run_triggered", { location, run_source: "ui" });
}
