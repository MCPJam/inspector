import { useEffect, useRef, useState } from "react";

import {
  fetchSwarmFundingPreview,
  type SwarmFundingPreview,
  type SwarmFundingPreviewRunInput,
} from "@/lib/swarm-api";

/**
 * How a wave's conversations would be funded, for the create flow's Confirm
 * step: sponsored (MCPJam's per-user allowance) versus the organization's
 * credits.
 *
 * A one-shot request per plan, not a live subscription. It re-asks whenever the
 * plan (or `refreshKey`) changes, and a slower answer to an older plan never
 * paints over a newer one.
 *
 * The preview informs; it does not decide. A failed or unsupported preview
 * reads as "no sponsored conversations shown", the launch behaves exactly as it
 * did before sponsorship existed, and the backend still verifies any
 * `expectedSponsored` the launch carries.
 */
export type SwarmFundingPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: SwarmFundingPreview }
  | { status: "error" };

export function useSwarmFundingPreview({
  projectId,
  runs,
  refreshKey = 0,
}: {
  projectId: string | null | undefined;
  /** `null` when there is nothing to preview; nothing is fetched. */
  runs: SwarmFundingPreviewRunInput[] | null;
  /** Bump to force a fresh read of an unchanged plan (after a 409). */
  refreshKey?: number;
}): SwarmFundingPreviewState {
  const [state, setState] = useState<SwarmFundingPreviewState>({
    status: "idle",
  });
  const requestIdRef = useRef(0);
  const argsKey =
    projectId && runs && runs.length > 0
      ? JSON.stringify([projectId, runs, refreshKey])
      : null;

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (argsKey === null) {
      setState({ status: "idle" });
      return;
    }
    const [id, plan] = JSON.parse(argsKey) as [
      string,
      SwarmFundingPreviewRunInput[],
    ];
    setState({ status: "loading" });
    const controller = new AbortController();
    fetchSwarmFundingPreview(id, plan, controller.signal)
      .then((preview) => {
        if (requestId === requestIdRef.current) {
          setState({ status: "ready", preview });
        }
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [argsKey]);

  return state;
}
