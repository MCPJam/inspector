import type { ContentBlock } from "@modelcontextprotocol/client";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";

export type WidgetModelContextUpdate = {
  toolCallId: string;
  context: {
    content?: ContentBlock[];
    structuredContent?: Record<string, unknown>;
  };
};

export function upsertWidgetModelContextEntry(
  queue: WidgetModelContextEntry[],
  toolCallId: string,
  context: WidgetModelContextUpdate["context"]
): WidgetModelContextEntry[] {
  const withoutCurrent = queue.filter(
    (entry) => entry.toolCallId !== toolCallId
  );
  const content = Array.isArray(context.content)
    ? (context.content as unknown as Record<string, unknown>[])
    : undefined;
  const structuredContent =
    context.structuredContent &&
    typeof context.structuredContent === "object" &&
    !Array.isArray(context.structuredContent)
      ? context.structuredContent
      : undefined;

  if ((!content || content.length === 0) && !structuredContent) {
    return withoutCurrent;
  }

  return [
    ...withoutCurrent,
    {
      toolCallId,
      context: {
        ...(content && content.length > 0 ? { content } : {}),
        ...(structuredContent ? { structuredContent } : {}),
      },
    },
  ];
}
