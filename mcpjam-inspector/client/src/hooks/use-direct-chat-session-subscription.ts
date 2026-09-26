import { useArtifactQuery } from "@/lib/artifact-urls";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type {
  ChatHistoryDetailSession,
  ChatHistoryWidgetSnapshot,
} from "@/lib/apis/web/chat-history-api";

export function useDirectChatSessionSubscription({
  sessionId,
  projectId,
  enabled,
}: {
  sessionId: string | null;
  projectId: string | null;
  enabled: boolean;
}) {
  const isUserReady = useDbUserReady();
  const canQuery = enabled && isUserReady;
  // Both results carry short-lived artifact links (the transcript and each
  // widget's HTML / tool output), so they re-run when a link expires.
  const session = useArtifactQuery<ChatHistoryDetailSession | null>(
    "directChatHistory:getCurrentSession",
    canQuery && sessionId
      ? {
          sessionId,
          ...(projectId ? { projectId } : {}),
        }
      : "skip",
  );

  const widgetSnapshots = useArtifactQuery<ChatHistoryWidgetSnapshot[]>(
    "directChatHistory:getCurrentSessionWidgetSnapshots",
    canQuery && sessionId ? { sessionId } : "skip",
  );

  // Note: turnTraces are intentionally NOT subscribed here. They're fetched
  // once per thread via the REST /chat-history/detail seed path and retained
  // in liveTraceState for the lifetime of the session. On a reactive refresh
  // we pass `undefined` for turnTraces to loadChatSession, which treats it as
  // "preserve existing trace state" rather than wiping it. This keeps the
  // component safe to render when the paired backend function isn't deployed.
  return { session, widgetSnapshots };
}
