/**
 * eval_nav_page_viewed for the new Suite page, once per suite while it shows.
 * Props carry ids only, never suite names. `page`, `tab` and `ui` match what
 * the other new Evals pages send, so views can be compared page by page.
 */
import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";

export function useSuitePageViewed({
  enabled,
  projectId,
  suiteId,
}: {
  /** The new Suite page is showing (`eval-suite-results-page` is on). */
  enabled: boolean;
  projectId: string | null;
  suiteId: string;
}): void {
  // Re-renders and a flag that resolves late must not count a second view.
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || counted.current === suiteId) return;
    counted.current = suiteId;
    track("eval_nav_page_viewed", {
      location: "evaluate_tab",
      page: "suite",
      tab: null,
      ui: "nav",
      project_id: projectId,
    });
  }, [enabled, projectId, suiteId]);
}
