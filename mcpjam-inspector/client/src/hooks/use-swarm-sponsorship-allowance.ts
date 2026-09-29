import { useEffect, useState } from "react";

import { useOptionalSharedAppState } from "@/state/app-state-context";
import { fetchSwarmFundingPreview } from "@/lib/swarm-api";

export interface SwarmSponsorshipAllowance {
  /** Sponsored swarm conversations left in the signed-in user's allowance. */
  remaining: number;
  granted: number;
}

/**
 * The signed-in user's remaining sponsored swarm conversations, for the usage
 * surfaces (sidebar credits, organization usage card).
 *
 * It is the funding preview with nothing to preview: the allowance belongs to
 * the user, but the preview route authorizes against a project, so this reads
 * through the active one. `null` while loading and whenever sponsorship does
 * not apply here (a self-hosted server without the service token, an older
 * backend, an anonymous user, a failed read): the surfaces then show no row
 * rather than a number that could be wrong.
 */
export function useSwarmSponsorshipAllowance(
  enabled = true,
): SwarmSponsorshipAllowance | null {
  const appState = useOptionalSharedAppState();
  const activeProject = appState?.activeProjectId
    ? appState.projects[appState.activeProjectId]
    : undefined;
  const projectId = activeProject?.sharedProjectId ?? null;
  const [allowance, setAllowance] = useState<SwarmSponsorshipAllowance | null>(
    null,
  );

  useEffect(() => {
    setAllowance(null);
    if (!enabled || !projectId) return;
    const controller = new AbortController();
    fetchSwarmFundingPreview(projectId, [], controller.signal)
      .then((preview) => {
        if (controller.signal.aborted) return;
        setAllowance(
          preview.supported && preview.granted > 0
            ? { remaining: preview.remaining, granted: preview.granted }
            : null,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setAllowance(null);
      });
    return () => controller.abort();
  }, [enabled, projectId]);

  return allowance;
}
