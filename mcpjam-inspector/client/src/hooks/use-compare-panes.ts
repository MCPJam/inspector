import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadComparePanes,
  paneHostId,
  paneHostIds,
  panesForHostIds,
  retargetPane,
  type ComparePaneTarget,
  saveComparePanes,
  subscribeComparePanes,
  syncLeadPane,
} from "@/lib/compare-panes";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import {
  retainPaneOverrides,
  type PaneOverrides,
} from "@/lib/compare-pane-overrides";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import type { RequestedModelSelection } from "@mcpjam/sdk/browser";

// Per project, like the lineup: opening another project must not inherit this
// one's Compare state.
const MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX =
  "mcp-inspector-multi-host-enabled";

function multiHostEnabledKey(projectId: string): string {
  return `${MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX}:${projectId}`;
}

export interface UseComparePanesReturn {
  /** The lineup, with pane 0 on the lead (the project's previewed client). */
  panes: readonly RecoveryPane[];
  restorePanes: (panes: readonly RecoveryPane[]) => void;
  setPaneOverrides: (paneId: string, overrides: PaneOverrides) => void;
  /**
   * Runs a pane on another client or environment. It keeps its place and id;
   * its picked model and server choices belonged to the old target and go.
   */
  setPaneTarget: (paneId: string, target: ComparePaneTarget) => void;
  /** Picks a model for one pane, or `undefined` to follow its client again. */
  setPanePick: (
    paneId: string,
    pickedSelection: RequestedModelSelection | undefined,
  ) => void;
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
  const [storedPanes, setStoredPanes] = useState<readonly RecoveryPane[]>([]);
  const [multiHostEnabled, setMultiHostEnabledState] = useState(false);
  const [loadedProject, setLoadedProject] = useState<string | null>(null);

  // Re-read on a project change, so one project never shows another's lineup.
  useEffect(() => {
    if (typeof window === "undefined") {
      setLoadedProject(projectId);
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
    setLoadedProject(projectId);
    return subscribeComparePanes(() => {
      const next = loadComparePanes(projectId);
      setStoredPanes((current) => retainPaneOverrides(next, current));
    });
  }, [projectId]);

  useEffect(() => {
    if (
      loadedProject !== projectId ||
      typeof window === "undefined" ||
      !projectId
    )
      return;
    try {
      localStorage.setItem(
        multiHostEnabledKey(projectId),
        multiHostEnabled ? "true" : "false",
      );
    } catch (error) {
      console.warn("Failed to save the Compare lineup to localStorage:", error);
    }
    saveComparePanes(projectId, storedPanes);
  }, [loadedProject, multiHostEnabled, storedPanes, projectId]);

  const panes = useMemo<readonly RecoveryPane[]>(
    () =>
      loadedProject !== projectId
        ? []
        : storedPanes[0]?.target.kind === "environment"
          ? storedPanes
          : syncLeadPane(storedPanes, previewedHostId),
    [storedPanes, previewedHostId, loadedProject, projectId],
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

  const restorePanes = useCallback(
    (saved: readonly RecoveryPane[]) => {
      setStoredPanes(saved);
      const lead = saved[0] && paneHostId(saved[0]);
      if (lead) setPreviewedHostId(lead);
    },
    [setPreviewedHostId],
  );

  // A pane the lead sync added on read (pane 0 after an outside lead change)
  // is not stored yet, so an edit to it starts from the panes on screen.
  const updatePane = useCallback(
    (paneId: string, patch: Partial<RecoveryPane>) => {
      setStoredPanes((current) =>
        (current.some((pane) => pane.paneId === paneId) ? current : panes).map(
          (pane) => (pane.paneId === paneId ? { ...pane, ...patch } : pane),
        ),
      );
    },
    [panes],
  );
  const setPaneOverrides = useCallback(
    (paneId: string, overrides: PaneOverrides) => updatePane(paneId, overrides),
    [updatePane],
  );
  const setPaneTarget = useCallback(
    (paneId: string, target: ComparePaneTarget) => {
      const next = retargetPane(panes, paneId, target);
      setStoredPanes(next);
      // Pane 0 leads: a client there becomes the previewed client.
      const lead = next[0]?.paneId === paneId ? paneHostId(next[0]) : null;
      if (lead) setPreviewedHostId(lead);
    },
    [panes, setPreviewedHostId],
  );
  const setPanePick = useCallback(
    (paneId: string, pickedSelection: RequestedModelSelection | undefined) =>
      updatePane(paneId, { pickedSelection }),
    [updatePane],
  );

  const setMultiHostEnabled = useCallback((enabled: boolean) => {
    setMultiHostEnabledState(enabled);
  }, []);

  return {
    panes,
    restorePanes,
    setPaneOverrides,
    setPaneTarget,
    setPanePick,
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  };
}
