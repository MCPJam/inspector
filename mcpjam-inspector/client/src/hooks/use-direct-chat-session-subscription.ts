import { useQuery } from "convex/react";
import type {
  ChatHistoryDetailSession,
  ChatHistoryTurnTrace,
  ChatHistoryWidgetSnapshot,
} from "@/lib/apis/web/chat-history-api";

export function useDirectChatSessionSubscription({
  sessionId,
  workspaceId,
  enabled,
}: {
  sessionId: string | null;
  workspaceId: string | null;
  enabled: boolean;
}) {
  const session = useQuery(
    "directChatHistory:getCurrentSession" as any,
    enabled && sessionId
      ? ({
          sessionId,
          workspaceId: workspaceId ?? undefined,
        } as const)
      : "skip",
  ) as ChatHistoryDetailSession | null | undefined;

  const widgetSnapshots = useQuery(
    "directChatHistory:getCurrentSessionWidgetSnapshots" as any,
    enabled && sessionId ? ({ sessionId } as const) : "skip",
  ) as ChatHistoryWidgetSnapshot[] | undefined;

  const turnTraces = useQuery(
    "directChatHistory:getCurrentSessionTurnTraces" as any,
    enabled && sessionId ? ({ sessionId } as const) : "skip",
  ) as ChatHistoryTurnTrace[] | undefined;

  return { session, widgetSnapshots, turnTraces };
}
