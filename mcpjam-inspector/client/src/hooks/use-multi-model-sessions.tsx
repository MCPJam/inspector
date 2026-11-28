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
import {
  useMultiModelSessionsDisabled,
  useMultiModelSessionsEnabled,
} from "./useMultiModelSessionsEnabled";
import { track } from "@/lib/analytics";
import { isRebuiltLineup } from "@/lib/multi-model-analytics";

type BranchMessage = Omit<
  Parameters<UseChatSessionReturn["branchFromThread"]>[0],
  "onBeforeBranch"
>;

/** The project's servers, as the Playground loads them. */
export interface ServerCatalog {
  serversById: ReadonlyMap<string, string>;
  serversByName: ReadonlyMap<string, string>;
  /** False while sign-in or the project's servers are still loading. */
  loaded: boolean;
  signedIn: boolean;
}

/**
 * The Playground's side of multi-model sessions: each column's position,
 * reopening a session from Sessions, the notice and new-chat branch for a
 * column opened alone, and marking columns that leave the session.
 */
export function useMultiModelSessions(deps: {
  groupId: string;
  projectId: string;
  selectedServers: string[];
  /** Saved server names or ids are mapped to ids through this catalog. */
  serverCatalog: ServerCatalog;
  /** Whether columns are on screen, and which (`kind:compareId`). */
  compareActive: boolean;
  generation: number;
  liveColumnKeys: readonly string[];
  /**
   * The columns the lineup asks for, ready or not. Removal is read from this,
   * so a client that is briefly unavailable is not saved as removed.
   */
  configuredColumnKeys: readonly string[];
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
  /**
   * The harness the opened column runs on ("Claude Code"), or null. Harnesses
   * keep the conversation on their side and receive only the newest message,
   * so a branch would answer with none of the copied history.
   */
  branchBlockedBy: string | null;
}) {
  const { groupId, projectId, selectedServers, serverCatalog, applyRestore } =
    deps;
  const enabled = useMultiModelSessionsEnabled();
  const disabled = useMultiModelSessionsDisabled();
  const positions = useMultiModelPositions(groupId);
  const { seed, syncLiveColumns } = positions;
  const liveColumns = deps.liveColumnKeys.join("\n");
  useEffect(() => {
    syncLiveColumns(liveColumns ? liveColumns.split("\n") : []);
  }, [liveColumns, syncLiveColumns]);
  // Bumped by every selection, reset, branch, project switch and sign-in
  // change, so an "Open multi-model session" still loading when one happens is
  // dropped instead of applied.
  const openRequest = useRef(0);
  const startedGroups = useRef(new Set<string>());
  const [openedColumn, setOpenedColumn] = useState<ChatHistorySession | null>(
    null,
  );
  const [opening, setOpening] = useState(false);
  const [restored, setRestored] = useState<MultiModelRestore | null>(null);
  const { hostedCatalog } = useHostedModelCatalog();

  // Read after each await, so a load sees the catalog and project as they are
  // now rather than as they were when it started.
  const latest = useRef({ serverCatalog, projectId });
  latest.current = { serverCatalog, projectId };
  const catalogWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (!serverCatalog.loaded) return;
    const waiting = catalogWaiters.current;
    catalogWaiters.current = [];
    for (const resolve of waiting) resolve();
  }, [serverCatalog.loaded]);
  const catalogLoaded = useCallback(
    () =>
      latest.current.serverCatalog.loaded
        ? Promise.resolve()
        : new Promise<void>((resolve) => catalogWaiters.current.push(resolve)),
    [],
  );
  const toServerIds = useCallback((saved: readonly string[]) => {
    const { serversById, serversByName } = latest.current.serverCatalog;
    return saved.flatMap((value) => {
      const id = serversById.has(value) ? value : serversByName.get(value);
      return id ? [id] : [];
    });
  }, []);
  // A project switch or a sign-in change makes a load in flight stale.
  const scope = useCallback(
    () =>
      `${latest.current.projectId}|${latest.current.serverCatalog.signedIn}`,
    [],
  );
  // Each switch is its own invalidation: a project switched away and back
  // reads the same scope again, but the load still belongs to the first visit.
  const signedIn = serverCatalog.signedIn;
  useEffect(() => {
    openRequest.current += 1;
  }, [projectId, signedIn]);

  const restore = useCallback(
    (restoredSession: MultiModelRestore) => {
      const { record, positions: saved, highestPosition } = restoredSession;
      seed(record.id, saved, highestPosition);
      startedGroups.current.add(record.id);
      setOpenedColumn(null);
      setRestored(restoredSession);
      applyRestore(record);
    },
    [applyRestore, seed],
  );

  /**
   * "restored" when the click reopened the whole session, "stale" when another
   * selection, a project switch or a sign-in change replaced it while it
   * loaded, and null when the row opens as a single chat. Waits for the
   * project's servers, so client panes get their saved servers back as ids. A
   * grouped row passes its Sessions section as `siblings`; a column row opened
   * alone does not, and then shows the notice.
   */
  const openFromHistory = useCallback(
    async (
      session: ChatHistorySession,
      siblings: readonly ChatHistorySession[] | undefined,
      isCurrent: () => boolean,
    ): Promise<"restored" | "stale" | null> => {
      openRequest.current += 1;
      if (!session.multiModel) {
        setOpenedColumn(null);
        return null;
      }
      // Kept while the flag is still loading (a column reopened by its link on
      // a cold load); the notice and branching read the flag when it lands.
      if (!siblings) {
        setOpenedColumn(session);
        return null;
      }
      if (!enabled) {
        setOpenedColumn(null);
        return null;
      }
      const startedIn = scope();
      await catalogLoaded();
      const restored = await fetchMultiModelRestore({
        groupId: session.multiModel.groupId,
        projectId,
        selectedServers,
        loadedSessions: siblings,
        toServerIds,
      });
      if (!isCurrent() || scope() !== startedIn) return "stale";
      if (!restored) {
        setOpenedColumn(null);
        return null;
      }
      restore(restored);
      return "restored";
    },
    [
      enabled,
      projectId,
      restore,
      selectedServers,
      catalogLoaded,
      scope,
      toServerIds,
    ],
  );

  const openSessionFromColumn = useCallback(async () => {
    const groupOfColumn = openedColumn?.multiModel?.groupId;
    if (!openedColumn || !groupOfColumn) return;
    const request = ++openRequest.current;
    const startedIn = scope();
    setOpening(true);
    try {
      await catalogLoaded();
      const restored = await fetchMultiModelRestore({
        groupId: groupOfColumn,
        projectId,
        selectedServers,
        loadedSessions: [openedColumn],
        toServerIds,
      });
      if (request !== openRequest.current || scope() !== startedIn) return;
      if (restored) restore(restored);
      else
        toast.error(
          "Couldn't open the multi-model session. Its other columns may be archived; open them from Sessions.",
        );
    } finally {
      setOpening(false);
    }
  }, [
    catalogLoaded,
    openedColumn,
    projectId,
    restore,
    scope,
    selectedServers,
    toServerIds,
  ]);

  const { branchFromThread, detachForBranch, showSingleChat } = deps;
  const sendInColumn = useCallback(
    async (message: BranchMessage): Promise<boolean> => {
      if (!openedColumn) return false;
      if (deps.branchBlockedBy) {
        toast.error(
          `${deps.branchBlockedBy} can't continue a saved column in a new chat. Open the multi-model session to keep chatting.`,
        );
        return false;
      }
      openRequest.current += 1;
      const column = openedColumn;
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
      // A column opened while this one branched stays open.
      setOpenedColumn((current) => (current === column ? null : current));
      toast.success(multiModelBranchToast(label), { position: "bottom-right" });
      return true;
    },
    [
      branchFromThread,
      deps.branchBlockedBy,
      detachForBranch,
      hostedCatalog,
      openedColumn,
      showSingleChat,
    ],
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
              id: `${column.kind}:${column.compareId}`,
              label:
                formatChatHistoryModelLabel(
                  session,
                  (id) =>
                    hostedCatalog.find((model) => String(model.id) === id)
                      ?.name,
                ) ?? "This",
              reason:
                column.kind === "model"
                  ? ("model" as const)
                  : ("client" as const),
              open: () => deps.openColumnAlone(session),
            },
          ];
        })
      : [];

  const liveColumnKeysRef = useRef(deps.liveColumnKeys);
  liveColumnKeysRef.current = deps.liveColumnKeys;
  // Not behind the flag: the product metric needs a baseline before launch.
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;
  const trackStarted = useCallback((prompt: string) => {
    // Once per session: every broadcast reports here, and a reopened session
    // was already started.
    if (startedGroups.current.has(groupIdRef.current)) return;
    startedGroups.current.add(groupIdRef.current);
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
    /**
     * Set while a column is open alone: sends go to a new branch instead.
     * Also while the flag is still loading, so an early send can't write into
     * the saved column.
     */
    sendInColumn: !disabled && openedColumn ? sendInColumn : null,
    clearOpenedColumn: useCallback(() => {
      openRequest.current += 1;
      setOpenedColumn(null);
      setRestored(null);
    }, []),
    /** Call on every broadcast; reports a session's first one. */
    trackStarted,
  };
}

