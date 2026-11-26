import { useCallback, useEffect, useRef } from "react";
import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import type { CompareBroadcastDelivery } from "./compare-broadcast";
import { shouldAutoRunPreview } from "./preview-autorun";

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

interface PlaygroundAutoRunOptions {
  autoRunInput: string | undefined;
  composer: { setInput: (value: string) => void };
  evalChatHandoff: unknown;
  isEvalChatHandoffPending: boolean;
  isSessionBootstrapComplete: boolean;
  isThreadEmpty: boolean;
  isStreaming: boolean;
  isCompareMode: boolean;
  compareReadyCount: number;
  compareLanesReady: () => boolean;
  submitBlocked: boolean;
  clientInit: { settling: boolean };
  modelContextQueue: Turn["widgetModelContext"];
  ensureSelectedServerReadyForChat: () => Promise<boolean>;
  ensureThreadReadyForSend: () => Promise<boolean>;
  ensureLocalHarnessReadyForSend: () => Promise<boolean>;
  handleSendFollowUp: (text: string) => Promise<boolean>;
  broadcastSequence: { current: number };
  onAutoRunStarted?: () => void;
  onAutoRunSent?: () => void;
}

// Auto-run: when `autoRunInput` is set (eval preview "run on open"), send it
// once after the session has bootstrapped and while the thread is still
// empty. `handleSendFollowUp` ensures the server is connected first. The ref
// makes it fire exactly once per mount even as deps change.
export function usePlaygroundAutoRun({
  autoRunInput,
  composer,
  evalChatHandoff,
  isEvalChatHandoffPending,
  isSessionBootstrapComplete,
  isThreadEmpty,
  isStreaming,
  isCompareMode,
  compareReadyCount,
  compareLanesReady,
  submitBlocked,
  clientInit,
  modelContextQueue,
  ensureSelectedServerReadyForChat,
  ensureThreadReadyForSend,
  ensureLocalHarnessReadyForSend,
  handleSendFollowUp,
  broadcastSequence,
  onAutoRunStarted,
  onAutoRunSent,
}: PlaygroundAutoRunOptions) {
  const autoRanRef = useRef(false);
  const compareAutoRun = useCompareAutoRun(onAutoRunSent);
  const sendCompareAutoRun = compareAutoRun.send;
  useEffect(() => {
    if (
      !shouldAutoRunPreview({
        autoRunInput,
        alreadyRan: autoRanRef.current,
        isSessionBootstrapComplete,
        isThreadEmpty,
        isStreaming,
        handoffPending: isEvalChatHandoffPending,
      })
    ) {
      return;
    }
    // Wait for every comparison card and for model settings: a send is refused.
    // A new project's comparison clients also arrive after load, switching modes.
    if (
      submitBlocked ||
      clientInit.settling ||
      (isCompareMode && !compareLanesReady())
    )
      return;
    autoRanRef.current = true;
    onAutoRunStarted?.();
    // The prompt is auto-sent, so clear it out of the composer. The composer is
    // otherwise seeded with the same `initialInput` (so it mirrors the eval
    // editor's left-pane prompt); leaving the sent text behind would both look
    // stale and invite an accidental duplicate send. The mirror only re-seeds
    // when `initialInput` itself changes, so this clear sticks.
    //
    // Written BEFORE the call, which is only a matter of reading order — the
    // call suspends on its first `await`, so this line always ran first anyway.
    // Stating it plainly because `handleSendFollowUp` can now DEFER instead of
    // sending (the local-execution gate opens a dialog) and puts the prompt back
    // when it does, which lands after this clear and outlives it. That is the
    // intended end state, not a leak past the clear: nothing was sent, so there
    // is no stale text and no duplicate to invite — and the notice under the
    // composer says "press Send to continue", which needs the prompt to still
    // be there. `autoRanRef` is already set, so the only send that can follow
    // is the user's own.
    composer.setInput("");
    if (isCompareMode) {
      const prompt = autoRunInput as string;
      const turn = { text: prompt, widgetModelContext: modelContextQueue };
      void (async () => {
        const gated =
          (await ensureSelectedServerReadyForChat()) &&
          (await ensureThreadReadyForSend()) &&
          (await ensureLocalHarnessReadyForSend());
        if (!gated) return composer.setInput(prompt);
        const queued = { ...turn, prependMessages: [] };
        if (!sendCompareAutoRun(queued, broadcastSequence))
          autoRanRef.current = false;
      })();
      return;
    }
    void handleSendFollowUp(autoRunInput as string).then((sent) => {
      if (sent) onAutoRunSent?.();
    });
  }, [
    autoRunInput,
    composer,
    evalChatHandoff,
    isEvalChatHandoffPending,
    isSessionBootstrapComplete,
    isThreadEmpty,
    isStreaming,
    isCompareMode,
    compareReadyCount,
    compareLanesReady,
    sendCompareAutoRun,
    submitBlocked,
    clientInit.settling,
    modelContextQueue,
    ensureSelectedServerReadyForChat,
    ensureThreadReadyForSend,
    ensureLocalHarnessReadyForSend,
    handleSendFollowUp,
    broadcastSequence,
    onAutoRunStarted,
    onAutoRunSent,
  ]);
  return compareAutoRun;
}
