import { useCallback, useEffect, useState } from "react";
import {
  loadPreviewedEnvironmentId,
  savePreviewedEnvironmentId,
  subscribePreviewedEnvironmentId,
} from "@/lib/previewed-environment-storage";

/**
 * React subscription to the "previewed environment" for a project (Phase 2).
 * Mirrors {@link import("./use-previewed-client-id").usePreviewedHostId}
 * exactly, including its persistence pattern: multiple surfaces (Connect's
 * environments strip, the Playground host picker) call this, and a write from
 * any one of them reaches the others through the same-tab
 * `previewed-environment-changed` event.
 */
export function usePreviewedEnvironmentId(
  projectId: string | null
): readonly [string | null, (next: string | null) => void] {
  const [environmentId, setEnvironmentIdState] = useState<string | null>(() =>
    projectId ? loadPreviewedEnvironmentId(projectId) : null
  );

  useEffect(() => {
    if (!projectId) {
      setEnvironmentIdState(null);
      return;
    }
    setEnvironmentIdState(loadPreviewedEnvironmentId(projectId));
    return subscribePreviewedEnvironmentId(projectId, () => {
      setEnvironmentIdState(loadPreviewedEnvironmentId(projectId));
    });
  }, [projectId]);

  const setEnvironmentId = useCallback(
    (next: string | null) => {
      if (!projectId) return;
      savePreviewedEnvironmentId(projectId, next);
    },
    [projectId]
  );

  return [environmentId, setEnvironmentId] as const;
}
