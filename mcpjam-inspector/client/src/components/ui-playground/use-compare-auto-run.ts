import { useCallback, useRef } from "react";
import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import type { CompareBroadcastDelivery } from "./compare-broadcast";

type Turn = Omit<BroadcastChatTurnRequest, "id">;

/** Broadcasts the auto-run to every lane; it counts as sent once one takes it. */
export function useCompareAutoRun(onSent?: () => void) {
  // The queue is declared after the auto-run effect, so it is read through here.
  const queueRef = useRef<(turn: Turn) => boolean>(() => false);
  const pendingIdRef = useRef<number | null>(null);
  // False when no lane can take it yet; the caller retries.
  const send = useCallback((turn: Turn, sequence: { current: number }) => {
    if (!queueRef.current(turn)) return false;
    pendingIdRef.current = sequence.current;
    return true;
  }, []);
  const claim = (
    delivery: CompareBroadcastDelivery | null,
    request: BroadcastChatTurnRequest,
    recipient: string,
  ) => {
    const claimed = delivery?.claim(request, recipient) ?? false;
    if (claimed && request.id === pendingIdRef.current) {
      pendingIdRef.current = null;
      onSent?.();
    }
    return claimed;
  };
  return { queueRef, send, claim };
}
