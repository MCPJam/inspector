import { useCallback, useMemo, useState, type ComponentProps } from "react";
import { useHostedModelCatalog } from "@/hooks/use-hosted-model-catalog";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryRow, formatChatHistoryModelLabel } from "./ChatHistoryRow";
import {
  multiModelLineupLabel,
  type ChatHistoryEntry,
} from "./multi-model-session-rows";

type RowProps = ComponentProps<typeof ChatHistoryRow>;

export interface MultiModelGroupActions {
  rename: (groupId: string, customTitle: string) => Promise<void>;
  pin: (groupId: string) => Promise<void>;
  unpin: (groupId: string) => Promise<void>;
  archive: (groupId: string) => Promise<void>;
  unarchive: (groupId: string) => Promise<void>;
}

function refuseShare(): Promise<void> {
  return Promise.reject(
    new Error("A multi-model session can't be shared to a project."),
  );
}

/**
 * One multi-model session in Sessions: a row for the whole session that
 * reopens every column, and, expanded, a row per column that opens it alone.
 */
export function ChatHistoryGroupRow({
  entry,
  activeSessionId,
  groupActions,
  onSelectGroup,
  onSelectColumn,
  ...rowProps
}: Omit<
  RowProps,
  "session" | "isActive" | "onSelect" | "actions" | "titleOverride" | "labelOverride"
> & {
  entry: Extract<ChatHistoryEntry, { kind: "group" }>;
  activeSessionId: string | null | undefined;
  actions: RowProps["actions"];
  groupActions: MultiModelGroupActions;
  onSelectGroup: (lead: ChatHistorySession) => void;
  onSelectColumn: (column: ChatHistorySession) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { groupId, lead } = entry;
  const { hostedCatalog } = useHostedModelCatalog();
  const hostedNames = useMemo(
    () => new Map(hostedCatalog.map((model) => [String(model.id), model.name])),
    [hostedCatalog],
  );
  const columnLabel = useCallback(
    (column: ChatHistorySession) =>
      formatChatHistoryModelLabel(column, (id) => hostedNames.get(id)),
    [hostedNames],
  );
  const leadActions: RowProps["actions"] = {
    rename: (_sessionId, title) => groupActions.rename(groupId, title),
    pin: () => groupActions.pin(groupId),
    unpin: () => groupActions.unpin(groupId),
    archive: () => groupActions.archive(groupId),
    unarchive: () => groupActions.unarchive(groupId),
    share: refuseShare,
    unshare: refuseShare,
  };

  return (
    <div data-testid="chat-history-multi-model-group">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide columns" : "Show columns"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <ChatHistoryRow
            {...rowProps}
            session={lead}
            isActive={false}
            onSelect={onSelectGroup}
            labelOverride={multiModelLineupLabel(entry, columnLabel)}
            hideShare
            canConvertToTestCase={false}
            archiveLabel="Archive multi-model session"
            actions={leadActions}
          />
        </div>
      </div>
      {expanded ? (
        <div
          className="ml-2.5 border-l border-border pl-1.5"
          data-testid="chat-history-multi-model-columns"
        >
          {entry.columns.map((column) => {
            const removed = column.multiModel?.removedAt !== undefined;
            return (
              <ChatHistoryRow
                key={column._id}
                {...rowProps}
                session={column}
                isActive={column._id === activeSessionId}
                onSelect={onSelectColumn}
                titleOverride={columnLabel(column) ?? "Column"}
                labelOverride={removed ? "Removed" : ""}
                hideShare
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
