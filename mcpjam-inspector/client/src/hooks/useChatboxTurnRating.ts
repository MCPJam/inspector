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

  const setState = useCallback((key: string, next: TurnRatingState) => {
    setStates((prev) => ({ ...prev, [key]: next }));
  }, []);

  const runSubmit = useCallback(
    async (pending: PendingSubmission, attempt: number): Promise<void> => {
      const key = stateKey(pending.chatSessionId, pending.turnId);
      const { chatboxId: liveChatboxId, accessVersion: liveAccessVersion } =
        accessRef.current;
      if (!liveChatboxId) return;

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
          return;
        }
        setState(key, {
          value: pending.value,
          comment: pending.comment,
          status: "error",
        });
      }
    },
    [setState, submitScore]
  );

  // Replay whatever was queued as soon as the accessVersion advances.
  useEffect(() => {
    if (accessVersion === undefined) return;
    const queued = Array.from(staleQueueRef.current.values());
    if (queued.length === 0) return;
    staleQueueRef.current.clear();
    for (const pending of queued) {
      void runSubmit(pending, 0);
    }
  }, [accessVersion, runSubmit]);

  const submit = useCallback(
    (args: {
      chatSessionId: string;
      turnId: string;
      value: number;
      comment?: string;
    }) => {
      if (!enabled || !accessRef.current.chatboxId) return;
      void runSubmit(args, 0);
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
