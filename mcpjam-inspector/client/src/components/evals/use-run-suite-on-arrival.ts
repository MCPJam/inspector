import { useEffect, useRef } from "react";
import {
  EVAL_RUN_PARAM,
  useAppNavigate,
  useCurrentLocationParts,
} from "@/lib/app-navigation";

/**
 * Calls `run` once with the suite id when the page is opened with
 * `?run=<suiteId>` (Home's Run eval).
 * The key is dropped first, so a refresh or Back does not run it again.
 */
export function useRunSuiteOnArrival(
  ready: boolean,
  run: (suiteId: string) => void,
) {
  const location = useCurrentLocationParts();
  const navigate = useAppNavigate();
  const requested = new URLSearchParams(location.search).get(EVAL_RUN_PARAM);
  const handled = useRef(false);

  useEffect(() => {
    if (!requested || !ready || handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(location.search);
    params.delete(EVAL_RUN_PARAM);
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}${location.hash}`, {
      replace: true,
    });
    run(requested);
  }, [requested, ready, run, location, navigate]);
}
