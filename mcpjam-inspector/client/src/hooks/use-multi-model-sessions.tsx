import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  markMultiModelColumnRemoved,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import { comparisonColumnSessions } from "@/lib/comparison-auth-recovery";
import {
  fetchMultiModelRestore,
  type MultiModelRestore,
} from "@/lib/multi-model-session-restore";
import { formatChatHistoryModelLabel } from "@/components/chat-v2/history/ChatHistoryRow";
import {
  MultiModelColumnNotice,
  MultiModelMissingColumnsNotice,
  multiModelBranchToast,
} from "@/components/ui-playground/multi-model-column-notice";
import type { UseChatSessionReturn } from "./use-chat-session";
import { useMultiModelPositions } from "./use-multi-model-positions";
import { useHostedModelCatalog } from "./use-hosted-model-catalog";
import { useMultiModelSessionsEnabled } from "./useMultiModelSessionsEnabled";
import { track } from "@/lib/analytics";
import { isRebuiltLineup } from "@/lib/multi-model-analytics";

type BranchMessage = Omit<
  Parameters<UseChatSessionReturn["branchFromThread"]>[0],
  "onBeforeBranch"
>;

/**
 * The Playground's side of multi-model sessions: each column's position,
 * reopening a session from Sessions, the notice and new-chat branch for a
 * column opened alone, and marking columns that leave the session.
 */
export function useMultiModelSessions(deps: {
  groupId: string;
  projectId: string;
  selectedServers: string[];
  /** Whether columns are on screen, and which (`kind:compareId`). */
  compareActive: boolean;
  generation: number;
  liveColumnKeys: readonly string[];
  /** Puts the restored record in place; the layout and columns follow it. */
  applyRestore: (record: ComparisonAuthRecovery) => void;
  branchFromThread: UseChatSessionReturn["branchFromThread"];
  /** Detaches from the opened column as the branch is minted. */
  detachForBranch: () => void;
  /**
   * Turns compare off so the branch shows as one chat: once the history view
   * is detached, a lineup left on would cover it with empty columns.
   */
  showSingleChat: (column: ChatHistorySession) => void;
  /** Client columns whose client could not be resolved (`compareId`s). */
  unavailableHostIds: readonly string[];
  /** The model list has loaded, so a model that is missing is really gone. */
  modelsReady: boolean;
  /** Opens one saved column as a single chat, as its row in Sessions does. */
  openColumnAlone: (column: ChatHistorySession) => void;
}) {
  const { groupId, projectId, selectedServers, applyRestore } = deps;
  const enabled = useMultiModelSessionsEnabled();
  const positions = useMultiModelPositions(groupId);
  const seed = positions.seed;
  const [openedColumn, setOpenedColumn] = useState<ChatHistorySession | null>(
    null,
  );
  const [opening, setOpening] = useState(false);
  const [restored, setRestored] = useState<MultiModelRestore | null>(null);
  const { hostedCatalog } = useHostedModelCatalog();

  const restore = useCallback(
    (restoredSession: MultiModelRestore) => {
      const { record, positions: saved, highestPosition } = restoredSession;
      seed(record.id, saved, highestPosition);
      setOpenedColumn(null);
      setRestored(restoredSession);
      applyRestore(record);
    },
    [applyRestore, seed],
  );

  /**
   * True when the click reopened the whole session. A grouped row passes its
   * Sessions section as `siblings`; a column row opened alone does not, and
   * then opens as a single chat with the notice.
   */
  const openFromHistory = useCallback(
    async (
      session: ChatHistorySession,
      siblings?: readonly ChatHistorySession[],
    ): Promise<boolean> => {
      if (!enabled || !session.multiModel) {
        setOpenedColumn(null);
        return false;
      }
      if (!siblings) {
        setOpenedColumn(session);
        return false;
      }
      const restored = await fetchMultiModelRestore({
        groupId: session.multiModel.groupId,
        projectId,
        selectedServers,
        loadedSessions: siblings,
      });
      if (!restored) {
        setOpenedColumn(null);
        return false;
      }
      restore(restored);
      return true;
    },
    [enabled, projectId, restore, selectedServers],
  );

  const openSessionFromColumn = useCallback(async () => {
    const groupOfColumn = openedColumn?.multiModel?.groupId;
    if (!openedColumn || !groupOfColumn) return;
    setOpening(true);
    try {
      const restored = await fetchMultiModelRestore({
        groupId: groupOfColumn,
        projectId,
        selectedServers,
        loadedSessions: [openedColumn],
      });
      if (restored) restore(restored);
      else
        toast.error(
          "Couldn't open the multi-model session. Its other columns may be archived; open them from Sessions.",
        );
    } finally {
      setOpening(false);
    }
  }, [openedColumn, projectId, restore, selectedServers]);

  const { branchFromThread, detachForBranch, showSingleChat } = deps;
  const sendInColumn = useCallback(
    async (message: BranchMessage): Promise<boolean> => {
      if (!openedColumn) return false;
      const label = formatChatHistoryModelLabel(
        openedColumn,
        (id) => hostedCatalog.find((model) => String(model.id) === id)?.name,
      );
      const outcome = await branchFromThread({
        ...message,
        onBeforeBranch: () => {
          showSingleChat(openedColumn);
          detachForBranch();
        },
      });
      if (!outcome) return false;
      setOpenedColumn(null);
      toast.success(multiModelBranchToast(label), { position: "bottom-right" });
      return true;
    },
    [branchFromThread, detachForBranch, hostedCatalog, openedColumn, showSingleChat],
  );

  useMarkRemovedColumns({ ...deps, enabled });

  // A restored session stays "restored" until its group is left behind.
  const restoredGroupId = restored?.record.id;
  const restoredIsLive = restoredGroupId === groupId && deps.compareActive;
  const missingColumns =
    enabled && restored && restoredIsLive
      ? restored.record.columns.flatMap((column, index) => {
          const session = restored.columnSessions[index];
          const missing =
            column.kind === "model"
              ? deps.modelsReady &&
                !deps.liveColumnKeys.includes(`model:${column.compareId}`)
              : deps.unavailableHostIds.includes(column.compareId);
          if (!missing || !session) return [];
          return [
            {
              label:
                formatChatHistoryModelLabel(
                  session,
                  (id) =>
                    hostedCatalog.find((model) => String(model.id) === id)?.name,
                ) ?? "This",
              reason: column.kind === "model" ? ("model" as const) : ("client" as const),
              open: () => deps.openColumnAlone(session),
            },
          ];
        })
      : [];

  const liveColumnKeysRef = useRef(deps.liveColumnKeys);
  liveColumnKeysRef.current = deps.liveColumnKeys;
  // Not behind the flag: the product metric needs a baseline before launch.
  const trackStarted = useCallback((prompt: string) => {
    const keys = liveColumnKeysRef.current;
    track("playground_multi_model_started", {
      location: "playground",
      column_count: keys.length,
      column_kind: keys.some((key) => key.startsWith("host:"))
        ? "host"
        : "model",
      rebuilt: isRebuiltLineup(prompt, Date.now()),
    });
  }, []);

  return {
    /**
     * A column's position, or undefined while the flag is off: with no
     * position a column saves no group, so nothing is grouped until launch.
     */
    positionFor: (columnKey: string) =>
      enabled ? positions.positionFor(columnKey) : undefined,
    openFromHistory,
    notice:
      enabled && openedColumn ? (
        <MultiModelColumnNotice
          opening={opening}
          onOpenSession={() => void openSessionFromColumn()}
        />
      ) : missingColumns.length > 0 ? (
        <MultiModelMissingColumnsNotice columns={missingColumns} />
      ) : null,
    /** Set while a column is open alone: sends go to a new branch instead. */
    sendInColumn: enabled && openedColumn ? sendInColumn : null,
    clearOpenedColumn: useCallback(() => {
      setOpenedColumn(null);
      setRestored(null);
    }, []),
    /** Call on a multi-model session's first send. */
    trackStarted,
  };
}

