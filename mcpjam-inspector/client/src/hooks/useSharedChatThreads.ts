import { useQuery } from "convex/react";

export interface SharedChatThread {
  _id: string;
  shareId: string;
  chatSessionId: string;
  serverId: string;
  visitorUserId: string;
  visitorDisplayName: string;
  modelId: string;
  messageCount: number;
  firstMessagePreview: string;
  startedAt: number;
  lastActivityAt: number;
  messagesBlobUrl?: string;
}

export interface SharedChatWidgetSnapshot {
  _id: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  widgetCsp: Record<string, unknown> | null;
  widgetPermissions: Record<string, unknown> | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtmlUrl?: string | null;
}

export function useSharedChatThreadList({
  shareId,
}: {
  shareId: string | null;
}) {
  const threads = useQuery(
    "sharedChatThreads:listByShare" as any,
    shareId ? ({ shareId, limit: 50 } as any) : "skip",
  ) as SharedChatThread[] | undefined;

  return { threads };
}

export function useSharedChatThread({
  threadId,
}: {
  threadId: string | null;
}) {
  const thread = useQuery(
    "sharedChatThreads:getThread" as any,
    threadId ? ({ threadId } as any) : "skip",
  ) as SharedChatThread | null | undefined;

  return { thread };
}

export function useSharedChatWidgetSnapshots({
  threadId,
}: {
  threadId: string | null;
}) {
  const snapshots = useQuery(
    "sharedChatThreads:getWidgetSnapshots" as any,
    threadId ? ({ threadId } as any) : "skip",
  ) as SharedChatWidgetSnapshot[] | undefined;

  return { snapshots };
}
