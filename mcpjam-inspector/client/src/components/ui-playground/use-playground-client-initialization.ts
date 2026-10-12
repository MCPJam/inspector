import type { RefObject } from "react";
import {
  useHostMutations,
  type EnsureProjectClientResult,
  type HostListItem,
} from "@/hooks/useClients";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import { useProjectClientInitialization } from "@/hooks/use-project-client-initialization";
import {
  loadSelectedHostIds,
  saveSelectedHostIds,
} from "@/lib/selected-host-storage";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "@/lib/previewed-client-storage";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

type Selection = { previewed: string | null; selected: string[] };

function readSelection(projectId: string): Selection {
  return {
    previewed: loadPreviewedHostId(projectId),
    selected: loadSelectedHostIds(projectId),
  };
}

/**
 * Applies a selection this flow chose, unless the user chose something else
 * while the request was out. A lead now on one of `ownHostIds` is this flow's
 * own write (the missing-preview fallback picking the default as it arrived),
 * not a user choice, so it does not veto the selection.
 *
 * Saved to the request's project even after a switch, so returning to it
 * shows the lineup; live state only changes while that project is open.
 */
function applySelection(
  projectId: string,
  before: Selection,
  next: { lead: string; lineup: string[]; ownHostIds: string[] },
  live: PlaygroundSelectionTarget,
) {
  const now = readSelection(projectId);
  const leadIsOurs =
    now.previewed !== null && next.ownHostIds.includes(now.previewed);
  const changed =
    (!leadIsOurs && now.previewed !== before.previewed) ||
    now.selected.length !== before.selected.length ||
    now.selected.some((id, index) => id !== before.selected[index]);
  if (changed) return;
  const isActive = live.activeProjectIdRef.current === projectId;
  if (isActive && live.restoringAdhocRef.current) return;
  savePreviewedHostId(projectId, next.lead);
  saveSelectedHostIds(projectId, next.lineup);
  if (!isActive) return;
  live.setPreviewedHostId(next.lead);
  live.setSelectedHostIds(next.lineup);
}

export type PlaygroundSelectionTarget = {
  activeProjectIdRef: RefObject<string | null>;
  restoringAdhocRef: RefObject<boolean>;
  setPreviewedHostId: (hostId: string) => void;
  setSelectedHostIds: (hostIds: string[]) => void;
};

/**
 * The Playground's first clients, through the backend's one contract.
 *
 * Any role repairs a missing default. A resolved admin then asks the backend
 * to settle the first-run comparison lineup, which it creates at most once per
 * project; only the call that created it selects it (Claude leading), so a
 * later visit never resets a lineup the user has since changed. A recorded
 * ad-hoc conversation being restored keeps its explicit "no named client".
 */
export function usePlaygroundClientInitialization({
  isAuthenticated,
  projectId,
  hostList,
  hostListLoading,
  restoringAdhoc,
  live,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
  hostList: HostListItem[];
  hostListLoading: boolean;
  restoringAdhoc: boolean;
  live: PlaygroundSelectionTarget;
}) {
  const { ensureProjectClient } = useHostMutations();
  const { canManage, isLoading: roleLoading } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const ready =
    isAuthenticated && !!projectId && !hostListLoading && !restoringAdhoc;

  const withSelection =
    (initializeComparison: boolean) =>
    async (
      pid: string,
    ): Promise<{
      projectId: string;
      before: Selection;
      result: EnsureProjectClientResult;
    }> => {
      const before = readSelection(pid);
      const result = await ensureProjectClient({
        projectId: pid,
        themeMode,
        ...(initializeComparison ? { initializeComparison } : {}),
      });
      // An empty answer is not a success: it goes through the failure path.
      if (typeof result?.hostId !== "string") {
        throw new Error("ensureProjectClient returned no client");
      }
      return { projectId: pid, before, result };
    };

  const defaultInit = useProjectClientInitialization({
    projectId,
    intent: "default",
    needed: ready && hostList.length === 0,
    run: withSelection(false),
    // A fresh default replaces any lineup of deleted clients.
    onSuccess: ({ projectId: pid, before, result }) => {
      if (!result.created) return;
      const own = [result.hostId];
      applySelection(
        pid,
        before,
        { lead: result.hostId, lineup: own, ownHostIds: own },
        live,
      );
    },
  });

  const comparisonInit = useProjectClientInitialization({
    projectId,
    intent: "comparison",
    needed: ready && hostList.length > 0 && !roleLoading && canManage,
    run: withSelection(true),
    onSuccess: ({ projectId: pid, before, result }) => {
      const comparison = result.comparison;
      if (!comparison?.created || comparison.hostIds.length === 0) return;
      applySelection(
        pid,
        before,
        {
          lead: comparison.hostIds[0],
          lineup: comparison.hostIds,
          ownHostIds: [result.hostId, ...comparison.hostIds],
        },
        live,
      );
    },
  });
  return { defaultInit, comparisonInit };
}
