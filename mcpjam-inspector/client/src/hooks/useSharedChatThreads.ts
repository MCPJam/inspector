import { useQuery } from "convex/react";

export type SharedChatSourceType = "chatbox";

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
  deviceKind?: "desktop" | "mobile" | "tablet" | "bot";
  userAgentFamily?: string;
  authType?: "signedIn" | "guest";
  visitorRecency?: "new" | "returning";
  visitorSegment?: string;
  language?: string;
  /**
   * The hostConfigId that was active on the chatbox's referenced host
   * when this session opened. Pinned at session-insert time; survives
   * host edits forward so the UI can show "this session ran against
   * config rev #N". Use `useSessionHistoricalHostConfig` to resolve it
   * to model / server / etc.
   */
  hostConfigIdAtStart?: string;
}

/**
 * The pinned historical hostConfig a session was opened against — the
 * shape the chip / "view config" deep-link reads from. Backend resolves
 * `chatSessions.hostConfigIdAtStart` through the (append-only)
 * hostConfigs table, so even after the host has rotated forward the
 * row this points at is still readable.
 */
export interface SessionHistoricalHostConfig {
  hostConfigId: string;
  hostStyle: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  serverIds: string[];
  optionalServerIds: string[];
  serverCount: number;
  /** Name of the host the chatbox *currently* references, if any. */
  currentHostName: string | null;
}

export function useSessionHistoricalHostConfig({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const config = useQuery(
    "chatSessions:getSessionHistoricalHostConfig" as any,
    sessionId ? ({ sessionId } as any) : "skip",
  ) as SessionHistoricalHostConfig | null | undefined;

  return { config };
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
  sourceId,
}: {
  sourceType?: SharedChatSourceType;
  sourceId: string | null;
}) {
  const queryArgs = sourceId
    ? ({ chatboxId: sourceId, limit: 50, includeInternal: true } as any)
    : "skip";

  const threads = useQuery(
    "chatSessions:listByChatbox" as any,
    queryArgs,
  ) as SharedChatThread[] | undefined;

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
