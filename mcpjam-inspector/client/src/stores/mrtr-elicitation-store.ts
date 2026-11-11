/**
 * MRTR elicitation store — the browser half of the LOCAL modern multi-round-trip
 * (`input_required`) input bridge (MCP 2026-07-28 §12; server side in
 * `server/routes/mcp/mrtr.ts`).
 *
 * Singleton store + singleton WebSocket connection (same pattern as
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
import { openLocalMrtrStream, type LocalMrtrStream } from "@/lib/mrtr/local-stream";
import { HOSTED_MODE } from "@/lib/config";

import type { MrtrRound, MrtrKeyAnswer } from "@/shared/local-mrtr";

/**
 * Per-round collection progress. Lives in the SINGLETON store (not in
 * `MrtrElicitationHost` component state) so that when the elected primary host
 * unmounts mid-round — e.g. the user removes the first chat / multi-model
 * `Thread` while a tab-level host survives — the promoted host resumes at the
 * same key with the answers already collected instead of restarting the round
 * and re-prompting for completed inputs. `roundKey` scopes the progress to one
 * round: when a different round becomes active, a stale collection is ignored
 * (a fresh round always starts at index 0 with no answers).
 */
interface MrtrCollection {
  roundKey: string;
  index: number;
  answers: Record<string, MrtrKeyAnswer>;
}

interface MrtrElicitationState {
  rounds: MrtrRound[];
  responding: boolean;
  /** Shared per-round collection progress (survives host promotion/unmount). */
  collection: MrtrCollection | null;
  /** Idempotent: starts the shared socket listener (local mode only). */
  connect: () => () => void;
  /** Persist collection progress for a round (advances index, accrues answers). */
  setCollection: (
    roundKey: string,
    index: number,
    answers: Record<string, MrtrKeyAnswer>,
  ) => void;
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
    // Dedupe notification redelivery by roundKey; a new round of the SAME op replaces the
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

let connection: LocalMrtrStream | null = null;
let connectionRefs = 0;

export const useMrtrElicitationStore = create<MrtrElicitationState>(
  (set, get) => ({
    rounds: [],
    responding: false,
    collection: null,

    setCollection: (roundKey, index, answers) =>
      set({ collection: { roundKey, index, answers } }),

    connect: () => {
      if (HOSTED_MODE) return () => {};
      connectionRefs++;
      connection ??= openLocalMrtrStream({
        onEvent: (event) => get().__ingest(event),
        onSnapshot: (rounds) => set((state) => ({
          rounds,
          collection: rounds.some((round) => round.roundKey === state.collection?.roundKey)
            ? state.collection : null,
        })),
      });
      const attached = connection;
      let released = false;
      return () => {
        if (released || connection !== attached) return;
        released = true;
        if (--connectionRefs === 0) {
          connection.close();
          connection = null;
        }
      };
    },

    respond: async (opId, responsesByKey) => {
      // Capture the exact round we are answering before sending it. A fast server
      // can install the next round (N+1) under the same opId while the answer is
      // in flight; we must drop only the answered `roundKey`, never every round
      // sharing the operation id (that would silently delete the newer round and
      // strand its still-pending server-side collector).
      const answeredRoundKey = get().rounds.find(
        (r) => r.opId === opId,
      )?.roundKey;
      set({ responding: true });
      try {
        if (!connection || !answeredRoundKey) throw new Error("The form connection is unavailable. Try again.");
        await connection.respond(opId, answeredRoundKey, responsesByKey);
        // Optimistically drop ONLY the answered round; the `mrtr_input_complete`
        // notification is idempotent with this. Clear collection progress for that
        // same round only: a later round (possibly already installed under this
        // opId while the POST was in flight) keeps its own in-progress answers.
        if (answeredRoundKey) {
          set((s) => ({
            rounds: s.rounds.filter((r) => r.roundKey !== answeredRoundKey),
            collection:
              s.collection?.roundKey === answeredRoundKey ? null : s.collection,
          }));
        }
      } finally {
        set({ responding: false });
      }
    },

    __ingest: (event) => set((s) => ({ rounds: reduceEvent(s.rounds, event) })),

    __reset: () => {
      connection?.close();
      connection = null;
      connectionRefs = 0;
      set({ rounds: [], responding: false, collection: null });
    },
  }),
);
