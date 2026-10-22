import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import { useEscapeToStopChat } from "./use-escape-to-stop-chat";

interface UseChatStopControlsOptions {
  /**
   * True whenever the compare grid is live — multi-model OR multi-host.
   * Stop semantics are identical across both: per-card streams stop via
   * `setStopBroadcastRequestId`, NOT via the hidden root `stop()`. Pre-
   * Phase 4 this was named `isMultiModelMode`; in multi-host mode that
   * flag was false so stop hit the root session instead of the visible
   * cards.
   */
  isCompareMode: boolean;
  isStreaming: boolean;
  /**
   * Summary table keyed by `compareId` (modelId in multi-model;
   * hostId in multi-host). Used to detect whether ANY visible card is
   * currently running.
   */
  multiModelSummaries: Record<string, MultiModelCardSummary>;
  setStopBroadcastRequestId: Dispatch<SetStateAction<number>>;
  stop: () => void;
}

interface ChatComposerInteractivityOptions {
  isStreamingActive: boolean;
  composerDisabled?: boolean;
  submitDisabled?: boolean;
}

export function getChatComposerInteractivity({
  isStreamingActive,
  composerDisabled = false,
  submitDisabled = false,
}: ChatComposerInteractivityOptions) {
  return {
    composerDisabled,
    // Streaming should block dispatch, but only explicit hard-lock states should
    // make the composer read-only.
    sendBlocked: composerDisabled || submitDisabled || isStreamingActive,
  };
}

/**
 * Readiness for an App's editable draft (`ui/message` with `send: false`).
 * A draft only edits the composer, so it waits on ownership, read-only and
 * transition state, never on whether a send could run now (credits, a local
 * harness, sign-in, server readiness): drafting while sending is unavailable
 * is the point of a draft. A draft in a new chat also waits for a running
 * turn, because opening the new chat would end it.
 */
export function getAppDraftInteractivity({
  readOnly,
  transitioning,
  sendInFlight,
  isStreamingActive,
}: {
  readOnly: boolean;
  transitioning: boolean;
  sendInFlight: boolean;
  isStreamingActive: boolean;
}) {
  const draftBlocked = readOnly || transitioning || sendInFlight;
  return {
    draftBlocked,
    newDraftBlocked: draftBlocked || isStreamingActive,
  };
}

export function useChatStopControls({
  isCompareMode,
  isStreaming,
  multiModelSummaries,
  setStopBroadcastRequestId,
  stop,
}: UseChatStopControlsOptions) {
  const isAnyMultiModelStreaming =
    isCompareMode &&
    Object.values(multiModelSummaries).some(
      (summary) => summary.status === "running",
    );
  const isStreamingActive = isCompareMode
    ? isAnyMultiModelStreaming
    : isStreaming;

  const stopActiveChat = useCallback(() => {
    if (isCompareMode) {
      setStopBroadcastRequestId((previous) => previous + 1);
      return;
    }

    stop();
  }, [isCompareMode, setStopBroadcastRequestId, stop]);

  useEscapeToStopChat({
    enabled: isStreamingActive,
    onStop: stopActiveChat,
  });

  return {
    isAnyMultiModelStreaming,
    isStreamingActive,
    stopActiveChat,
  };
}
