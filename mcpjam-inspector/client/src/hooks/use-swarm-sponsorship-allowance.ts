import { useEffect, useMemo, useState } from "react";

import { useOptionalSharedAppState } from "@/state/app-state-context";
import { fetchSwarmFundingPreview } from "@/lib/swarm-api";

import {
  subscribeSwarmAllowance,
  type SwarmSponsorshipAllowance,
  type SwarmSponsorshipAllowanceState,
} from "@/lib/swarm-sponsorship-allowance-store";
export type {
  SwarmSponsorshipAllowance,
  SwarmSponsorshipAllowanceState,
} from "@/lib/swarm-sponsorship-allowance-store";

/**
 * The signed-in user's sponsored swarm conversations, with whether they are
 * still loading, unreadable, or not offered here.
 *
 * It is the funding preview with nothing to preview: the allowance belongs to
 * the user, but the preview route authorizes against a project, so this reads
 * through the active one. Sponsorship does not apply on a self-hosted server
 * without the service token, an older backend, or for an anonymous user;
 * without an active shared project, or when disabled, it is not offered either.
 */
export function useSwarmSponsorshipAllowanceState(
  enabled = true,
): SwarmSponsorshipAllowanceState {
  const appState = useOptionalSharedAppState();
  const activeProject = appState?.activeProjectId
    ? appState.projects[appState.activeProjectId]
    : undefined;
  const projectId = activeProject?.sharedProjectId ?? null;
  const [state, setState] = useState<SwarmSponsorshipAllowanceState>({
    status: "loading",
  });

  useEffect(() => {
    if (!enabled || !projectId) {
      setState({ status: "unsupported" });
      return;
    }
    setState({ status: "loading" });
    return subscribeSwarmAllowance(projectId, setState, async (signal) => {
      const preview = await fetchSwarmFundingPreview(projectId, [], signal);
      return preview.supported && preview.granted > 0
        ? {
            status: "ready",
            remaining: preview.remaining,
            granted: preview.granted,
          }
        : { status: "unsupported" };
    });
  }, [enabled, projectId]);

  return state;
}

/**
 * The allowance for the usage surfaces (sidebar credits, organization usage
 * card): `null` unless it is known, so they show no row rather than a number
 * that could be wrong.
 */
export function useSwarmSponsorshipAllowance(
  enabled = true,
): SwarmSponsorshipAllowance | null {
  const state = useSwarmSponsorshipAllowanceState(enabled);
  return useMemo(
    () =>
      state.status === "ready"
        ? { remaining: state.remaining, granted: state.granted }
        : null,
    [state],
  );
}
