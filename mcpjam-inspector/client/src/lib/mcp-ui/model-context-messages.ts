import type { UIMessage } from "ai";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  extractUploadedFileIds,
  extractImageUrls,
  resolveFilePart,
  guessImageMediaType,
  safeStringify,
} from "./openai-widget-state-messages";

export interface WidgetModelContext {
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
}

export interface WidgetModelContextQueueItem {
  toolCallId: string;
  context: WidgetModelContext;
}

function toDataUrl(data: string, mimeType: string): string {
  const trimmed = data.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  return `data:${mimeType};base64,${trimmed}`;
}

function contextToSyncParts(context: WidgetModelContext): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];

  for (const block of context.content ?? []) {
    switch (block.type) {
      case "text":
        if (block.text.trim()) {
          parts.push({ type: "text", text: block.text });
        }
        break;
      case "image":
        if (block.data && block.mimeType) {
          parts.push({
            type: "file",
            mediaType: block.mimeType,
            url: toDataUrl(block.data, block.mimeType),
          });
        }
        break;
      case "audio":
        if (block.data && block.mimeType) {
          parts.push({
            type: "file",
            mediaType: block.mimeType,
            url: toDataUrl(block.data, block.mimeType),
          });
        }
        break;
      default:
        break;
    }
  }

  return parts;
}

/**
 * Build parts for a single widget context item.
 *
 * Handles two paths:
 * 1. Native MCP Apps: sends `content` (ContentBlock[] with text/image blocks).
 *    Image data is inline as base64; no network fetch is required.
 * 2. ChatGPT extension widgets that call `setWidgetState` with the structured
 *    shape recommended by the Apps SDK — `{ modelContent, privateContent, imageIds }`.
 *    The host forwards this payload as `structuredContent`. File IDs in `imageIds`
 *    must be fetched from the local file endpoint before they can be attached.
 *    See: https://developers.openai.com/apps-sdk/build/state-management#image-ids-in-widget-state-model-visible-images-chatgpt-extension
 */
async function contextToParts(
  toolCallId: string,
  context: WidgetModelContext,
): Promise<UIMessage["parts"]> {
  // First, convert any typed ContentBlocks (text/image/audio) from content[].
  const parts = contextToSyncParts(context);

  // Handle the structured widget state shape from ChatGPT extension widgets
  // ({ modelContent, privateContent, imageIds }). The host forwards this as
  // structuredContent; file IDs in imageIds need to be fetched.
  if (context.structuredContent !== undefined) {
    // Only add a text summary when content[] produced nothing (ChatGPT extension path).
    // Strip privateContent — it is UI-only state that must not be sent to the model.
    if (parts.length === 0) {
      const { privateContent: _, ...modelVisible } = context.structuredContent;
      if (Object.keys(modelVisible).length > 0) {
        parts.push({
          type: "text",
          text: `Widget ${toolCallId} structured context: ${safeStringify(modelVisible)}`,
        });
      }
    }

    // Attempt to resolve uploaded file IDs embedded in structuredContent.
    const fileIds = extractUploadedFileIds(context.structuredContent);
    let useImageUrlsFallback = false;

    if (fileIds.length > 0) {
      const resolved = await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            return await resolveFilePart(fileId);
          } catch {
            return null;
          }
        }),
      );
      const resolvedParts = resolved.filter(
        (part): part is NonNullable<typeof part> => part !== null,
      );
      for (const filePart of resolvedParts) {
        parts.push(filePart);
      }

      // Only fall back to image URLs when the file endpoint was completely
      // unavailable (no IDs resolved). When some resolve, adding HTTP URLs
      // from selectedImages would duplicate already-resolved images since
      // data URLs and HTTP URLs can't be deduped against each other.
      if (resolvedParts.length === 0) {
        useImageUrlsFallback = true;
      }
    } else {
      // No file IDs at all — try image URLs directly.
      useImageUrlsFallback = true;
    }

    if (useImageUrlsFallback) {
      for (const imageUrl of extractImageUrls(context.structuredContent)) {
        parts.push({
          type: "file",
          mediaType: guessImageMediaType(imageUrl),
          url: imageUrl,
        });
      }
    }

    return parts;
  }

  // Last resort: if still nothing, serialize the entire context.
  if (parts.length === 0) {
    parts.push({
      type: "text",
      text: `Widget ${toolCallId} context: ${safeStringify(context)}`,
    });
  }
  return parts;
}

export async function buildWidgetModelContextMessages(
  queue: WidgetModelContextQueueItem[],
): Promise<UIMessage[]> {
  const now = Date.now();
  const messages = await Promise.all(
    queue.map(async ({ toolCallId, context }, index) => ({
      id: `model-context-${toolCallId}-${now}-${index}`,
      role: "user" as const,
      parts: await contextToParts(toolCallId, context),
      metadata: {
        source: "widget-model-context",
        toolCallId,
      },
    })),
  );
  // Skip queue items whose resolved parts are empty (e.g. structuredContent
  // with only privateContent) to avoid emitting invalid user messages.
  return messages.filter((msg) => msg.parts.length > 0);
}
