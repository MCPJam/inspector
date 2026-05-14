import { useCallback, useEffect, useState } from "react";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
  subscribePreviewedHostId,
} from "@/lib/previewed-host-storage";

/**
 * React subscription to the "previewed host" for a project. Multiple
 * surfaces (Connect's `HostOverlayBar`, Playground's `PlaygroundHeader`,
 * future tabs) call this — when any one calls the setter, the others
 * update through the same-tab `previewed-host-changed` event.
 */
export function usePreviewedHostId(
  projectId: string | null,
): readonly [string | null, (next: string | null) => void] {
  const [hostId, setHostIdState] = useState<string | null>(() =>
    projectId ? loadPreviewedHostId(projectId) : null,
  );

  useEffect(() => {
    if (!projectId) {
      setHostIdState(null);
      return;
    }
    setHostIdState(loadPreviewedHostId(projectId));
    return subscribePreviewedHostId(projectId, () => {
      setHostIdState(loadPreviewedHostId(projectId));
    });
  }, [projectId]);

  const setHostId = useCallback(
    (next: string | null) => {
      if (!projectId) return;
      savePreviewedHostId(projectId, next);
    },
    [projectId],
  );

  return [hostId, setHostId] as const;
}
