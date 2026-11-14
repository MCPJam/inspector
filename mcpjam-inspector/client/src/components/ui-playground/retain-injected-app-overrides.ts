import type { UIMessage } from "ai";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

/** Same-lifetime hydration keeps only live calls without authoritative snapshots. */
export function retainInjectedAppOverrides(
  previous: Record<string, ToolRenderOverride>,
  messages: UIMessage[],
  persisted: Record<string, ToolRenderOverride>,
  persistedSnapshotToolCallIds: string[],
) {
  const live = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        "toolCallId" in part && typeof part.toolCallId === "string"
          ? [part.toolCallId]
          : [],
      ),
    ),
  );
  const snapshots = new Set(persistedSnapshotToolCallIds);
  const entries = Object.entries(previous)
    .filter(([id]) => live.has(id) && !snapshots.has(id))
    .map(([id, override]) => [id, { ...override, ...persisted[id] }]);
  return Object.fromEntries(entries);
}
