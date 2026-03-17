import { logger } from "./logger";

interface PersistChatSessionOptions {
  chatSessionId: string;
  modelId: string;
  modelSource: "mcpjam" | "byok";
  authHeader?: string;
  workspaceId?: string;
  sourceType?: "serverShare" | "sandbox" | "direct";
  shareToken?: string;
  sandboxToken?: string;
  serverId?: string;
  visitorDisplayName?: string;
  sessionMessages?: unknown[];
  messages?: unknown[];
  systemPrompt?: string;
  responseMessages?: unknown[];
  assistantText?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  startedAt: number;
  lastActivityAt?: number;
}

export async function persistChatSessionToConvex(
  options: PersistChatSessionOptions,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl || !options.authHeader || !options.chatSessionId) {
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
        modelSource: options.modelSource,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(options.sourceType ? { sourceType: options.sourceType } : {}),
        ...(options.shareToken ? { shareToken: options.shareToken } : {}),
        ...(options.sandboxToken ? { sandboxToken: options.sandboxToken } : {}),
        ...(options.serverId ? { serverId: options.serverId } : {}),
        ...(options.visitorDisplayName
          ? { visitorDisplayName: options.visitorDisplayName }
          : {}),
        ...(options.sessionMessages
          ? { sessionMessages: options.sessionMessages }
          : {}),
        ...(options.messages ? { messages: options.messages } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.responseMessages
          ? { responseMessages: options.responseMessages }
          : {}),
        ...(options.assistantText
          ? { assistantText: options.assistantText }
          : {}),
        ...(options.toolCalls ? { toolCalls: options.toolCalls } : {}),
        ...(options.toolResults ? { toolResults: options.toolResults } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.finishReason ? { finishReason: options.finishReason } : {}),
        startedAt: options.startedAt,
        ...(options.lastActivityAt
          ? { lastActivityAt: options.lastActivityAt }
          : {}),
      }),
    });

    if (!response.ok) {
      logger.warn(
        "[chat-session-persistence] Failed to persist chat session",
        undefined,
        {
          status: response.status,
          responseText: await response.text().catch(() => ""),
        },
      );
    }
  } catch (error) {
    logger.warn(
      "[chat-session-persistence] Error persisting chat session",
      error,
    );
  }
}
