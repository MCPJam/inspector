import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import { useEscapeToStopChat } from "./use-escape-to-stop-chat";

interface UseChatStopControlsOptions {
  isMultiModelMode: boolean;
  isStreaming: boolean;
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

export function useChatStopControls({
  isMultiModelMode,
  isStreaming,
  multiModelSummaries,
  setStopBroadcastRequestId,
  stop,
}: UseChatStopControlsOptions) {
  const isAnyMultiModelStreaming =
    isMultiModelMode &&
    Object.values(multiModelSummaries).some(
      (summary) => summary.status === "running",
    );
  const isStreamingActive = isMultiModelMode
    ? isAnyMultiModelStreaming
    : isStreaming;

  const stopActiveChat = useCallback(() => {
    if (isMultiModelMode) {
      setStopBroadcastRequestId((previous) => previous + 1);
      return;
    }

    stop();
  }, [isMultiModelMode, setStopBroadcastRequestId, stop]);

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
