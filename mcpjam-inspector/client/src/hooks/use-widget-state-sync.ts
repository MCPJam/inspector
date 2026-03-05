import { useState, useRef, useCallback, useEffect } from "react";
import type { UIMessage } from "ai";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { buildWidgetStateParts } from "@/lib/mcp-ui/openai-widget-state-messages";

type Part = UIMessage["parts"][number];

/** Lightweight structural equality check for message parts. */
function partsEqual(a: Part[], b: Part[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa.type !== pb.type) return false;
    switch (pa.type) {
      case "text":
        if (pb.type !== "text" || pa.text !== pb.text) return false;
        break;
      case "file":
        if (
          pb.type !== "file" ||
          pa.mediaType !== pb.mediaType ||
          pa.url !== pb.url
        )
          return false;
        break;
      default:
        // For any other/future part types, fall back to JSON comparison.
        if (JSON.stringify(pa) !== JSON.stringify(pb)) return false;
    }
  }
  return true;
}

export type ModelContextItem = {
  toolCallId: string;
  context: {
    content?: ContentBlock[];
    structuredContent?: Record<string, unknown>;
  };
};

interface UseWidgetStateSyncOptions {
  status: string;
  setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void;
}

interface UseWidgetStateSyncReturn {
  /** Async-serialised enqueue: resolves file IDs then updates messages. */
  enqueueWidgetStateSync: (
    updates: { toolCallId: string; state: unknown }[],
  ) => Promise<void>;
  /** Enqueue pending updates while chat is not yet ready. */
  setWidgetStateQueue: React.Dispatch<
    React.SetStateAction<{ toolCallId: string; state: unknown }[]>
  >;
  /** Awaitable promise for the in-flight widget-state resolution. */
  widgetStateSyncRef: React.MutableRefObject<Promise<void>>;
  /** Ref of pending model-context items for use inside async submit handlers. */
  modelContextQueueRef: React.MutableRefObject<ModelContextItem[]>;
  /**
   * Setter that keeps modelContextQueueRef in sync automatically.
   * Use this instead of setModelContextQueue + manual ref update.
   */
  setModelContextQueue: (
    action:
      | ModelContextItem[]
      | ((prev: ModelContextItem[]) => ModelContextItem[]),
  ) => void;
  /** Reset all queues and cancel in-flight async updates. */
  resetWidgetSync: () => void;
}

export function useWidgetStateSync({
  status,
  setMessages,
}: UseWidgetStateSyncOptions): UseWidgetStateSyncReturn {
  const [widgetStateQueue, setWidgetStateQueue] = useState<
    { toolCallId: string; state: unknown }[]
  >([]);
  const [, setModelContextQueueState] = useState<ModelContextItem[]>([]);
  const modelContextQueueRef = useRef<ModelContextItem[]>([]);
  const widgetStateSyncRef = useRef<Promise<void>>(Promise.resolve());
  const widgetStateEpochRef = useRef(0);

  const applyWidgetStateUpdates = useCallback(
    async (
      updates: { toolCallId: string; state: unknown }[],
      epoch: number,
    ) => {
      const resolvedUpdates = await Promise.all(
        updates.map(async ({ toolCallId, state }) => {
          const messageId = `widget-state-${toolCallId}`;
          if (state === null) {
            return { messageId, nextMessage: null as null };
          }

          const parts = await buildWidgetStateParts(toolCallId, state);
          return {
            messageId,
            nextMessage: {
              id: messageId,
              // "user" (not "assistant") is required: model provider APIs only
              // accept image/file attachments inside user-role messages.
              role: "user" as const,
              parts,
            },
          };
        }),
      );

      if (epoch !== widgetStateEpochRef.current) return;

      setMessages((prevMessages) => {
        if (epoch !== widgetStateEpochRef.current) return prevMessages;

        let nextMessages = prevMessages;

        for (const { messageId, nextMessage } of resolvedUpdates) {
          if (!nextMessage) {
            nextMessages = nextMessages.filter((msg) => msg.id !== messageId);
            continue;
          }

          const existingIndex = nextMessages.findIndex(
            (msg) => msg.id === messageId,
          );
          if (existingIndex !== -1) {
            const existingMessage = nextMessages[existingIndex];
            if (partsEqual(existingMessage.parts, nextMessage.parts)) {
              continue;
            }

            const updatedMessages = [...nextMessages];
            updatedMessages[existingIndex] = nextMessage;
            nextMessages = updatedMessages;
            continue;
          }

          nextMessages = [...nextMessages, nextMessage];
        }

        return nextMessages;
      });
    },
    [setMessages],
  );

  const enqueueWidgetStateSync = useCallback(
    (updates: { toolCallId: string; state: unknown }[]) => {
      const epoch = widgetStateEpochRef.current;
      widgetStateSyncRef.current = widgetStateSyncRef.current
        .catch(() => undefined)
        .then(() => applyWidgetStateUpdates(updates, epoch));
      return widgetStateSyncRef.current;
    },
    [applyWidgetStateUpdates],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) return;

    const queueToFlush = widgetStateQueue;
    void enqueueWidgetStateSync(queueToFlush)
      .then(() => {
        setWidgetStateQueue((currentQueue) => {
          if (currentQueue.length < queueToFlush.length) return currentQueue;

          const startsWithFlushedItems = queueToFlush.every(
            (queuedItem, index) => currentQueue[index] === queuedItem,
          );
          if (!startsWithFlushedItems) return currentQueue;

          return currentQueue.slice(queueToFlush.length);
        });
      })
      .catch((error) => {
        console.error("Failed to flush widget state queue", error);
      });
  }, [status, widgetStateQueue, enqueueWidgetStateSync, setWidgetStateQueue]);

  /** Setter that keeps modelContextQueueRef in sync automatically. */
  const setModelContextQueue = useCallback(
    (
      action:
        | ModelContextItem[]
        | ((prev: ModelContextItem[]) => ModelContextItem[]),
    ) => {
      setModelContextQueueState((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        modelContextQueueRef.current = next;
        return next;
      });
    },
    [],
  );

  const resetWidgetSync = useCallback(() => {
    setModelContextQueueState([]);
    modelContextQueueRef.current = [];
    setWidgetStateQueue([]);
    widgetStateEpochRef.current += 1;
    widgetStateSyncRef.current = Promise.resolve();
  }, []);

  return {
    enqueueWidgetStateSync,
    setWidgetStateQueue,
    widgetStateSyncRef,
    modelContextQueueRef,
    setModelContextQueue,
    resetWidgetSync,
  };
}
