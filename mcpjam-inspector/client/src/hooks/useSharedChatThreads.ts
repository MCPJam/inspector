import { useQuery } from "convex/react";

export type SharedChatSourceType = "serverShare" | "sandbox";

export interface SharedChatThread {
  _id: string;
  sourceType: SharedChatSourceType;
  shareId?: string;
  sandboxId?: string;
  chatSessionId: string;
  serverId?: string;
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
      ? "sharedChatThreads:listBySandbox"
      : "sharedChatThreads:listByShare";
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
