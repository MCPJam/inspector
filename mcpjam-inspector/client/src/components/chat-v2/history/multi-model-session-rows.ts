import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

export type ChatHistoryEntry =
  | { kind: "session"; session: ChatHistorySession }
  | {
      kind: "group";
      groupId: string;
      /** Shown for the group: the lowest-position column still in it. */
      lead: ChatHistorySession;
      /** Every saved column in position order, removed ones last. */
      columns: ChatHistorySession[];
      columnKind: "model" | "host";
    };

/**
 * Folds the columns of each multi-model session into one entry, placed where
 * its most recent column sat on the page. `sessions` may add columns from
 * outside the page; they join their group but never become rows themselves.
 * A group with a single saved column stays a plain row: there is nothing to
 * restore side by side.
 */
export function foldMultiModelSessions(
  sessions: readonly ChatHistorySession[],
  pageRows: readonly ChatHistorySession[] = sessions,
): ChatHistoryEntry[] {
  const byGroup = new Map<string, ChatHistorySession[]>();
  const seen = new Set<string>();
  for (const session of sessions) {
    const groupId = session.multiModel?.groupId;
    if (!groupId || seen.has(session._id)) continue;
    seen.add(session._id);
    byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), session]);
  }
  const entries: ChatHistoryEntry[] = [];
  const placed = new Set<string>();
  for (const session of pageRows) {
    const groupId = session.multiModel?.groupId;
    const members = groupId ? byGroup.get(groupId) : undefined;
    if (!groupId || !members || members.length < 2) {
      entries.push({ kind: "session", session });
      continue;
    }
    if (placed.has(groupId)) continue;
    placed.add(groupId);
    const columns = [...members].sort(
      (a, b) =>
        Number(a.multiModel?.removedAt !== undefined) -
          Number(b.multiModel?.removedAt !== undefined) ||
        (a.multiModel?.position ?? 0) - (b.multiModel?.position ?? 0),
    );
    const lead =
      columns.find((column) => column.multiModel?.removedAt === undefined) ??
      columns[0];
    entries.push({
      kind: "group",
      groupId,
      lead,
      columns,
      columnKind: lead.multiModel?.columnKind ?? "model",
    });
  }
  return entries;
}

/** "3 models · Claude Haiku 5.5, Nova Micro, GPT-6 Luna" */
export function multiModelLineupLabel(
  entry: Extract<ChatHistoryEntry, { kind: "group" }>,
  columnLabel: (session: ChatHistorySession) => string | null,
): string {
  const live = entry.columns.filter(
    (column) => column.multiModel?.removedAt === undefined,
  );
  const noun = entry.columnKind === "host" ? "clients" : "models";
  const names = live
    .map(columnLabel)
    .filter((name): name is string => !!name)
    .join(", ");
  return names ? `${live.length} ${noun} · ${names}` : `${live.length} ${noun}`;
}