/**
 * A column that disappears while compare stays on (removed, or replaced by a
 * new effort or model) is marked removed, so reopening the session does not
 * bring it back. Turning compare off or starting a new chat removes nothing.
 */
function useMarkRemovedColumns(args: {
  enabled: boolean;
  groupId: string;
  compareActive: boolean;
  generation: number;
  liveColumnKeys: readonly string[];
}) {
  const previous = useRef<{
    groupId: string;
    generation: number;
    active: boolean;
    keys: readonly string[];
    sessions: Map<string, string>;
  } | null>(null);
  const { enabled, groupId, compareActive, generation, liveColumnKeys } = args;
  useEffect(() => {
    const before = previous.current;
    if (
      enabled &&
      before &&
      before.active &&
      compareActive &&
      before.groupId === groupId &&
      before.generation === generation
    ) {
      for (const key of before.keys) {
        if (liveColumnKeys.includes(key)) continue;
        const chatSessionId = before.sessions.get(key);
        if (!chatSessionId) continue;
        markMultiModelColumnRemoved(chatSessionId).catch((error: unknown) => {
          // The column still restores until this lands; the next removal or
          // reopen shows it, which is safer than blocking the lineup change.
          console.warn("[multi-model] could not mark a column removed", error);
        });
      }
    }
    previous.current = {
      groupId,
      generation,
      active: compareActive,
      keys: [...liveColumnKeys],
      sessions: comparisonColumnSessions(groupId),
    };
  });
}
