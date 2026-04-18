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

  // Note: turnTraces are intentionally NOT subscribed here. They're fetched
  // once per thread via the REST /chat-history/detail seed path and retained
  // in liveTraceState for the lifetime of the session. On a reactive refresh
  // we pass `undefined` for turnTraces to loadChatSession, which treats it as
  // "preserve existing trace state" rather than wiping it. This keeps the
  // component safe to render when the paired backend function isn't deployed.
  return { session, widgetSnapshots };
}
