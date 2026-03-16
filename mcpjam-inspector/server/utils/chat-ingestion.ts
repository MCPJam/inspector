import { logger } from "./logger";

interface IngestBYOKChatOptions {
  chatSessionId?: string;
  modelId: string;
  assistantText: string;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
  authHeader?: string;
  startedAt: number;
}

export async function ingestBYOKChat(
  options: IngestBYOKChatOptions,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  if (!options.authHeader) {
    return;
  }

  try {
    const response = await fetch(`${convexUrl}/ingest-chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: options.authHeader,
      },
      body: JSON.stringify({
        chatSessionId: options.chatSessionId,
        modelId: options.modelId,
        modelSource: "byok",
        assistantText: options.assistantText,
        toolCalls: options.toolCalls,
        toolResults: options.toolResults,
        usage: options.usage,
        finishReason: options.finishReason,
        startedAt: options.startedAt,
      }),
    });

    if (!response.ok) {
      logger.warn(
        "[chat-ingestion] Failed to ingest BYOK chat",
        undefined,
        {
          status: response.status,
          responseText: await response.text().catch(() => ""),
        },
      );
    }
  } catch (error) {
    logger.warn("[chat-ingestion] Error ingesting BYOK chat", error);
  }
}
