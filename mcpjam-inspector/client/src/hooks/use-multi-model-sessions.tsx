import { useCallback, useEffect, useRef } from "react";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import {
  fetchMultiModelRestore,
  type MultiModelRestore,
} from "@/lib/multi-model-session-restore";
import { useMultiModelPositions } from "./use-multi-model-positions";
import { useMultiModelSessionsEnabled } from "./useMultiModelSessionsEnabled";

/** The project's servers, as the Playground loads them. */
export interface ServerCatalog {
  serversById: ReadonlyMap<string, string>;
  serversByName: ReadonlyMap<string, string>;
  /** False while sign-in or the project's servers are still loading. */
  loaded: boolean;
  signedIn: boolean;
}

/**
 * The Playground's side of multi-model sessions: each column's position and
 * reopening a session from Sessions.
 */
export function useMultiModelSessions(deps: {
  groupId: string;
  projectId: string;
  selectedServers: string[];
  /** Saved server names or ids are mapped to ids through this catalog. */
  serverCatalog: ServerCatalog;
  /** The keys of the columns on screen; a column that leaves frees its key. */
  liveColumnKeys: readonly string[];
  /** Puts the restored record in place; the layout and columns follow it. */
  applyRestore: (record: ComparisonAuthRecovery) => void;
}) {
  const {
    groupId,
    projectId,
    selectedServers,
    serverCatalog,
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

  const restore = useCallback(
    ({ record, positions: saved, highestPosition }: MultiModelRestore) => {
      seed(record.id, saved, highestPosition);
      applyRestore(record);
    },
    [applyRestore, seed],
  );

  /**
   * "restored" when the click reopened the whole session, "stale" when another
   * selection, a project switch or a sign-in change replaced it while it
   * loaded, and null when the row opens on its own. Waits for the project's
   * servers, so client panes get their saved servers back as ids. A row passes its Sessions section as `siblings`, where the session
   * finds the rest of its columns.
   */
  const openFromHistory = useCallback(
    async (
      session: ChatHistorySession,
      siblings: readonly ChatHistorySession[] | undefined,
      isCurrent: () => boolean,
    ): Promise<"restored" | "stale" | null> => {
      if (!enabled || !session.multiModel || !siblings) return null;
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
      if (!restored) return null;
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
