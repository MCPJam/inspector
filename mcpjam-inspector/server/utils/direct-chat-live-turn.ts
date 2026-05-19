import type { ModelMessage } from "@ai-sdk/provider-utils";

const LIVE_TURN_FLUSH_INTERVAL_MS = 250;

export interface DirectChatLiveTurnPublisher {
  start: () => void;
  appendText: (delta: string) => void;
  complete: () => Promise<void>;
  error: () => Promise<void>;
}

interface DirectChatLiveTurnPublisherOptions {
  authHeader?: string;
  chatSessionId?: string;
  projectId?: string;
  modelId?: string;
  messages: ModelMessage[];
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.value === "string") return record.value;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getLatestUserPrompt(messages: ModelMessage[]): {
  promptIndex: number;
  promptText: string | undefined;
} {
  let promptIndex = -1;
  let promptText: string | undefined;

  for (const message of messages) {
    if (message.role !== "user") continue;
    promptIndex += 1;
    const text = extractText(message.content).trim();
    promptText = text.length > 0 ? text : undefined;
  }

  return {
    promptIndex: Math.max(0, promptIndex),
    promptText,
  };
}

export function createDirectChatLiveTurnPublisher({
  authHeader,
  chatSessionId,
  projectId,
  modelId,
  messages,
}: DirectChatLiveTurnPublisherOptions): DirectChatLiveTurnPublisher | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl || !authHeader || !chatSessionId || !projectId) {
    return null;
  }

  const turnId = `live_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const startedAt = Date.now();
  const { promptIndex, promptText } = getLatestUserPrompt(messages);
  let assistantText = "";
  let lastSentText: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let flushAgain = false;
  let closed = false;

  const send = async (status: "streaming" | "complete" | "error") => {
    try {
      await fetch(`${convexUrl}/direct-chat/live-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify({
          chatSessionId,
          projectId,
          turnId,
          promptIndex,
          promptText,
          assistantText,
          status,
          modelId,
          startedAt,
        }),
      });
    } catch {
      // Best effort: live collaboration should not interrupt the sender stream.
    }
  };

  const flush = (
    status: "streaming" | "complete" | "error" = "streaming",
  ): Promise<void> => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }

    if (
      status === "streaming" &&
      lastSentText !== null &&
      assistantText === lastSentText
    ) {
      return inFlight ?? Promise.resolve();
    }

    if (inFlight) {
      flushAgain = true;
      if (status !== "streaming") {
        return inFlight.then((): Promise<void> => flush(status));
      }
      return inFlight;
    }

    lastSentText = assistantText;
    inFlight = send(status).finally(() => {
      inFlight = null;
      if (flushAgain && !closed) {
        flushAgain = false;
        void flush();
      }
    });
    return inFlight;
  };

  const scheduleFlush = () => {
    if (closed || pendingTimer) return;
    pendingTimer = setTimeout(() => {
      void flush();
    }, LIVE_TURN_FLUSH_INTERVAL_MS);
  };

  return {
    start: () => {
      void flush();
    },
    appendText: (delta: string) => {
      if (closed || !delta) return;
      assistantText += delta;
      scheduleFlush();
    },
    complete: async () => {
      closed = true;
      await flush("complete");
    },
    error: async () => {
      closed = true;
      await flush("error");
    },
  };
}
