import type { ContentBlock } from "@modelcontextprotocol/client";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import { PLUGIN_CONTEXT_NOT_PERSISTED_MESSAGE } from "@/shared/plugin-model-context";
import {
  WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS,
  WIDGET_MODEL_CONTEXT_MAX_ENTRIES,
  WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES,
  WIDGET_MODEL_CONTEXT_MAX_TOTAL_BYTES,
} from "@/shared/widget-model-context-limits";

export type WidgetModelContextUpdate = {
  toolCallId: string;
  context: {
    content?: ContentBlock[];
    structuredContent?: Record<string, unknown>;
  };
};

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** The model reads a placeholder for an image, an audio clip or a binary
 * resource (`buildWidgetModelContextSystemPrompt`), never its bytes. */
function withoutBytes(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === "image" || block.type === "audio") {
    const { data: _data, ...rest } = block;
    return rest;
  }
  const resource = block.resource;
  if (
    block.type === "resource" &&
    resource &&
    typeof resource === "object" &&
    !Array.isArray(resource)
  ) {
    const { blob: _blob, ...rest } = resource as Record<string, unknown>;
    return { ...block, resource: rest };
  }
  return block;
}

/** Whether each entry, and all of them together, fit one chat request. */
function fits(entries: WidgetModelContextEntry[]) {
  return (
    entries.length <= WIDGET_MODEL_CONTEXT_MAX_ENTRIES &&
    bytes(entries) <= WIDGET_MODEL_CONTEXT_MAX_TOTAL_BYTES &&
    entries.every(
      ({ context: { content, structuredContent } }) =>
        (content === undefined ||
          (content.length <= WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS &&
            bytes(content) <= WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES)) &&
        (structuredContent === undefined ||
          bytes(structuredContent) <= WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES),
    )
  );
}

/**
 * Queue an App's update for the next turn, without the bytes the model never
 * reads. An update the turn's request couldn't carry is refused to the App as
 * it makes it, with the error ChatGPT gives, and the App's last update stays.
 * Taking it would fail the person's next turn with a 400 instead.
 */
export function upsertWidgetModelContextEntry(
  queue: WidgetModelContextEntry[],
  toolCallId: string,
  context: WidgetModelContextUpdate["context"]
): WidgetModelContextEntry[] {
  const withoutCurrent = queue.filter(
    (entry) => entry.toolCallId !== toolCallId
  );
  const content = Array.isArray(context.content)
    ? context.content.map((block) => withoutBytes({ ...block }))
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

  const next = [
    ...withoutCurrent,
    {
      toolCallId,
      context: {
        ...(content && content.length > 0 ? { content } : {}),
        ...(structuredContent ? { structuredContent } : {}),
      },
    },
  ];
  if (!fits(next))
    throw Object.assign(new Error(PLUGIN_CONTEXT_NOT_PERSISTED_MESSAGE), {
      code: -32000,
    });
  return next;
}

/** Queues sent as one (a multi-model card adds its own to the chat's): the
 * newest entries that fit the request, so the turn always goes. */
export function fitWidgetModelContext(entries: WidgetModelContextEntry[]) {
  let kept = entries;
  while (kept.length > 0 && !fits(kept)) kept = kept.slice(1);
  return kept;
}
