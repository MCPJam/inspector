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
  const setQueue = useCallback((next: WidgetModelContextEntry[]) => {
    current.current = next;
    setQueueState(next);
  }, []);
  const update = useCallback(
    (toolCallId: string, context: WidgetModelContextUpdate["context"]) =>
      setQueue(
        upsertWidgetModelContextEntry(current.current, toolCallId, context),
      ),
    [setQueue],
  );
  return [queue, setQueue, update] as const;
}
