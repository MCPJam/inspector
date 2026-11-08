import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadComparePanes,
  paneHostId,
  paneHostIds,
  panesForHostIds,
  saveComparePanes,
  subscribeComparePanes,
  syncLeadPane,
  type ComparePane,
} from "@/lib/compare-panes";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";

// Per project, like the lineup: opening another project must not inherit this
// one's Compare state.
const MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX =
  "mcp-inspector-multi-host-enabled";

function multiHostEnabledKey(projectId: string): string {
  return `${MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX}:${projectId}`;
}

export interface UseComparePanesReturn {
  /** The lineup, with pane 0 on the lead (the project's previewed client). */
  panes: readonly ComparePane[];
  /** Each client pane's client, in order: what the client chips show. */
  selectedHostIds: string[];
  /**
   * Sets the lineup from client ids, keeping the pane of every client already
   * in it. Updates React state and mirrors it to storage without notifying
   * subscribers; `promoteLeadPane` is the write that notifies.
   */
  setSelectedHostIds: (hostIds: string[]) => void;
  multiHostEnabled: boolean;
  setMultiHostEnabled: (enabled: boolean) => void;
}

/**
 * The project's Compare panes and the "comparing clients" toggle, persisted
 * per project. React state is the source of truth for in-app writes; storage
 * mirrors it. The lead comes from `usePreviewedHostId`, and the lineup is
 * re-read through `syncLeadPane`, so a surface that changes the previewed
 * client directly moves or replaces pane 0 without changing the pane count.
 */
export function useComparePanes(
  projectId: string | null,
): UseComparePanesReturn {
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  const [storedPanes, setStoredPanes] = useState<readonly ComparePane[]>([]);
  const [multiHostEnabled, setMultiHostEnabledState] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Re-read on a project change, so one project never shows another's lineup.
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsInitialized(true);
      return;
    }
    setStoredPanes(loadComparePanes(projectId));
    try {
      setMultiHostEnabledState(
        !!projectId &&
          localStorage.getItem(multiHostEnabledKey(projectId)) === "true",
      );
    } catch (error) {
      console.warn(
        "Failed to load the Compare lineup from localStorage:",
        error,
      );
    }
    setIsInitialized(true);
    return subscribeComparePanes(() => {
      setStoredPanes(loadComparePanes(projectId));
    });
  }, [projectId]);

  useEffect(() => {
    if (!isInitialized || typeof window === "undefined" || !projectId) return;
    try {
      localStorage.setItem(
        multiHostEnabledKey(projectId),
        multiHostEnabled ? "true" : "false",
      );
    } catch (error) {
      console.warn("Failed to save the Compare lineup to localStorage:", error);
    }
    saveComparePanes(projectId, storedPanes);
  }, [isInitialized, multiHostEnabled, storedPanes, projectId]);

  const panes = useMemo(
    () => syncLeadPane(storedPanes, previewedHostId),
    [storedPanes, previewedHostId],
  );
  const selectedHostIds = useMemo(() => paneHostIds(panes), [panes]);

  const setSelectedHostIds = useCallback(
    (hostIds: string[]) => {
      const next = panesForHostIds(panes, hostIds);
      setStoredPanes(next);
      // An explicit lineup that drops the lead moves the lead to its new pane
      // 0. Left alone, `syncLeadPane` would read the dropped lead as an
      // outside lead change and put it back, so the lead could never be
      // unchecked. An empty lineup keeps the lead: it means "the lead alone".
      if (next.length === 0 || !previewedHostId) return;
      if (next.some((pane) => paneHostId(pane) === previewedHostId)) return;
      const lead = paneHostId(next[0]);
      if (lead) setPreviewedHostId(lead);
    },
    [panes, previewedHostId, setPreviewedHostId],
  );

  const setMultiHostEnabled = useCallback((enabled: boolean) => {
    setMultiHostEnabledState(enabled);
  }, []);

  return {
    panes,
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  };
}
