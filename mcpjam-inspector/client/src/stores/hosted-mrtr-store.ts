/**
 * Hosted MRTR store — the browser half of the DURABLE multi-round-trip
 * (`input_required`) continuation transport (MCP 2026-07-28 §12.5; server side
 * in `server/routes/web/mrtr-continuation.ts`, `server/utils/mrtr-hosted-*.ts`).
 *
 * ## Why this is not `mrtr-elicitation-store`
 *
 * The local store (`stores/mrtr-elicitation-store.ts`) drives the LOCAL SDK
 * loop: an SSE channel delivers rounds and a POST feeds answers back into a
 * driver that is still holding the operation open in this process. Hosted MRTR
 * has no such holder — the worker suspended the operation to a durable Convex
 * continuation and returned. A round therefore arrives on whatever transport
 * produced it (a chat stream data part, or a direct op's JSON envelope) and the
 * ANSWER goes back on a fresh authenticated request whose shape differs per
 * surface. So the queue is shared, but the submit is per-round: each enqueued
 * round carries its own handlers.
 *
 * Singleton (same pattern as the local store) so every mounted
 * `HostedMrtrHost` cooperates on ONE dialog rail instead of stacking a dialog
 * per surface, and so an API-layer driver and the chat hook can feed the same
 * queue.
 *
 * The queue holds at most one ACTIVE round (`rounds[0]`); a later round of the
 * same continuation REPLACES its predecessor (a new round only ever arrives
 * after the previous one was answered), and distinct continuations queue behind
 * it — the UI shows exactly one pending input at a time.
 */

import { create } from "zustand";
import type {
  MrtrElicitationResponse,
  MrtrInputRequestDisplay,
  MrtrOperationMethod,
} from "@/shared/mrtr-continuation";

/** One suspended round awaiting the user's answers. */
export interface HostedMrtrRound {
  /** `${continuationId}:${round}` — the dedupe/collection key. */
  key: string;
  continuationId: string;
  round: number;
  /** Trusted anchor; `serverName` is a display label only. */
  serverId: string;
  serverName?: string;
  method: MrtrOperationMethod;
  operationLabel?: string;
  requests: MrtrInputRequestDisplay[];
  expiresAt: number;
  timestamp: string;
}

/**
 * How THIS round is answered. Supplied by whoever enqueued it, because the
 * resume transport differs per surface: a hosted chat round resumes by
 * re-driving the agent turn (`mrtrResume` on the chat request) so the result is
 * spliced into the transcript, while a direct op resumes over
 * `/api/web/mrtr/resume`.
 */
export interface HostedMrtrRoundHandlers {
  submit: (
    responses: Record<string, MrtrElicitationResponse>,
  ) => Promise<void> | void;
  /** Withdraw the durable continuation (user dismissed / unresumable). */
  cancel?: () => Promise<void> | void;
}

/** Per-round collection progress (one keyed request is shown at a time). */
interface HostedMrtrCollection {
  key: string;
  index: number;
  answers: Record<string, MrtrElicitationResponse>;
}

interface HostedMrtrState {
  rounds: HostedMrtrRound[];
  responding: boolean;
  collection: HostedMrtrCollection | null;
  /** Queue a round + its per-round transport. Idempotent per round key. */
  enqueue: (round: HostedMrtrRound, handlers: HostedMrtrRoundHandlers) => void;
  setCollection: (
    key: string,
    index: number,
    answers: Record<string, MrtrElicitationResponse>,
  ) => void;
  /** Submit a whole round's per-key answers through its own handler. */
  submit: (
    key: string,
    responses: Record<string, MrtrElicitationResponse>,
  ) => Promise<void>;
  /** User withdrew the round: drop it and withdraw the durable continuation. */
  cancel: (key: string) => Promise<void>;
  /** A continuation reached a terminal state server-side — drop its rounds. */
  resolveContinuation: (continuationId: string) => void;
  /** Drop everything (chat reset / abort). Handlers are NOT invoked. */
  clear: () => void;
  __reset: () => void;
}

/**
 * Handlers live OUTSIDE the store state: they are closures over a surface's
 * send path, not renderable data, and keeping them out of state means a
 * `useSyncExternalStore` selector never re-renders on an identity change that
 * has no visual effect.
 */
const handlersByKey = new Map<string, HostedMrtrRoundHandlers>();

function dropKeys(keys: Iterable<string>): void {
  for (const key of keys) handlersByKey.delete(key);
}

export const useHostedMrtrStore = create<HostedMrtrState>((set, get) => ({
  rounds: [],
  responding: false,
  collection: null,

  enqueue: (round, handlers) => {
    const existing = get().rounds;
    // Re-delivery of the same round (a retried part, a replayed claim) must not
    // stack a second dialog over one suspended operation.
    if (existing.some((r) => r.key === round.key)) return;
    handlersByKey.set(round.key, handlers);
    const superseded = existing.filter(
      (r) => r.continuationId === round.continuationId,
    );
    dropKeys(superseded.map((r) => r.key));
    set((s) => ({
      rounds: [
        ...s.rounds.filter((r) => r.continuationId !== round.continuationId),
        round,
      ],
      // A superseded round's half-collected answers belong to the round that
      // was replaced, never to the new one (responses are replaced across
      // rounds, never accumulated).
      collection: superseded.some((r) => r.key === s.collection?.key)
        ? null
        : s.collection,
    }));
  },

  setCollection: (key, index, answers) =>
    set({ collection: { key, index, answers } }),

  submit: async (key, responses) => {
    const handlers = handlersByKey.get(key);
    if (!handlers) {
      // The round was dropped underneath the dialog (terminal event, reset).
      set((s) => ({
        rounds: s.rounds.filter((r) => r.key !== key),
        collection: s.collection?.key === key ? null : s.collection,
      }));
      return;
    }
    set({ responding: true });
    try {
      await handlers.submit(responses);
      // Only a settled submit drops the round: a throw means the continuation
      // is still pending server-side, so the dialog (and its collected
      // answers) must survive for a retry rather than vanish into a dead end.
      handlersByKey.delete(key);
      set((s) => ({
        rounds: s.rounds.filter((r) => r.key !== key),
        collection: s.collection?.key === key ? null : s.collection,
      }));
    } finally {
      set({ responding: false });
    }
  },

  cancel: async (key) => {
    const handlers = handlersByKey.get(key);
    handlersByKey.delete(key);
    // Drop the round FIRST: the user withdrew it, so the dialog must close even
    // if the withdrawal request itself fails (the continuation then expires on
    // its own TTL rather than trapping the UI).
    set((s) => ({
      rounds: s.rounds.filter((r) => r.key !== key),
      collection: s.collection?.key === key ? null : s.collection,
    }));
    await handlers?.cancel?.();
  },

  resolveContinuation: (continuationId) => {
    const dropped = get().rounds.filter(
      (r) => r.continuationId === continuationId,
    );
    if (dropped.length === 0) return;
    dropKeys(dropped.map((r) => r.key));
    set((s) => ({
      rounds: s.rounds.filter((r) => r.continuationId !== continuationId),
      collection: dropped.some((r) => r.key === s.collection?.key)
        ? null
        : s.collection,
    }));
  },

  clear: () => {
    handlersByKey.clear();
    set({ rounds: [], collection: null, responding: false });
  },

  __reset: () => {
    handlersByKey.clear();
    set({ rounds: [], collection: null, responding: false });
  },
}));
