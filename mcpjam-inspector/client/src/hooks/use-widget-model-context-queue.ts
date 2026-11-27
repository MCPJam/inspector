import { useCallback, useRef, useState } from "react";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import {
  upsertWidgetModelContextEntry,
  type WidgetModelContextUpdate,
} from "@/lib/widget-model-context";

/**
 * The ordinary App context queued for the next turn, and the App's update
 * handler. The handler refuses an update synchronously (the App gets the
 * error), which a state updater can't do, so it reads the queue from a ref.
 */
export function useWidgetModelContextQueue() {
  const [queue, setQueueState] = useState<WidgetModelContextEntry[]>([]);
  const current = useRef(queue);
  const setQueue = useCallback(
    (
      next:
        | WidgetModelContextEntry[]
        | ((
            current: WidgetModelContextEntry[],
          ) => WidgetModelContextEntry[]),
    ) => {
      // An updater reads the ref, not the render that started an in-flight
      // send. That send's snapshot is already on the wire.
      const resolved = typeof next === "function" ? next(current.current) : next;
      current.current = resolved;
      setQueueState(resolved);
    },
    [],
  );
  const update = useCallback(
    (toolCallId: string, context: WidgetModelContextUpdate["context"]) =>
      setQueue(
        upsertWidgetModelContextEntry(current.current, toolCallId, context),
      ),
    [setQueue],
  );
  // Puts back context a send never delivered. An App that updated since then
  // keeps its newer entry.
  const restore = useCallback(
    (unsent: readonly WidgetModelContextEntry[]) => {
      const queued = current.current;
      const missing = unsent.filter(
        (entry) => !queued.some((next) => next.toolCallId === entry.toolCallId),
      );
      if (missing.length > 0) setQueue([...missing, ...queued]);
    },
    [setQueue],
  );
  return [queue, setQueue, update, restore] as const;
}
