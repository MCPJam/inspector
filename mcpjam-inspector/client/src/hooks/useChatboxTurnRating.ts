import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { isStaleHostedAccessError } from "@/lib/hosted-access-errors";
import type { TurnRatingStatus } from "@mcpjam/chat-ui";

/**
 * Per-turn rating submission for the hosted User Testing chat.
 *
 * Small sibling of `useSharedChatWidgetCapture`: same hosted identity
 * (`chatboxId` + `accessVersion`), same stale-access recovery, same
 * retry-the-ingest-race contract. It is a separate hook because the widget
 * capture loop is a background sweep over widget state, while this is a direct
 * response to a click and has to report its outcome back to the UI.
 */

/** Bounded retries for `not_ready` — the `/ingest-chat` race, not an error. */
const MAX_NOT_READY_RETRIES = 4;
const NOT_READY_BACKOFF_MS = [400, 1000, 2000, 4000];

/**
 * Bounded re-asks for a fresh `accessVersion` after a stale-access rejection.
 *
 * The redeem the host runs can itself fail (offline, rate-limited). Without
 * this the queued rating would sit in `pending` forever: nothing else advances
 * `accessVersion`, so the replay effect never fires. Same shape as
 * `useSharedChatWidgetCapture`'s `schedulePendingStaleRefresh`, ending in a
 * visible error rather than a silent hang.
 */
const STALE_REFRESH_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export interface TurnRatingState {
  value?: number;
  comment?: string;
  status: TurnRatingStatus;
}

type PendingSubmission = {
  chatSessionId: string;
  turnId: string;
  value: number;
  comment?: string;
  /**
   * The chatbox this rating was left in. A retry that fires after the host
   * switched chatboxes would otherwise submit the old session and turn under
   * the new chatbox's credentials — the server rejects that, but spending a
   * round-trip and surfacing an error for a rating that is simply no longer on
   * screen is worse than dropping it.
   */
  chatboxId: string;
  /**
   * Which click this submission belongs to. Every `submit` bumps the key's
   * generation; a retry (not_ready backoff, stale replay, backoff abandon)
   * that wakes up carrying an older generation is superseded and must do
   * NOTHING. Without this, the exact ingest-race window arms a timer for the
   * OLD rating: rate 3★ → not_ready → revise to 5★ → 5★ lands → the old
   * timer fires and quietly persists 3★ over it.
   */
  generation: number;
};

interface UseChatboxTurnRatingOptions {
  enabled: boolean;
  chatboxId?: string;
  accessVersion?: number;
  /**
   * Ask the owner (ChatboxChatPage) to re-run `/web/chatbox/redeem`, exactly
   * as the widget-capture hook does. A fresh `accessVersion` flowing back in
   * replays whatever was queued.
   */
  onStaleHostedAccess?: () => void;
}

export interface UseChatboxTurnRatingResult {
  /**
   * Tell the hook which chat session is on screen, so rehydration can query
   * for it. The id is minted inside `ChatTabV2` (it owns the chat session) and
   * only reaches this level through the per-turn render callback, so the
   * widget reports it rather than the page passing it down.
   */
  observeChatSession: (chatSessionId: string) => void;
  /** Rating state for one turn, keyed `${chatSessionId}:${turnId}`. */
  getState: (chatSessionId: string, turnId: string) => TurnRatingState;
  submit: (args: {
    chatSessionId: string;
    turnId: string;
    value: number;
    comment?: string;
  }) => void;
}

function stateKey(chatSessionId: string, turnId: string): string {
  return `${chatSessionId}:${turnId}`;
}

const IDLE: TurnRatingState = { status: "idle" };

