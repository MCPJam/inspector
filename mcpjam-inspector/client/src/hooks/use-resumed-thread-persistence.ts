import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { PersistReceiptData } from "@/shared/persist-receipt";

/**
 * Decide what a finished turn did to the chat-history thread it was sent on,
 * and react to it. Shared by the chat tab and the playground, which ran ~90%
 * identical copies of this logic.
 *
 * The old shape polled the session's `version` over REST after every stream and
 * detached the thread — "This chat changed elsewhere" — whenever the version
 * had not advanced. That reads a save failure as a concurrency event, because
 * an un-advanced version is exactly what BOTH look like from the outside. In
 * production it was almost always the former: the ingest had dropped the turn,
 * and users were pushed into a fresh thread every few messages.
 *
 * The server now states the outcome directly, as a `data-persist-receipt` part
 * emitted before the stream closes. This hook consumes that statement, and only
 * falls back to watching the session subscription when no receipt arrives.
 *
 * The one rule everywhere below: **never detach without positive evidence**.
 * Detaching costs the user their thread, so it happens only on an explicit
 * `conflict` — someone really did write to this session — and never on silence.
 */

/** Mirrors the AI SDK chat status values both surfaces already pass around. */
export type ResumedThreadStreamStatus =
  | "submitted"
  | "streaming"
  | "ready"
  | "error";

/**
 * How long to keep watching the session subscription for a version bump before
 * telling the user the reply could not be saved.
 *
 * A `failed`/`skipped` receipt is a report from the ingest call, and a timed-out
 * ingest may still have committed server-side — so even an explicit failure gets
 * a short grace window rather than an immediate alarm. With no receipt at all
 * (an older inspector server) there is nothing to reconcile against but the
 * subscription, so the window is longer.
 */
export const RECEIPT_RECONCILE_WINDOW_MS = 3_000;
export const NO_RECEIPT_RECONCILE_WINDOW_MS = 10_000;

/**
 * Shown when the session really did move under this turn. The old copy said
 * this for save failures too, which is why users read it as nonsense: nothing
 * had changed anywhere, their turn had simply been dropped.
 */
export const RESUMED_THREAD_CONFLICT_MESSAGE =
  "Someone else updated this chat while you were replying. Your reply stayed here; your next message will start a new thread.";

/**
 * Shown when the reply is not in chat history and reconciliation could not
 * prove otherwise. Says only what is known — and notably does NOT promise a new
 * thread, because the thread stays attached.
 */
export const RESUMED_THREAD_UNSAVED_MESSAGE =
  "This reply couldn't be saved to your chat history. It's still visible here.";

type PendingReconcile = {
  sessionId: string;
  baselineVersion: number;
  deadlineAt: number;
  /** True once the "couldn't save" notice has been shown for this turn. */
  notified: boolean;
};

export interface ResumedThreadPersistenceOptions {
  /**
   * The baseline cell, owned by the CALLER rather than this hook.
   *
   * Both surfaces already clear it from several deliberate session changes —
   * new chat, archive-all, reset, a rewind's `onBeforeBranch` — that all mean
   * "the thread this turn was aimed at is no longer ours". Keeping the cell in
   * the component lets those sites stay exactly as they are; this hook owns the
   * protocol (capture at stream start, consume at stream end), not the storage.
   */
  sendBaselineRef: MutableRefObject<{
    sessionId: string;
    version: number;
  } | null>;
  /** False disables the whole mechanism (no history rail, no hosted session). */
  enabled: boolean;
  status: ResumedThreadStreamStatus;
  /** The history row this surface is currently attached to, if any. */
  activeHistorySessionId: string | null;
  /** Version this surface believes it is continuing from; null when not resumed. */
  resumedVersion: number | null;
  consumePersistReceipt: () => PersistReceiptData | null;
  /**
   * Live version from the session subscription: `undefined` while loading or
   * torn down (it is disabled mid-stream), `null` when the row is gone.
   */
  reactiveSessionVersion: number | null | undefined;
  syncResumedVersion: (version: number | null) => void;
  markHistorySessionRead: (sessionId: string) => void;
  /** Refresh the rail's copy of the session. Fire-and-forget. */
  refreshAfterStream: () => void;
  /** Someone else wrote to this session: branch to a new local thread. */
  onConflict: () => void;
  /** The reply is not in history and reconciliation could not prove otherwise. */
  onUnsaved: () => void;
}

