import { useCallback, useEffect } from "react";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import {
  fetchMultiModelRestore,
  type MultiModelRestore,
} from "@/lib/multi-model-session-restore";
import { useMultiModelPositions } from "./use-multi-model-positions";
import { useMultiModelSessionsEnabled } from "./useMultiModelSessionsEnabled";

/**
 * The Playground's side of multi-model sessions: each column's position and
 * reopening a session from Sessions.
 */
export function useMultiModelSessions(deps: {
  groupId: string;
  projectId: string;
  selectedServers: string[];
  /** Maps saved server names or ids to the project's server ids. */
  toServerIds: (saved: readonly string[]) => string[];
  /** The keys of the columns on screen; a column that leaves frees its key. */
  liveColumnKeys: readonly string[];
  /** Puts the restored record in place; the layout and columns follow it. */
  applyRestore: (record: ComparisonAuthRecovery) => void;
}) {
  const {
    groupId,
    projectId,
    selectedServers,
    toServerIds,
    liveColumnKeys,
    applyRestore,
  } = deps;
  const enabled = useMultiModelSessionsEnabled();
  const positions = useMultiModelPositions(groupId);
  const { seed, syncLiveColumns } = positions;
  const liveColumns = liveColumnKeys.join("\n");
  useEffect(() => {
    syncLiveColumns(liveColumns ? liveColumns.split("\n") : []);
  }, [liveColumns, syncLiveColumns]);

  const restore = useCallback(
    ({ record, positions: saved, highestPosition }: MultiModelRestore) => {
      seed(record.id, saved, highestPosition);
      applyRestore(record);
    },
    [applyRestore, seed],
  );

  /**
   * "restored" when the click reopened the whole session, "stale" when another
   * selection replaced it while it loaded, and null when the row opens on its
   * own. A row passes its Sessions section as `siblings`, where the session
   * finds the rest of its columns.
   */
  const openFromHistory = useCallback(
    async (
      session: ChatHistorySession,
      siblings: readonly ChatHistorySession[] | undefined,
      isCurrent: () => boolean,
    ): Promise<"restored" | "stale" | null> => {
      if (!enabled || !session.multiModel || !siblings) return null;
      const restored = await fetchMultiModelRestore({
        groupId: session.multiModel.groupId,
        projectId,
        selectedServers,
        loadedSessions: siblings,
        toServerIds,
      });
      if (!isCurrent()) return "stale";
      if (!restored) return null;
      restore(restored);
      return "restored";
    },
    [enabled, projectId, restore, selectedServers, toServerIds],
  );

  return {
    /**
     * A column's position, or undefined while the flag is off: with no
     * position a column saves no group, so nothing is grouped until launch.
     */
    positionFor: (columnKey: string) =>
      enabled ? positions.positionFor(columnKey) : undefined,
    openFromHistory,
  };
}