export function useChatboxTurnRating({
  enabled,
  chatboxId,
  accessVersion,
  onStaleHostedAccess,
}: UseChatboxTurnRatingOptions): UseChatboxTurnRatingResult {
  const submitScore = useMutation("sessionScores:submitScore" as any);

  const [states, setStates] = useState<Record<string, TurnRatingState>>({});
  const [chatSessionId, setChatSessionId] = useState<string | undefined>();

  const observeChatSession = useCallback((next: string) => {
    setChatSessionId((prev) => (prev === next ? prev : next));
  }, []);

  // Queued submissions waiting on a fresh accessVersion. Keyed the same way as
  // `states` so a second rating on the same turn replaces the first rather
  // than replaying both.
  const staleQueueRef = useRef(new Map<string, PendingSubmission>());
  // Latest submission generation per key — see `PendingSubmission.generation`.
  const generationRef = useRef(new Map<string, number>());
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleAttemptRef = useRef(0);
  const scheduleStaleRefreshRef = useRef<(() => void) | null>(null);
  // A mutation can reject AFTER the page is gone. Without this the rejection
  // handler would re-arm timers and re-ask for a redeem for a chat nobody is
  // looking at.
  const unmountedRef = useRef(false);
  useEffect(() => {
    // Reset on SETUP, not just on cleanup. StrictMode runs
    // mount → cleanup → mount in development; a cleanup-only write would latch
    // this true on the synthetic teardown and never clear, silently disabling
    // every guard below it — stale-access recovery would stop scheduling its
    // backoff and ratings would sit in `pending` instead of erroring.
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  const onStaleHostedAccessRef = useRef(onStaleHostedAccess);
  useEffect(() => {
    onStaleHostedAccessRef.current = onStaleHostedAccess;
  }, [onStaleHostedAccess]);

  // Latest hosted identity, read at call time. A submission that starts before
  // a re-redeem and lands after it must use the version the mutation will
  // actually be validated against.
  const accessRef = useRef({ chatboxId, accessVersion });
  useEffect(() => {
    accessRef.current = { chatboxId, accessVersion };
  }, [chatboxId, accessVersion]);

  /**
   * Rehydrate the caller's own stars after a reload.
   *
   * Scoped to the caller by the backend (`listMySessionScores`), not filtered
   * here: this runs on the public tester page, and a tester has no business
   * reading a member's annotation of their own conversation.
   */
  const persisted = useQuery(
    "sessionScores:listMySessionScores" as any,
    enabled && chatboxId && chatSessionId
      ? { chatboxId, accessVersion, chatSessionId }
      : "skip"
  ) as Array<{ turnId?: string; value?: number; comment?: string }> | undefined;

  const persistedByTurn = useMemo(() => {
    const map = new Map<string, { value?: number; comment?: string }>();
    if (!chatSessionId) return map;
    for (const row of persisted ?? []) {
      if (!row.turnId) continue;
      map.set(stateKey(chatSessionId, row.turnId), {
        value: row.value,
        comment: row.comment,
      });
    }
    return map;
  }, [persisted, chatSessionId]);

  // Read inside `setState` without making it a dependency — the merge below
  // needs the persisted comment, but re-creating `setState` on every query
  // round-trip would churn `runSubmit`'s identity too.
  const persistedByTurnRef = useRef(persistedByTurn);
  useEffect(() => {
    persistedByTurnRef.current = persistedByTurn;
  }, [persistedByTurn]);

  /**
   * `comment: undefined` means "leave the stored comment alone" — the same
   * contract the mutation uses. Merging rather than overwriting keeps a turn's
   * annotation on screen when someone revises only the stars; a plain
   * assignment would blank it locally while the server quietly kept it.
   * `''` still clears, because the caller passed a value.
   */
  const setState = useCallback((key: string, next: TurnRatingState) => {
    setStates((prev) => ({
      ...prev,
      [key]: {
        ...next,
        comment:
          next.comment === undefined
            ? // The optimistic map may hold nothing yet — the first star click
              // on a REHYDRATED turn has no prior optimistic entry, so fall
              // through to what the server already told us.
              prev[key]?.comment ?? persistedByTurnRef.current.get(key)?.comment
            : next.comment,
      },
    }));
  }, []);

  /** Forget a key entirely, so it falls back to the persisted read. */
  const clearState = useCallback((key: string) => {
    setStates((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const runSubmit = useCallback(
    async (pending: PendingSubmission, attempt: number): Promise<void> => {
      const key = stateKey(pending.chatSessionId, pending.turnId);
      // A retry waking up on a dead page, or carrying a superseded
      // generation, must do nothing — not touch state, not hit the server.
      if (unmountedRef.current) return;
      if (generationRef.current.get(key) !== pending.generation) return;
      const { chatboxId: liveChatboxId, accessVersion: liveAccessVersion } =
        accessRef.current;
      if (!liveChatboxId) {
        // Identity is momentarily absent (mid-redeem). The replay path clears
        // the queue before calling in, so returning bare would drop the rating
        // AND leave its key stuck on `pending` — a permanent spinner over a
        // discarded submission. Put it back, and arm the backoff so this
        // settles even if identity never returns.
        staleQueueRef.current.set(key, pending);
        scheduleStaleRefreshRef.current?.();
        return;
      }
      // Identity moved on to a DIFFERENT chatbox while this attempt was
      // queued. Drop it: the rating belongs to a conversation no longer on
      // screen, and the server would reject it anyway. Clear the key rather
      // than returning bare — leaving it on `pending` would show a permanent
      // spinner if the tester ever navigated back.
      if (pending.chatboxId !== liveChatboxId) {
        clearState(key);
        return;
      }

      setState(key, {
        value: pending.value,
        comment: pending.comment,
        status: "pending",
      });

      try {
        const result = (await submitScore({
          chatboxId: liveChatboxId,
          accessVersion: liveAccessVersion,
          chatSessionId: pending.chatSessionId,
          turnId: pending.turnId,
          key: "user_rating",
          value: pending.value,
          ...(pending.comment !== undefined
            ? { comment: pending.comment }
            : {}),
          // Deliberately NO promptIndex: the server derives the ordinal from
          // the turn trace. The client keeps promptIndex only to map turns to
          // messages for rendering.
        })) as { status?: string } | undefined;

        // Superseded while in flight: a newer click owns this key's state now
        // (and its own mutation is the one whose outcome matters). The server
        // write above already landed and upserts are idempotent per turn, so
        // there is nothing to undo — just don't report on it.
        if (generationRef.current.get(key) !== pending.generation) return;

        if (result?.status === "ok") {
          setState(key, {
            value: pending.value,
            comment: pending.comment,
            status: "submitted",
          });
          return;
        }

        // `not_ready` — the session row or the turn trace hasn't been ingested
        // yet. NOT a success: rendering "submitted" here would tell a tester
        // their words were saved when no row exists. Back off and retry.
        if (attempt < MAX_NOT_READY_RETRIES) {
          const delay =
            NOT_READY_BACKOFF_MS[
              Math.min(attempt, NOT_READY_BACKOFF_MS.length - 1)
            ];
          setTimeout(() => void runSubmit(pending, attempt + 1), delay);
          return;
        }
        setState(key, {
          value: pending.value,
          comment: pending.comment,
          status: "error",
        });
      } catch (error) {
        // The page is gone. Nothing below is worth doing — asking a dead page
        // to re-redeem is the same mistake as re-arming its timers, just one
        // frame earlier.
        if (unmountedRef.current) return;
        // Superseded while in flight — same rule as the success path.
        if (generationRef.current.get(key) !== pending.generation) return;
        if (isStaleHostedAccessError(error)) {
          // The share link rotated mid-session. Queue for replay and ask the
          // owner to re-redeem; the effect below drains the queue when a fresh
          // `accessVersion` arrives. The widget stays in `pending`, which is
          // honest — the rating is in flight, not lost.
          staleQueueRef.current.set(key, pending);
          setState(key, {
            value: pending.value,
            comment: pending.comment,
            status: "pending",
          });
          onStaleHostedAccessRef.current?.();
          scheduleStaleRefreshRef.current?.();
          return;
        }
        setState(key, {
          value: pending.value,
          comment: pending.comment,
          status: "error",
        });
      }
    },
    [clearState, setState, submitScore]
  );

  /**
   * Re-ask the host to redeem, on a growing backoff, until the queue drains.
   *
   * Armed on every stale rejection and cancelled by the replay effect below.
   * If the redeem never succeeds the queued ratings surface as `error` rather
   * than spinning in `pending` forever — an honest dead end beats a hang.
   */
  useEffect(() => {
    scheduleStaleRefreshRef.current = () => {
      if (unmountedRef.current) return;
      if (staleTimerRef.current !== null) return;
      const attempt = staleAttemptRef.current;
      if (attempt >= STALE_REFRESH_BACKOFF_MS.length) {
        const abandoned = Array.from(staleQueueRef.current.values());
        staleQueueRef.current.clear();
        staleAttemptRef.current = 0;
        for (const pending of abandoned) {
          const key = stateKey(pending.chatSessionId, pending.turnId);
          // A superseded queue entry no longer owns its key's state —
          // erroring it here would clobber a newer click's outcome.
          if (generationRef.current.get(key) !== pending.generation) continue;
          setState(key, {
            value: pending.value,
            comment: pending.comment,
            status: "error",
          });
        }
        return;
      }
      staleAttemptRef.current = attempt + 1;
      staleTimerRef.current = setTimeout(() => {
        staleTimerRef.current = null;
        if (unmountedRef.current) return;
        if (staleQueueRef.current.size === 0) return;
        onStaleHostedAccessRef.current?.();
        scheduleStaleRefreshRef.current?.();
      }, STALE_REFRESH_BACKOFF_MS[attempt]);
    };
    return () => {
      if (staleTimerRef.current !== null) {
        clearTimeout(staleTimerRef.current);
        staleTimerRef.current = null;
      }
      // Null the ref too: a mutation rejecting after unmount still holds a
      // reference to the rejection handler, which calls through this.
      scheduleStaleRefreshRef.current = null;
    };
  }, [setState]);

  // Replay whatever was queued as soon as the accessVersion advances.
  useEffect(() => {
    // BOTH halves of the identity, and `chatboxId` in the deps: a blip where
    // the chatbox goes missing and comes back with the SAME accessVersion
    // would otherwise never re-run this, stranding the queue forever.
    if (!chatboxId || accessVersion === undefined) return;
    const queued = Array.from(staleQueueRef.current.values());
    if (queued.length === 0) return;
    staleQueueRef.current.clear();
    // The redeem landed — stand down the backoff.
    staleAttemptRef.current = 0;
    if (staleTimerRef.current !== null) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
    for (const pending of queued) {
      void runSubmit(pending, 0);
    }
  }, [chatboxId, accessVersion, runSubmit]);

  const submit = useCallback(
    (args: {
      chatSessionId: string;
      turnId: string;
      value: number;
      comment?: string;
    }) => {
      const chatboxId = accessRef.current.chatboxId;
      if (!enabled || !chatboxId) return;
      const key = stateKey(args.chatSessionId, args.turnId);
      // Claim the key: every retry path spawned by an EARLIER click now
      // carries a stale generation and self-cancels.
      const generation = (generationRef.current.get(key) ?? 0) + 1;
      generationRef.current.set(key, generation);
      void runSubmit({ ...args, chatboxId, generation }, 0);
    },
    [enabled, runSubmit]
  );

  const getState = useCallback(
    (session: string, turnId: string): TurnRatingState => {
      const key = stateKey(session, turnId);
      // The optimistic map wins over the persisted read: it carries the
      // in-flight status, and after a submit it already holds the same value
      // the query will report on its next round-trip.
      const optimistic = states[key];
      if (optimistic) return optimistic;
      const stored = persistedByTurn.get(key);
      if (stored) {
        return { ...stored, status: "submitted" };
      }
      return IDLE;
    },
    [states, persistedByTurn]
  );

  return { observeChatSession, getState, submit };
}
