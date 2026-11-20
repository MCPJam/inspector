import { useRef } from "react";
import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import type { CompareBroadcastDelivery } from "./compare-broadcast";

type BroadcastTurn = Omit<BroadcastChatTurnRequest, "id">;

/**
 * Sends an auto-run prompt to every comparison lane as one broadcast, the way
 * a starter chip sends there. It counts as sent once a lane takes it, not when
 * it is queued.
 */
export function useCompareAutoRun(onSent?: () => void) {
  // The queue is declared after the auto-run effect, so it is read through here.
  const queueRef = useRef<(turn: BroadcastTurn) => boolean>(() => false);
  const pendingIdRef = useRef<number | null>(null);

  const send = async (
    text: string,
    widgetModelContext: BroadcastTurn["widgetModelContext"],
    {
      gate,
      sequence,
      onDeferred,
      onRefused,
    }: {
      /** The send gates; false when one of them deferred the send. */
      gate: () => Promise<boolean>;
      sequence: { current: number };
      onDeferred: () => void;
      /** No lane can take it yet; the caller retries. */
      onRefused: () => void;
    },
  ) => {
    if (!(await gate())) return onDeferred();
    if (!queueRef.current({ text, prependMessages: [], widgetModelContext }))
      return onRefused();
    pendingIdRef.current = sequence.current;
  };

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
