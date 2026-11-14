import {
  comparisonKey,
  isModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import {
  getMultiModelSessionGroup,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";
import type { RecoveryPane } from "./comparison-recovery-record";
import {
  readRecoveryRecord,
  type ComparisonAuthRecovery,
} from "./comparison-recovery-record";

/** The live columns of a multi-model session, in the order they were added. */
export function multiModelSessionColumns(
  groupId: string,
  sessions: readonly ChatHistorySession[],
): ChatHistorySession[] {
  return sessions
    .filter(
      (session) =>
        session.multiModel?.groupId === groupId &&
        session.multiModel.removedAt === undefined,
    )
    .sort(
      (a, b) => (a.multiModel?.position ?? 0) - (b.multiModel?.position ?? 0),
    );
}

export interface MultiModelRestore {
  record: ComparisonAuthRecovery;
  /** Each restored column's saved position, keyed as the Playground keys columns. */
  positions: { columnKey: string; position: number }[];
  /** The highest position the session ever used, removed columns included. */
  highestPosition: number;
  /** Each restored column's saved chat, in the record's column order. */
  columnSessions: ChatHistorySession[];
}

function modelColumns(columns: readonly ChatHistorySession[]) {
  const selections = columns
    .map((column) => column.modelSelection)
    .filter((selection): selection is RequestedModelSelection => !!selection);
  if (selections.length !== columns.length) return null;
  // A restored lineup is keyed by its selections, which is how the compare
  // cards key it, so each column is matched to its card the same way.
  const compareIds = selections.map((selection) => comparisonKey(selection));
  return {
    layout: {
      multiModelEnabled: true,
      hostIds: [],
      modelSelections: selections,
      panes: [] as RecoveryPane[],
    },
    compareIds,
    columnKeys: compareIds.map((id) => `model:${id}`),
  };
}

function hostColumns(columns: readonly ChatHistorySession[]) {
  const panes: RecoveryPane[] = [];
  for (const column of columns) {
    const paneId = column.multiModel?.compareId;
    const target = column.hostId
      ? { kind: "host" as const, hostId: column.hostId }
      : column.environmentId
        ? { kind: "environment" as const, environmentId: column.environmentId }
        : null;
    if (!paneId || !target) return null;
    panes.push({
      paneId,
      target,
      ...(isModelSelection(column.modelSelection)
        ? { pickedSelection: column.modelSelection }
        : {}),
    });
  }
  return {
    layout: {
      multiModelEnabled: false,
      hostIds: panes.flatMap((pane) =>
        pane.target.kind === "host" ? [pane.target.hostId] : [],
      ),
      modelSelections: null,
      panes,
    },
    compareIds: panes.map((pane) => pane.paneId),
    columnKeys: panes.map((pane) => `host:${pane.paneId}`),
  };
}

/**
 * Builds the record the sign-in recovery path already restores from, so a
 * multi-model session reopens through that path instead of a second one.
 * `sessions` is every saved column of the group, removed ones included.
 * Returns null when the saved columns cannot be restored together.
 */
export function buildMultiModelRestore(args: {
  groupId: string;
  projectId: string;
  sessions: readonly ChatHistorySession[];
  selectedServers: string[];
}): MultiModelRestore | null {
  const columns = multiModelSessionColumns(args.groupId, args.sessions);
  if (columns.length < 2) return null;
  const kinds = new Set(columns.map((column) => column.multiModel?.columnKind));
  if (kinds.size !== 1) return null;
  const built = kinds.has("model")
    ? modelColumns(columns)
    : hostColumns(columns);
  if (!built) return null;
  const kind = kinds.has("model") ? ("model" as const) : ("host" as const);
  const record = {
    version: 2 as const,
    id: args.groupId,
    projectId: args.projectId,
    createdAt: Date.now(),
    ...built.layout,
    selectedServers: args.selectedServers,
    columns: columns.map((column, order) => ({
      compareId: built.compareIds[order],
      kind,
      order,
      chatSessionId: column.chatSessionId,
      hasMessages: column.messageCount > 0,
    })),
    continuationId: args.groupId,
    clickedColumn: built.compareIds[0],
  };
  const parsed = readRecoveryRecord(JSON.stringify(record), {
    id: args.groupId,
    projectId: args.projectId,
  });
  if (!parsed) return null;
  const highestPosition = Math.max(
    ...args.sessions
      .filter((session) => session.multiModel?.groupId === args.groupId)
      .map((session) => session.multiModel?.position ?? 0),
  );
  return {
    record: parsed,
    positions: columns.map((column, index) => ({
      columnKey: built.columnKeys[index],
      position: column.multiModel?.position ?? index,
    })),
    highestPosition,
    columnSessions: columns,
  };
}

/**
 * Reads every saved column of the group, so a column that is not in the loaded
 * Sessions list (removed, or below the first page) still counts. When the read
 * fails, the columns the list already has are the best available answer.
 */
export async function fetchMultiModelRestore(args: {
  groupId: string;
  projectId: string;
  selectedServers: string[];
  loadedSessions: readonly ChatHistorySession[];
}): Promise<MultiModelRestore | null> {
  let sessions: readonly ChatHistorySession[] = args.loadedSessions;
  try {
    const group = await getMultiModelSessionGroup({
      groupId: args.groupId,
      projectId: args.projectId === "local" ? undefined : args.projectId,
    });
    if (group.sessions.length > 0) sessions = group.sessions;
  } catch (error) {
    // The loaded list still holds the columns the person can see; restoring
    // from it beats refusing to reopen the session.
    console.warn("[multi-model] group read failed, using loaded rows", error);
  }
  return buildMultiModelRestore({ ...args, sessions });
}
