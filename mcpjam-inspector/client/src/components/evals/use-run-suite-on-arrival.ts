import { useEffect, useRef } from "react";
import {
  EVAL_RUN_PARAM,
  useAppNavigate,
  useCurrentLocationParts,
} from "@/lib/app-navigation";

/** Calls `run` once for `?run=<suiteId>`, dropping the key so Back won't rerun. */
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
