import { useEffect, useState } from "react";
import type { MultiModelCardStatus } from "./model-compare-card-header";

type StreamOutcome = "streaming" | "stopped" | "finished";

/**
 * A compare card's status. The AI SDK reports a stopped stream as `ready`, so
 * when a stream ends the card asks its session whether the turn was aborted
 * and reports a stopped turn as `cancelled`: its partial numbers must not rank
 * against turns that finished. Until the session answers, the card stays
 * `running` rather than lift a stopped turn as `ready` for a render.
 */
export function useCompareCardStatus({
  failed,
  isStreaming,
  isBusy = false,
  isThreadEmpty,
  consumeTurnAborted,
}: {
  failed: boolean;
  isStreaming: boolean;
  /** Other work that keeps the card running, such as a tool it executes. */
  isBusy?: boolean;
  isThreadEmpty: boolean;
  consumeTurnAborted: () => boolean;
}): MultiModelCardStatus {
  const [stream, setStream] = useState<StreamOutcome>("finished");
  useEffect(() => {
    if (isStreaming) setStream("streaming");
    else if (stream === "streaming") {
      setStream(consumeTurnAborted() ? "stopped" : "finished");
    } else if (isThreadEmpty) setStream("finished");
  }, [consumeTurnAborted, isStreaming, isThreadEmpty, stream]);

  if (failed) return "error";
  if (isStreaming || isBusy || stream === "streaming") return "running";
  if (isThreadEmpty) return "idle";
  return stream === "stopped" ? "cancelled" : "ready";
}
