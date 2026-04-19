import { useQuery } from "convex/react";

export type SharedChatSourceType = "serverShare" | "chatbox";

export interface SharedChatThread {
  _id: string;
  sourceType: SharedChatSourceType;
  surface?: "preview" | "share_link";
  shareId?: string;
  chatboxId?: string;
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
  /** Set when chatbox feedback was recorded for this session. */
  feedbackRating?: number | null;
  feedbackComment?: string | null;
  feedbackCount?: number;
  toolCallCount?: number;
  /** OAuth or permission flow interrupted the session. */
  authInterrupted?: boolean;
  // Sandbox usage-insights fields (populated only for sandbox sessions).
  themeClusterId?: string;
  themeClusterLabel?: string;
  themeKeywords?: string[];
  geoCountry?: string;
  geoRegion?: string;
  geoCity?: string;
  deviceKind?: "desktop" | "mobile" | "tablet" | "bot";
  userAgentFamily?: string;
  authType?: "signedIn" | "guest";
  visitorRecency?: "new" | "returning";
  visitorSegment?: string;
  language?: string;
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
    sourceType === "chatbox"
      ? "chatSessions:listByChatbox"
      : "chatSessions:listByShare";
  const queryArgs =
    sourceType === "chatbox"
      ? sourceId
        ? ({ chatboxId: sourceId, limit: 50, includeInternal: true } as any)
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

export interface SharedChatTurnTrace {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  spanCount: number;
  modelId?: string;
  spansBlobUrl?: string | null;
}

export function useSharedChatTurnTraces({
  threadId,
}: {
  threadId: string | null;
}) {
  const traces = useQuery(
    "chatSessions:getSessionTurnTraces" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip",
  ) as SharedChatTurnTrace[] | undefined;

  return { traces };
}
