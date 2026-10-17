import type { ChatHistoryDetailSession, ChatHistoryWidgetSnapshot } from "@/lib/apis/web/chat-history-api";
import { artifactStableKey } from "@/lib/artifact-urls";

export function buildHistoryContentSignature(
  session: ChatHistoryDetailSession,
  widgetSnapshots?: ChatHistoryWidgetSnapshot[],
) {
  const snapshotSignature = (widgetSnapshots ?? [])
    .map((snapshot) =>
      [
        snapshot._id,
        snapshot.toolCallId,
        snapshot.resourceUri ?? "",
        // Artifact links are re-minted with new expiries; the object they
        // point at is what says whether the content changed.
        artifactStableKey(snapshot.widgetHtmlUrl ?? ""),
        artifactStableKey(snapshot.toolOutputUrl ?? ""),
      ].join(":"),
    )
    .sort()
    .join("|");
  return [
    session._id,
    session.chatSessionId,
    artifactStableKey(session.messagesBlobUrl ?? ""),
    snapshotSignature,
  ].join("::");
}

