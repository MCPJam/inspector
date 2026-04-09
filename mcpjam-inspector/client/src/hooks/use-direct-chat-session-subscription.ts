import { useQuery } from "convex/react";
import type {
  ChatHistoryDetailSession,
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

  return { session, widgetSnapshots };
}
