import { useCallback, useEffect, useState } from "react";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
  subscribePreviewedHostId,
} from "@/lib/previewed-client-storage";

/**
 * React subscription to the "previewed host" for a project. Multiple
 * surfaces (Connect's `HostOverlayBar`, Playground's `PlaygroundHeader`,
 * future tabs) call this — when any one calls the setter, the others
 * update through the same-tab `previewed-host-changed` event.
 *
 * The returned id is SCOPED to the `projectId` it was read for, the same way
 * {@link import("./use-previewed-environment-id").usePreviewedEnvironmentId}
 * scopes its own value: on a project switch it reads as null until the new
 * project's own value has loaded, rather than reporting the previous
 * project's host for one committed render.
 */
export function usePreviewedHostId(
  projectId: string | null,
): readonly [string | null, (next: string | null) => void] {
  // The stored value is kept together with the project it was READ FOR, and
  // the returned id is derived by comparing that against the current project.
  // Repairing the mismatch in the effect instead would leave one committed
  // render in which the PREVIOUS project's host id is reported under the NEW
  // project id — long enough for the Playground to preview, and act on, a host
  // that doesn't belong to the project it is asking about.
  const [scoped, setScoped] = useState<{
    projectId: string | null;
    hostId: string | null;
  }>(() => ({
    projectId: projectId ?? null,
    hostId: projectId ? loadPreviewedHostId(projectId) : null,
  }));

  useEffect(() => {
    if (!projectId) {
      setScoped({ projectId: null, hostId: null });
      return;
    }
    setScoped({ projectId, hostId: loadPreviewedHostId(projectId) });
    return subscribePreviewedHostId(projectId, () => {
      setScoped({ projectId, hostId: loadPreviewedHostId(projectId) });
    });
  }, [projectId]);

  // Null until the new project's own value has loaded — never the old one.
  const hostId =
    scoped.projectId === (projectId ?? null) ? scoped.hostId : null;

  const setHostId = useCallback(
    (next: string | null) => {
      if (!projectId) return;
      savePreviewedHostId(projectId, next);
    },
    [projectId],
  );

  return [hostId, setHostId] as const;
}