/**
 * A column that leaves the lineup while compare stays on (removed, or replaced
 * by a new effort or model) is marked removed, so reopening the session does
 * not bring it back. Turning compare off or starting a new chat removes
 * nothing, and neither does a client that is only briefly unavailable.
 */
function useMarkRemovedColumns(args: {
  enabled: boolean;
  groupId: string;
  compareActive: boolean;
  generation: number;
  configuredColumnKeys: readonly string[];
}) {
  const previous = useRef<{
    groupId: string;
    generation: number;
    active: boolean;
    keys: readonly string[];
    sessions: Map<string, string>;
  } | null>(null);
  const { enabled, groupId, compareActive, generation, configuredColumnKeys } =
    args;
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
        if (configuredColumnKeys.includes(key)) continue;
        const chatSessionId = before.sessions.get(key);
        if (!chatSessionId) continue;
        markMultiModelColumnRemoved(chatSessionId).catch((error: unknown) => {
          // The column still restores until this lands; the next removal or
          // reopen shows it, which is safer than blocking the lineup change.
          console.warn("[multi-model] could not mark a column removed", error);
        });
      }
    }
    // A column that unmounts while it stays in the lineup (its client went
    // unavailable) keeps its saved chat here, so a later removal still marks it.
    const sessions = new Map(
      before && before.groupId === groupId && before.generation === generation
        ? [...before.sessions].filter(([key]) =>
            configuredColumnKeys.includes(key),
          )
        : [],
    );
    for (const [key, chatSessionId] of comparisonColumnSessions(groupId))
      sessions.set(key, chatSessionId);
    previous.current = {
      groupId,
      generation,
      active: compareActive,
      keys: [...configuredColumnKeys],
      sessions,
    };
  });
}
