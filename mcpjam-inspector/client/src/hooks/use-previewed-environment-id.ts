import { useCallback, useEffect, useState } from "react";
import {
  loadPreviewedEnvironmentId,
  savePreviewedEnvironmentId,
  subscribePreviewedEnvironmentId,
} from "@/lib/previewed-environment-storage";

/**
 * React subscription to the "previewed environment" for a project (Phase 2).
 * Shares the persistence pattern of
 * {@link import("./use-previewed-client-id").usePreviewedHostId}: multiple
 * surfaces (Connect's environments strip, the Playground host picker) call
 * this, and a write from any one of them reaches the others through the
 * same-tab `previewed-environment-changed` event.
 *
 * It differs in one respect on purpose — the returned id is SCOPED to the
 * `projectId` it was read for (see below). Selecting a stale host id merely
 * previews the wrong host; reporting a stale ENVIRONMENT id flips the
 * Playground into environment mode and points a turn at another project's
 * bundle, so the transition has to be closed synchronously.
 */
export function usePreviewedEnvironmentId(
  projectId: string | null
): readonly [string | null, (next: string | null) => void] {
  // The stored value is kept together with the project it was READ FOR, and
  // the returned id is derived by comparing that against the current project.
  // Repairing the mismatch in the effect instead would leave one committed
  // render in which the PREVIOUS project's environment id is reported under the
  // NEW project id — long enough for the Playground to enter environment mode
  // and request an environment that doesn't belong to the project it is asking
  // about.
  const [scoped, setScoped] = useState<{
    projectId: string | null;
    environmentId: string | null;
  }>(() => ({
    projectId: projectId ?? null,
    environmentId: projectId ? loadPreviewedEnvironmentId(projectId) : null,
  }));

  useEffect(() => {
    if (!projectId) {
      setScoped({ projectId: null, environmentId: null });
      return;
    }
    setScoped({
      projectId,
      environmentId: loadPreviewedEnvironmentId(projectId),
    });
    return subscribePreviewedEnvironmentId(projectId, () => {
      setScoped({
        projectId,
        environmentId: loadPreviewedEnvironmentId(projectId),
      });
    });
  }, [projectId]);

  // Null until the new project's own value has loaded — never the old one.
  const environmentId =
    scoped.projectId === (projectId ?? null) ? scoped.environmentId : null;

  const setEnvironmentId = useCallback(
    (next: string | null) => {
      if (!projectId) return;
      savePreviewedEnvironmentId(projectId, next);
    },
    [projectId]
  );

  return [environmentId, setEnvironmentId] as const;
}
