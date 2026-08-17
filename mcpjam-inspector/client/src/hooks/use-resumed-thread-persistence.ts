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
  /**
   * Watch for a late commit but never tell the user about its absence.
   *
   * Set for a withdrawn turn, where a missing write is the intended outcome and
   * a warning would be nonsense — but the version still has to be picked up if
   * the server committed anyway, or the next send carries a stale
   * `expectedVersion` into a false conflict.
   */
  silent: boolean;
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
   * Take whether the turn that just ended was ABORTED — the user pressed Stop,
   * or the active response was aborted some other way.
   *
   * Needed because the AI SDK has no "aborted" status: on abort it sets
   * `status: "ready"` and returns (ai/dist/index.mjs, `makeRequest`'s catch:
   * `if (isAbort || err.name === "AbortError") { this.setStatus({ status:
   * "ready" }); return null; }`). A stopped turn therefore reaches the
   * end-of-stream path below looking exactly like a completed one.
   */
  consumeTurnAborted: () => boolean;
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
    consumeTurnAborted,
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
    consumeTurnAborted,
    syncResumedVersion,
    markHistorySessionRead,
    refreshAfterStream,
    onConflict,
    onUnsaved,
  });
  callbacksRef.current = {
    consumePersistReceipt,
    consumeTurnAborted,
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
    (
      sessionId: string,
      baselineVersion: number,
      windowMs: number,
      options?: { silent?: boolean }
    ) => {
      pendingReconcileRef.current = {
        sessionId,
        baselineVersion,
        deadlineAt: Date.now() + windowMs,
        notified: false,
        silent: options?.silent ?? false,
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

    // Both consumed BEFORE the abort check, because an abort can race a receipt
    // that already arrived. The server writes the receipt once the ingest has
    // committed and before it closes the stream, so a Stop pressed inside that
    // window reports `isAbort: true` for a turn the server has already saved —
    // and the persist can hold the stream open for seconds, which is exactly
    // when a user reaches for Stop. Discarding that receipt would strand
    // `resumedVersion` on its pre-turn value, and the next send would carry a
    // stale `expectedVersion` into a false conflict: the bug this hook exists
    // to remove.
    const aborted = callbacksRef.current.consumeTurnAborted();
    const receipt = callbacksRef.current.consumePersistReceipt();
    // Only a receipt that PROVES a write outlives the abort. `saved`/`duplicate`
    // carry the authoritative new version, so they fall through and are handled
    // exactly as they would be on a turn nobody stopped.
    const receiptProvesWrite =
      receipt?.outcome === "saved" || receipt?.outcome === "duplicate";

    // The user stopped the turn and nothing was committed. There is nothing to
    // reconcile: the server persists only `runSucceeded && !aborted`
    // (`server/utils/mcpjam-stream-handler.ts`, `onFinishEngine`), so such a
    // turn produces no receipt AND no version bump — the exact signature this
    // hook otherwise reads as a dropped write. Left to run, the no-receipt
    // branch would watch the subscription for its full 10 s and then tell the
    // user their reply "couldn't be saved", which is a false alarm about a
    // deliberate action: not saving a withdrawn turn IS the intended outcome.
    //
    // A `failed`, `skipped`, or `conflict` receipt is suppressed here too: the
    // turn was withdrawn, so there is no reply to warn about and none to fork
    // away from. A real conflict has not been lost — the session is still
    // ahead, so the next send reports it with a reply actually worth saving.
    if (aborted && !receiptProvesWrite) {
      // Belt and braces — the stream-start branch above already cleared it for
      // this turn. Keeping it here makes the abort path a complete no-op on its
      // own rather than one that depends on a sibling branch.
      pendingReconcileRef.current = null;

      // "Aborted" does NOT prove nothing was written. The server checks
      // `runSucceeded && !aborted` once, then awaits the ingest — so a Stop
      // landing after that check still lets the commit through, while
      // cancelling the response prevents its receipt from ever reaching us.
      // The write is real and this client cannot see it.
      //
      // So the version is still reconciled, just silently: a bump gets picked
      // up (otherwise the next send carries a stale `expectedVersion` into the
      // false conflict this hook exists to remove), and its absence is never
      // reported, because not saving a withdrawn turn is the intended outcome.
      if (baseline) {
        startReconcile(
          baseline.sessionId,
          baseline.version,
          NO_RECEIPT_RECONCILE_WINDOW_MS,
          { silent: true }
        );
        return;
      }

      // No baseline: a fresh thread, where there is no version to reconcile but
      // there may now be a ROW this surface has never seen. The rail refresh is
      // how it learns that row's id, and it is silent either way — it reads.
      callbacksRef.current.refreshAfterStream();
      return;
    }

    if (activeHistorySessionId) {
      callbacksRef.current.markHistorySessionRead(activeHistorySessionId);
    }

    // A turn on a fresh (non-resumed) thread has no baseline to advance. It DOES
    // need the rail refresh: this is the turn that created the row, so the
    // refresh is how the surface learns its id.
    //
    // A null baseline does not guarantee a null conflict, though — and the case
    // that matters is NOT the deliberate session changes (new chat, archive-all,
    // reset, a rewind's `onBeforeBranch`) this guard used to cite. Every one of
    // those also mints a new `chatSessionId`, so `consumePersistReceipt` rejects
    // the turn's receipt outright and this branch sees `null`; it never observes
    // a conflict on that path at all.
    //
    // The path it does observe is a FAILED DETACH. `detachToLocalFork` could not
    // confirm its fork went live, so the surface stayed on the OLD
    // `chatSessionId` with `resumedVersion` deliberately preserved, while
    // `cancelPendingHistorySelection` nulled `activeHistorySessionId` — which is
    // what leaves the baseline null here. Every later send then carries the stale
    // `expectedVersion`, the server 409s, and the `conflict` receipt names the
    // still-live old session, so it passes validation and lands right here.
    // Swallowing it lost that turn, and every turn after it, in silence.
    //
    // So a conflict is routed to `onConflict()` even with no baseline. The
    // surfaces implement it as a detach, which re-attempts the fork: on success
    // the user moves to a fresh thread and the loop is broken, and on failure
    // they at least get the fork-failed notice again instead of nothing.
    //
    // This is NOT the immediate re-mint `detachToLocalFork` deliberately refuses.
    // That one fires inside the failed detach itself, where the second
    // `queueSessionHydration` would clear a `loadChatSession` still resolving and
    // yank the user out of the thread they just clicked. This fires at the next
    // turn boundary — a whole request and stream later — by which point any
    // hydration that superseded the fork has long since committed.
    //
    // The rail refresh stays suppressed on that path: it resolves asynchronously
    // and could reattach the very session the detach is leaving.
    if (!baseline) {
      if (receipt?.outcome === "conflict") {
        callbacksRef.current.onConflict();
        return;
      }
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

    if (!pending.notified && !pending.silent) {
      // Deadline passed with no version bump. Now — and only now — say the
      // reply is not in history. The thread stays attached: the user's messages
      // are still on screen, and forcing a new thread would lose more than it
      // fixes.
      //
      // A silent watch skips this entirely: it belongs to a turn the user
      // withdrew, so an unsaved reply is the expected result, not news.
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
