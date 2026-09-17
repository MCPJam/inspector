import { useEffect, useState } from "react";
import { hydrateTurnRequestPayloads } from "@/components/evals/turn-trace-spans";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";

export function useRequestPayloads(
  sessionId: string | null,
  turns: Parameters<typeof hydrateTurnRequestPayloads>[0] | undefined,
) {
  const [state, setState] = useState<{
    sessionId: string | null;
    entries: LiveChatTraceRequestPayloadEntry[];
  }>({ sessionId: null, entries: [] });
  useEffect(() => {
    let active = true;
    setState({ sessionId, entries: [] });
    void hydrateTurnRequestPayloads(turns ?? [])
      .then((entries) => {
        if (active) setState({ sessionId, entries });
      })
      .catch(() => {
        /* The saved envelope fallback remains available. */
      });
    return () => {
      active = false;
    };
  }, [sessionId, turns]);
  return state.sessionId === sessionId ? state.entries : [];
}
