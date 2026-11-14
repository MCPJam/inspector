import { useCallback } from "react";
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
  /** Puts the restored record in place; the layout and columns follow it. */
  applyRestore: (record: ComparisonAuthRecovery) => void;
}) {
  const { groupId, projectId, selectedServers, applyRestore } = deps;
  const enabled = useMultiModelSessionsEnabled();
  const positions = useMultiModelPositions(groupId);
  const seed = positions.seed;

  const restore = useCallback(
    ({ record, positions: saved, highestPosition }: MultiModelRestore) => {
      seed(record.id, saved, highestPosition);
      applyRestore(record);
    },
    [applyRestore, seed],
  );

  /**
   * True when the click reopened the whole session. A row passes its Sessions
   * section as `siblings`, where the session finds the rest of its columns.
   */
  const openFromHistory = useCallback(
    async (
      session: ChatHistorySession,
      siblings?: readonly ChatHistorySession[],
    ): Promise<boolean> => {
      if (!enabled || !session.multiModel || !siblings) return false;
      const restored = await fetchMultiModelRestore({
        groupId: session.multiModel.groupId,
        projectId,
        selectedServers,
        loadedSessions: siblings,
      });
      if (!restored) return false;
      restore(restored);
      return true;
    },
    [enabled, projectId, restore, selectedServers],
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
