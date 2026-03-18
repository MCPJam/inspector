import { useQuery } from "convex/react";

export type SharedChatSourceType = "serverShare" | "sandbox";

export interface SharedChatThread {
  _id: string;
  sourceType: SharedChatSourceType;
  surface?: "internal" | "share_link";
  shareId?: string;
  sandboxId?: string;
  chatSessionId: string;
  serverId?: string;
  userId?: string;
  visitorDisplayName?: string;
  modelId?: string;
  messageCount: number;
  firstMessagePreview?: string;
  startedAt: number;
  lastActivityAt: number;
  messagesBlobUrl?: string;
}

export interface SharedChatWidgetSnapshot {
  _id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  widgetCsp: Record<string, unknown> | null;
  widgetPermissions: Record<string, unknown> | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtmlUrl?: string | null;
}

export function useSharedChatThreadList({
  sourceType,
  sourceId,
}: {
  sourceType: SharedChatSourceType;
  sourceId: string | null;
}) {
  const queryName =
    sourceType === "sandbox"
      ? "chatSessions:listBySandbox"
      : "chatSessions:listByShare";
  const queryArgs =
    sourceType === "sandbox"
      ? sourceId
        ? ({ sandboxId: sourceId, limit: 50 } as any)
        : "skip"
      : sourceId
        ? ({ shareId: sourceId, limit: 50 } as any)
        : "skip";

  const threads = useQuery(queryName as any, queryArgs) as
    | SharedChatThread[]
    | undefined;

  return { threads };
}

export function useSharedChatThread({ threadId }: { threadId: string | null }) {
  const thread = useQuery(
    "chatSessions:getSession" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip",
  ) as SharedChatThread | null | undefined;

  return { thread };
}

export function useSharedChatWidgetSnapshots({
  threadId,
}: {
  threadId: string | null;
}) {
  const snapshots = useQuery(
    "chatSessions:getWidgetSnapshots" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip",
  ) as SharedChatWidgetSnapshot[] | undefined;

  return { snapshots };
}
