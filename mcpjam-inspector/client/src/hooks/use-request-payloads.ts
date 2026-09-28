import { useEffect, useRef, useState } from "react";
import { hydrateTurnRequestPayloads } from "@/components/evals/turn-trace-spans";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";

type RequestPayloadTurns = Parameters<typeof hydrateTurnRequestPayloads>[0];

export type RequestPayloadsRead = {
  entries: LiveChatTraceRequestPayloadEntry[];
  /** The session references saved requests and they did not load. */
  error: string | null;
  /** Turn traces or request blobs are still on their way. */
  pending: boolean;
};

const PENDING: RequestPayloadsRead = {
  entries: [],
  error: null,
  pending: true,
};

/**
 * The saved per-step model requests for a session's turns.
 *
 * Keyed on the blob URLs, not the `turns` array: Convex hands back a fresh
 * array on every push, and a running session pushes on every turn. Keying on
 * the array refetched every blob each time and blanked Raw in between.
 * Entries already shown stay until the next fetch resolves.
 */
export function useRequestPayloads(
  sessionId: string | null,
  turns: RequestPayloadTurns | undefined,
): RequestPayloadsRead {
  const urlKey =
    turns === undefined
      ? null
      : [...turns]
          .sort((a, b) => a.promptIndex - b.promptIndex)
          .map((turn) => turn.requestPayloadsBlobUrl ?? "")
          .join("\n");
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const [state, setState] = useState<
    RequestPayloadsRead & { sessionId: string | null; urlKey: string | null }
  >({ ...PENDING, sessionId: null, urlKey: null });

  useEffect(() => {
    if (urlKey === null) return;
    let active = true;
    setState((prev) => ({
      entries: prev.sessionId === sessionId ? prev.entries : [],
      error: null,
      pending: true,
      sessionId,
      urlKey,
    }));
    hydrateTurnRequestPayloads(turnsRef.current ?? [])
      .then((entries) => {
        if (active)
          setState({ entries, error: null, pending: false, sessionId, urlKey });
      })
      .catch(() => {
        if (active)
          setState({
            entries: [],
            error: "Saved model requests could not be loaded",
            pending: false,
            sessionId,
            urlKey,
          });
      });
    return () => {
      active = false;
    };
  }, [sessionId, urlKey]);

  if (state.sessionId !== sessionId) return PENDING;
  // The URLs moved on and the refetch has not started yet: keep what is shown.
  if (state.urlKey !== urlKey) return { ...state, pending: true };
  return state;
}

/** The envelope fields Raw reads. Absent when there is nothing to say. */
export function requestPayloadEnvelopeFields(read: RequestPayloadsRead) {
  return {
    ...(read.entries.length > 0 ? { requestPayloads: read.entries } : {}),
    ...(read.error ? { requestPayloadsError: read.error } : {}),
    ...(read.pending ? { requestPayloadsPending: true as const } : {}),
  };
}
