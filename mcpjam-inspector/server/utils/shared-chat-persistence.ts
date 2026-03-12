import type { ModelMessage } from "@ai-sdk/provider-utils";
import { logger } from "./logger";

const PREVIEW_MAX_LENGTH = 200;

interface SaveThreadToConvexOptions {
  chatSessionId: string;
  shareToken?: string;
  sandboxToken?: string;
  bearerToken: string;
  messages: ModelMessage[];
  messageCount: number;
  modelId?: string;
}

function extractTextPreview(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join(" ")
    .trim();
}

function getFirstMessagePreview(messages: ModelMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const preview = extractTextPreview(
      (message as { content?: unknown }).content,
    )
      .trim()
      .slice(0, PREVIEW_MAX_LENGTH);
    if (preview.length > 0) {
      return preview;
    }
  }

  return "";
}

export async function saveThreadToConvex({
  chatSessionId,
  shareToken,
  sandboxToken,
  bearerToken,
  messages,
  messageCount,
  modelId,
}: SaveThreadToConvexOptions): Promise<void> {
  if (!!shareToken === !!sandboxToken) {
    logger.error(
      "[shared-chat-persistence] Exactly one hosted token is required while saving thread",
      undefined,
      { chatSessionId },
    );
    return;
  }

  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    logger.error(
      "[shared-chat-persistence] Missing CONVEX_HTTP_URL while saving thread",
      undefined,
      { chatSessionId },
    );
    return;
  }

  try {
    const response = await fetch(`${convexUrl}/shared-chat/save-thread`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        chatSessionId,
        ...(shareToken ? { shareToken } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
        messages,
        messageCount,
        firstMessagePreview: getFirstMessagePreview(messages),
        ...(modelId ? { modelId } : {}),
      }),
    });

    if (!response.ok) {
      logger.error(
        "[shared-chat-persistence] Failed to persist shared chat thread",
        undefined,
        {
          chatSessionId,
          status: response.status,
          responseText: await response.text().catch(() => ""),
        },
      );
    }
  } catch (error) {
    logger.error(
      "[shared-chat-persistence] Error while saving shared chat thread",
      error,
      { chatSessionId },
    );
  }
}
