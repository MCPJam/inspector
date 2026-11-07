import type { UIMessage } from "ai";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

/** Same-lifetime hydration keeps only live calls without authoritative snapshots. */
export function retainInjectedAppOverrides(
  previous: Record<string, ToolRenderOverride>,
  messages: UIMessage[],
  persisted: Record<string, ToolRenderOverride>,
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
  const entries = Object.entries(previous).filter(
    ([id]) => live.has(id) && !Object.hasOwn(persisted, id),
  );
  return entries.length === Object.keys(previous).length
    ? previous
    : Object.fromEntries(entries);
}