export function useResumedThreadPersistence(
  options: ResumedThreadPersistenceOptions
): void {
  const {
    sendBaselineRef,
    enabled,
    status,
    activeHistorySessionId,
    resumedVersion,
    consumePersistReceipt,
    reactiveSessionVersion,
    syncResumedVersion,
    markHistorySessionRead,
    refreshAfterStream,
    onConflict,
    onUnsaved,
  } = options;

  // Callbacks are read through a ref so this hook's effects depend on the
  // STREAM's transitions, not on a caller's render identity. Without it an
  // unmemoized `onConflict` would re-run the post-stream effect on every render
  // and consume the baseline early.
  const callbacksRef = useRef({
    consumePersistReceipt,
    syncResumedVersion,
    markHistorySessionRead,
    refreshAfterStream,
    onConflict,
    onUnsaved,
  });
  callbacksRef.current = {
    consumePersistReceipt,
    syncResumedVersion,
    markHistorySessionRead,
    refreshAfterStream,
    onConflict,
    onUnsaved,
  };

  const pendingReconcileRef = useRef<PendingReconcile | null>(null);
  // The reconciliation state lives in refs because nothing renders from it, so
  // the watcher effect below needs its own way to wake up — on start, and again
  // when its deadline timer fires.
  const [reconcileTick, setReconcileTick] = useState(0);
  const wakeReconcileWatcher = useCallback(
    () => setReconcileTick((value) => value + 1),
    []
  );

  const startReconcile = useCallback(
    (sessionId: string, baselineVersion: number, windowMs: number) => {
      pendingReconcileRef.current = {
        sessionId,
        baselineVersion,
        deadlineAt: Date.now() + windowMs,
        notified: false,
      };
      wakeReconcileWatcher();
    },
    [wakeReconcileWatcher]
  );

  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    const wasStreaming =
      previousStatus === "submitted" || previousStatus === "streaming";
    const isNowStreaming = status === "submitted" || status === "streaming";

    if (!wasStreaming && isNowStreaming) {
      // A new turn supersedes any outstanding question about the last one.
      pendingReconcileRef.current = null;
      sendBaselineRef.current =
        enabled && activeHistorySessionId && resumedVersion !== null
          ? { sessionId: activeHistorySessionId, version: resumedVersion }
          : null;
      return;
    }

    if (!wasStreaming) return;

    if (status === "error") {
      sendBaselineRef.current = null;
      return;
    }

    // Still mid-stream (the submitted ↔ streaming transition). Consuming the
    // baseline now would leave it null when the stream actually ends.
    if (isNowStreaming) return;
    if (status !== "ready") return;

    const baseline = sendBaselineRef.current;
    sendBaselineRef.current = null;
    if (!enabled) return;

    if (activeHistorySessionId) {
      callbacksRef.current.markHistorySessionRead(activeHistorySessionId);
    }

    const receipt = callbacksRef.current.consumePersistReceipt();

    // A turn on a fresh (non-resumed) thread has no baseline to advance and
    // nothing to conflict with. It DOES need the rail refresh: this is the turn
    // that created the row, so the refresh is how the surface learns its id.
    if (!baseline) {
      callbacksRef.current.refreshAfterStream();
      return;
    }

    // The rail refresh is deliberately NOT fired before the outcome is known,
    // and on two outcomes not at all. It resolves asynchronously and writes
    // whatever version it read into the baseline, which is wrong twice over:
    //
    //  - on a `conflict` it races the fork and reattaches the very thread the
    //    detach just left, restoring its version onto the new one;
    //  - on a `saved`/`duplicate` the receipt already carries the authoritative
    //    version — the one the ingest just committed — while a detail read can
    //    still be serving the pre-ingest value. Letting it land would DOWNGRADE
    //    the baseline, so the next send would carry a stale `expectedVersion`,
    //    take a false 409, and detach a thread nobody else ever touched. That
    //    is the exact failure this whole change exists to remove.
    //
    // The reactive session subscription re-enables once the stream ends and
    // keeps the rail current on both paths, so nothing is lost by skipping it.
    const skipRailRefresh =
      receipt?.outcome === "conflict" ||
      receipt?.outcome === "saved" ||
      receipt?.outcome === "duplicate";
    if (!skipRailRefresh) {
      // Every remaining outcome is one where the server's own copy is the best
      // evidence available, so the refresh is wanted.
      callbacksRef.current.refreshAfterStream();
    }

    if (!receipt) {
      // Deploy skew: a new client bundle against an inspector server that does
      // not emit receipts yet. Reconcile instead of guessing, and never detach.
      startReconcile(
        baseline.sessionId,
        baseline.version,
        NO_RECEIPT_RECONCILE_WINDOW_MS
      );
      return;
    }

    switch (receipt.outcome) {
      case "saved":
      case "duplicate":
        // Advance the baseline so the NEXT send's `expectedVersion` is right.
        if (typeof receipt.version === "number") {
          callbacksRef.current.syncResumedVersion(receipt.version);
        }
        return;
      case "conflict":
        // The only positive evidence of a real concurrent writer, and so the
        // only path that costs the user their thread.
        callbacksRef.current.onConflict();
        return;
      case "skipped":
      case "failed":
        // Ambiguous: a timed-out ingest may still have committed. Stay
        // attached and let the subscription settle it.
        startReconcile(
          baseline.sessionId,
          baseline.version,
          RECEIPT_RECONCILE_WINDOW_MS
        );
        return;
    }
  }, [enabled, status, activeHistorySessionId, resumedVersion, startReconcile]);

  // Reconciliation watcher. Runs on every subscription update and on its own
  // deadline timer.
  useEffect(() => {
    const pending = pendingReconcileRef.current;
    if (!pending || !enabled) return;

    if (
      typeof reactiveSessionVersion === "number" &&
      reactiveSessionVersion > pending.baselineVersion
    ) {
      // The write landed after all. Sync the baseline and say nothing — even if
      // we already warned, a late-landing commit must still update the cursor
      // or the next send carries a stale `expectedVersion` and 409s.
      pendingReconcileRef.current = null;
      callbacksRef.current.syncResumedVersion(reactiveSessionVersion);
      return;
    }

    const remainingMs = pending.deadlineAt - Date.now();
    if (remainingMs > 0) {
      const timerId = window.setTimeout(wakeReconcileWatcher, remainingMs);
      return () => window.clearTimeout(timerId);
    }

    if (!pending.notified) {
      // Deadline passed with no version bump. Now — and only now — say the
      // reply is not in history. The thread stays attached: the user's messages
      // are still on screen, and forcing a new thread would lose more than it
      // fixes.
      pending.notified = true;
      callbacksRef.current.onUnsaved();
    }
    // Deliberately keeps watching after notifying, so a commit that lands late
    // still syncs the baseline.
  }, [enabled, reactiveSessionVersion, reconcileTick, wakeReconcileWatcher]);

  // A thread switch makes any outstanding question moot — it was about a
  // session this surface is no longer on. Same for the rail being turned off:
  // an inactive surface must not surface a warning about a thread it is no
  // longer showing.
  useEffect(() => {
    pendingReconcileRef.current = null;
  }, [activeHistorySessionId, enabled]);
}
