/**
 * MRTR elicitation store — the browser half of the LOCAL modern multi-round-trip
 * (`input_required`) input bridge (MCP 2026-07-28 §12; server side in
 * `server/routes/mcp/mrtr.ts`).
 *
 * Singleton store + singleton SSE connection (same pattern as
 * `traffic-log-store`) so every surface that mounts `MrtrElicitationHost`
 * (Tools / Resources / Prompts / local Chat) shares ONE dialog rail rather than
 * opening a connection and a competing dialog each.
 *
 * The queue holds at most one ACTIVE round (`rounds[0]`); later rounds of the
 * same logical operation REPLACE it as they arrive (a new round only ever
 * arrives after the previous one was answered), and distinct operations queue
 * behind it — the UI shows exactly one pending input at a time.
 */

import { create } from "zustand";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

/** One embedded elicitation request within a round (mirror of the server DTO). */
export interface MrtrBridgeInputRequest {
  key: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
}

/** One round of a logical MRTR operation awaiting the user's responses. */
export interface MrtrRound {
  opId: string;
  roundKey: string;
  round: number;
  serverId?: string;
  requests: MrtrBridgeInputRequest[];
  timestamp: string;
}

/** One user answer to a single keyed request. */
export type MrtrKeyAnswer = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

interface MrtrElicitationState {
  rounds: MrtrRound[];
  responding: boolean;
  /** Idempotent: starts the singleton SSE listener (local mode only). */
  connect: () => void;
  /** Submits a whole round's per-key answers back into the SDK driver loop. */
  respond: (
    opId: string,
    responsesByKey: Record<string, MrtrKeyAnswer>,
  ) => Promise<void>;
  /** Test seam: inject a round without the SSE transport. */
  __ingest: (event: unknown) => void;
  __reset: () => void;
}

function reduceEvent(rounds: MrtrRound[], data: any): MrtrRound[] {
  if (data?.type === "mrtr_input_request" && typeof data.opId === "string") {
    const roundKey =
      typeof data.roundKey === "string"
        ? data.roundKey
        : `${data.opId}:${data.round ?? 0}`;
    // Dedupe SSE redelivery by roundKey; a new round of the SAME op replaces the
    // op's prior round (responses are replaced across rounds, never accumulated).
    if (rounds.some((r) => r.roundKey === roundKey)) return rounds;
    const withoutOp = rounds.filter((r) => r.opId !== data.opId);
    const round: MrtrRound = {
      opId: data.opId,
      roundKey,
      round: typeof data.round === "number" ? data.round : 0,
      serverId: typeof data.serverId === "string" ? data.serverId : undefined,
      requests: Array.isArray(data.requests) ? data.requests : [],
      timestamp:
        typeof data.timestamp === "string"
          ? data.timestamp
          : new Date().toISOString(),
    };
    return [...withoutOp, round];
  }
  if (
    (data?.type === "mrtr_input_complete" ||
      data?.type === "mrtr_input_cancelled") &&
    typeof data.opId === "string"
  ) {
    return rounds.filter((r) => r.opId !== data.opId);
  }
  return rounds;
}

let sse: EventSource | null = null;

export const useMrtrElicitationStore = create<MrtrElicitationState>(
  (set, get) => ({
    rounds: [],
    responding: false,

    connect: () => {
      if (HOSTED_MODE || sse) return;
      try {
        sse = new EventSource(addTokenToUrl("/api/mcp/mrtr/stream"));
        sse.onmessage = (ev) => {
          try {
            get().__ingest(JSON.parse(ev.data));
          } catch {
            // keep-alive / malformed frame — ignore.
          }
        };
        sse.onerror = () => {
          // EventSource auto-reconnects; nothing to do.
        };
      } catch {
        sse = null;
      }
    },

    respond: async (opId, responsesByKey) => {
      // Capture the exact round we are answering BEFORE the POST. A fast server
      // can install the next round (N+1) under the same opId while this fetch is
      // in flight; we must drop only the answered `roundKey`, never every round
      // sharing the operation id (that would silently delete the newer round and
      // strand its still-pending server-side collector).
      const answeredRoundKey = get().rounds.find(
        (r) => r.opId === opId,
      )?.roundKey;
      set({ responding: true });
      try {
        const res = await authFetch("/api/mcp/mrtr/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opId, responses: responsesByKey }),
        });
        // A 4xx/5xx (session auth failure, key-set rejection, unknown op) means
        // the server-side collector is still pending: KEEP the round so the user
        // can correct/retry rather than optimistically clearing a live dialog.
        if (!res.ok) {
          throw new Error(`MRTR respond failed (${res.status})`);
        }
        // Optimistically drop ONLY the answered round; the `mrtr_input_complete`
        // SSE event is idempotent with this.
        if (answeredRoundKey) {
          set((s) => ({
            rounds: s.rounds.filter((r) => r.roundKey !== answeredRoundKey),
          }));
        }
      } finally {
        set({ responding: false });
      }
    },

    __ingest: (event) =>
      set((s) => ({ rounds: reduceEvent(s.rounds, event) })),

    __reset: () => set({ rounds: [], responding: false }),
  }),
);
