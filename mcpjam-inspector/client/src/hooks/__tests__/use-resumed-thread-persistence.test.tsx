import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useResumedThreadPersistence,
  type ResumedThreadStreamStatus,
} from "../use-resumed-thread-persistence";
import type { PersistReceiptData } from "@/shared/persist-receipt";

/**
 * The shared post-stream brain both chat surfaces now run. Its whole reason to
 * exist is that the old REST version poll could not distinguish "the save
 * failed" from "someone else edited this thread", and reported the far commoner
 * first case as the second — costing users their thread every few messages.
 *
 * So the invariant these tests defend is narrow and absolute: a detach happens
 * ONLY on an explicit conflict. Silence, a failure, and a dropped write all keep
 * the thread attached.
 */
describe("useResumedThreadPersistence", () => {
  const SESSION_ID = "history-1";

  function setup(overrides?: {
    receipt?: PersistReceiptData | null;
    resumedVersion?: number | null;
    enabled?: boolean;
    /** The turn was stopped by the user (the AI SDK reports it as `ready`). */
    aborted?: boolean;
  }) {
    const sendBaselineRef = createRef<{
      sessionId: string;
      version: number;
    } | null>() as React.MutableRefObject<{
      sessionId: string;
      version: number;
    } | null>;
    sendBaselineRef.current = null;

    const consumePersistReceipt = vi.fn(() => overrides?.receipt ?? null);
    // Consuming, exactly like `useChatSession`'s: the answer describes one
    // turn, so reading it takes it. That is what keeps a stopped turn from
    // silencing the turn after it.
    let turnAborted = overrides?.aborted ?? false;
    const consumeTurnAborted = vi.fn(() => {
      const value = turnAborted;
      turnAborted = false;
      return value;
    });
    const syncResumedVersion = vi.fn();
    const markHistorySessionRead = vi.fn();
    const refreshAfterStream = vi.fn();
    const onConflict = vi.fn();
    const onUnsaved = vi.fn();

    const props = {
      sendBaselineRef,
      enabled: overrides?.enabled ?? true,
      status: "ready" as ResumedThreadStreamStatus,
      activeHistorySessionId: SESSION_ID as string | null,
      resumedVersion:
        overrides?.resumedVersion === undefined ? 4 : overrides.resumedVersion,
      consumePersistReceipt:
        consumePersistReceipt as unknown as () => PersistReceiptData | null,
      consumeTurnAborted,
      reactiveSessionVersion: undefined as number | null | undefined,
      syncResumedVersion,
      markHistorySessionRead,
      refreshAfterStream,
      onConflict,
      onUnsaved,
    };

    const view = renderHook(
      (p: typeof props) => useResumedThreadPersistence(p),
      { initialProps: props }
    );

    /** Drive a full turn: ready → submitted → streaming → ready. */
    const runTurn = (next?: Partial<typeof props>) => {
      act(() => view.rerender({ ...props, ...next, status: "submitted" }));
      act(() => view.rerender({ ...props, ...next, status: "streaming" }));
      act(() => view.rerender({ ...props, ...next, status: "ready" }));
    };

    return {
      view,
      props,
      runTurn,
      sendBaselineRef,
      consumePersistReceipt,
      consumeTurnAborted,
      syncResumedVersion,
      markHistorySessionRead,
      refreshAfterStream,
      onConflict,
      onUnsaved,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures the baseline at stream start and consumes it at stream end", () => {
    const harness = setup({
      receipt: { outcome: "saved", chatSessionId: "c", version: 5 },
    });

    act(() => harness.view.rerender({ ...harness.props, status: "submitted" }));
    expect(harness.sendBaselineRef.current).toEqual({
      sessionId: SESSION_ID,
      version: 4,
    });

    act(() => harness.view.rerender({ ...harness.props, status: "ready" }));
    expect(harness.sendBaselineRef.current).toBeNull();
  });

  it("does not consume the baseline on the submitted → streaming transition", () => {
    // Consuming here would leave it null when the stream actually ends, and the
    // outcome would then be evaluated against nothing.
    const harness = setup();

    act(() => harness.view.rerender({ ...harness.props, status: "submitted" }));
    act(() => harness.view.rerender({ ...harness.props, status: "streaming" }));

    expect(harness.sendBaselineRef.current).not.toBeNull();
  });

  it("advances the baseline from a saved receipt", () => {
    const harness = setup({
      receipt: { outcome: "saved", chatSessionId: "c", version: 5 },
    });

    harness.runTurn();

    expect(harness.syncResumedVersion).toHaveBeenCalledWith(5);
    expect(harness.onConflict).not.toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.markHistorySessionRead).toHaveBeenCalledWith(SESSION_ID);
  });

  it("treats a duplicate receipt exactly like a save", () => {
    const harness = setup({
      receipt: { outcome: "duplicate", chatSessionId: "c", version: 7 },
    });

    harness.runTurn();

    expect(harness.syncResumedVersion).toHaveBeenCalledWith(7);
    expect(harness.onConflict).not.toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("detaches on a conflict — the one case with positive evidence", () => {
    const harness = setup({
      receipt: { outcome: "conflict", chatSessionId: "c", currentVersion: 9 },
    });

    harness.runTurn();

    expect(harness.onConflict).toHaveBeenCalledTimes(1);
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("waits before calling a failed receipt unsaved, then says so without detaching", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();

    // A timed-out ingest may still have committed, so the failure alone is not
    // enough to tell the user anything.
    expect(harness.onUnsaved).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3_100);
    });

    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("treats a skipped receipt the same as a failure — never a detach", () => {
    const harness = setup({
      receipt: { outcome: "skipped", chatSessionId: "c", version: 4 },
    });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(3_100);
    });

    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("reconciles a failed receipt to saved when the version advances in time", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() =>
      harness.view.rerender({
        ...harness.props,
        status: "ready",
        reactiveSessionVersion: 5,
      })
    );

    expect(harness.syncResumedVersion).toHaveBeenCalledWith(5);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("still syncs a commit that lands AFTER the user was warned", () => {
    // Otherwise the next send carries a stale expectedVersion and 409s — the
    // warning would manufacture the conflict it was warning about.
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);

    act(() =>
      harness.view.rerender({
        ...harness.props,
        status: "ready",
        reactiveSessionVersion: 6,
      })
    );

    expect(harness.syncResumedVersion).toHaveBeenCalledWith(6);
    // And it does not scold the user twice for the same turn.
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
  });

  it("ignores a version that has not passed the baseline", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() =>
      harness.view.rerender({
        ...harness.props,
        status: "ready",
        reactiveSessionVersion: 4,
      })
    );

    expect(harness.syncResumedVersion).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
  });

  it("gives a receipt-less turn a longer window before giving up", () => {
    // Deploy skew: a new client bundle against a server that predates the
    // receipt part. Never auto-detach on silence.
    const harness = setup({ receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(harness.onUnsaved).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(7_100);
    });
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("does nothing on a fresh thread beyond refreshing the rail", () => {
    const harness = setup({ resumedVersion: null, receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.refreshAfterStream).toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("drops the baseline on a failed turn", () => {
    const harness = setup();

    act(() => harness.view.rerender({ ...harness.props, status: "submitted" }));
    act(() => harness.view.rerender({ ...harness.props, status: "error" }));

    expect(harness.sendBaselineRef.current).toBeNull();
    expect(harness.onConflict).not.toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("abandons an outstanding reconciliation when the user switches threads", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() =>
      harness.view.rerender({
        ...harness.props,
        status: "ready",
        activeHistorySessionId: "history-2",
      })
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    // The question was about a thread this surface has left.
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("abandons an outstanding reconciliation when the next turn starts", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() => harness.view.rerender({ ...harness.props, status: "submitted" }));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("does NOT refresh the rail on a conflict", () => {
    // The refresh resolves asynchronously and writes back the session id and
    // version it fetched. Firing it alongside a detach races the fork and can
    // reattach the very thread we just left, restoring its version onto the new
    // one.
    const harness = setup({
      receipt: { outcome: "conflict", chatSessionId: "c", currentVersion: 9 },
    });

    harness.runTurn();

    expect(harness.onConflict).toHaveBeenCalledTimes(1);
    expect(harness.refreshAfterStream).not.toHaveBeenCalled();
  });

  it("does NOT refresh the rail on a saved or duplicate receipt", () => {
    // The receipt carries the version the ingest just committed; a detail read
    // can still be serving the pre-ingest one, and it writes whatever it reads
    // into the baseline. Letting it land would downgrade the baseline, so the
    // next send would take a false 409 and detach a thread nobody touched.
    for (const receipt of [
      { outcome: "saved" as const, chatSessionId: "c", version: 5 },
      { outcome: "duplicate" as const, chatSessionId: "c", version: 5 },
    ]) {
      const harness = setup({ receipt });
      harness.runTurn();
      expect(harness.syncResumedVersion).toHaveBeenCalledWith(5);
      expect(harness.refreshAfterStream).not.toHaveBeenCalled();
    }
  });

  it("refreshes the rail when the server's own copy is the best evidence", () => {
    for (const receipt of [
      { outcome: "skipped" as const, chatSessionId: "c", version: 4 },
      { outcome: "failed" as const, chatSessionId: "c" },
      null,
    ]) {
      const harness = setup({ receipt });
      harness.runTurn();
      expect(harness.refreshAfterStream).toHaveBeenCalled();
    }
  });

  it("skips the rail refresh on a conflict even with no baseline", () => {
    // The baseline is also cleared mid-stream by deliberate session changes, so
    // a null baseline does not mean the turn cannot conflict. Refreshing then
    // could reattach the session the surface just left.
    const harness = setup({
      resumedVersion: null,
      receipt: { outcome: "conflict", chatSessionId: "c", currentVersion: 9 },
    });

    harness.runTurn();

    expect(harness.refreshAfterStream).not.toHaveBeenCalled();
  });

  it("detaches on a conflict with no baseline — the failed-detach loop", () => {
    // The production sequence. `detachToLocalFork` could not confirm its fork
    // went live, so the surface stayed on the OLD chat session with
    // `resumedVersion` preserved while `cancelPendingHistorySelection` nulled
    // `activeHistorySessionId` — which is what makes the baseline null here.
    // The next send carries the stale `expectedVersion`, the server 409s, and
    // the receipt names the still-live old session, so it passes
    // `consumePersistReceipt` and lands in the no-baseline branch. That branch
    // used to return silently, losing this turn and every turn after it.
    const harness = setup({
      receipt: { outcome: "conflict", chatSessionId: "c", currentVersion: 9 },
    });
    const detached = { ...harness.props, activeHistorySessionId: null };

    act(() => harness.view.rerender({ ...detached, status: "submitted" }));
    expect(harness.sendBaselineRef.current).toBeNull();
    act(() => harness.view.rerender({ ...detached, status: "streaming" }));
    act(() => harness.view.rerender({ ...detached, status: "ready" }));

    expect(harness.onConflict).toHaveBeenCalledTimes(1);
    // Still suppressed: the refresh would reattach the thread being left.
    expect(harness.refreshAfterStream).not.toHaveBeenCalled();
  });

  it("does not detach a baseline-less turn on any other outcome", () => {
    // A fresh, non-resumed thread has no baseline by design. Only positive
    // evidence of a concurrent writer may cost the user their thread.
    for (const receipt of [
      { outcome: "saved" as const, chatSessionId: "c", version: 5 },
      { outcome: "skipped" as const, chatSessionId: "c", version: 4 },
      { outcome: "failed" as const, chatSessionId: "c" },
      null,
    ]) {
      const harness = setup({ resumedVersion: null, receipt });

      harness.runTurn();
      act(() => {
        vi.advanceTimersByTime(11_000);
      });

      expect(harness.onConflict).not.toHaveBeenCalled();
      expect(harness.onUnsaved).not.toHaveBeenCalled();
      expect(harness.refreshAfterStream).toHaveBeenCalled();
    }
  });

  it("refreshes the rail for a fresh thread — that is how it learns the new row", () => {
    const harness = setup({ resumedVersion: null, receipt: null });
    harness.runTurn();
    expect(harness.refreshAfterStream).toHaveBeenCalled();
  });

  it("drops a pending reconciliation when the rail is disabled mid-flight", () => {
    const harness = setup({
      receipt: {
        outcome: "failed",
        chatSessionId: "c",
        failureKind: "timeout",
      },
    });

    harness.runTurn();
    act(() =>
      harness.view.rerender({
        ...harness.props,
        status: "ready",
        enabled: false,
      })
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    // An inactive surface must not warn about a thread it no longer shows.
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("says nothing when the user stops the turn", () => {
    // Stop is the one end-of-stream that legitimately saves nothing: the server
    // persists only `runSucceeded && !aborted`, so no receipt arrives and the
    // session version never moves. That is byte-for-byte the silence a dropped
    // write produces, so without an explicit abort signal this turn runs the
    // full no-receipt window and then calls a deliberate cancel a failure.
    const harness = setup({ aborted: true, receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.onConflict).not.toHaveBeenCalled();
    expect(harness.syncResumedVersion).not.toHaveBeenCalled();
    // Nothing was written, so the rail has nothing new to learn and the row's
    // unread state is exactly as the server left it.
    expect(harness.refreshAfterStream).not.toHaveBeenCalled();
    expect(harness.markHistorySessionRead).not.toHaveBeenCalled();
  });

  it("still warns on a receipt-less turn the user did NOT stop", () => {
    // The control for the case above: silence is only forgivable when we know
    // why it is silent.
    const harness = setup({ aborted: false, receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.consumeTurnAborted).toHaveBeenCalled();
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
  });

  it("does not carry a stopped turn into the next one", () => {
    const harness = setup({ aborted: true, receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(harness.onUnsaved).not.toHaveBeenCalled();

    // Nobody stopped this one, so its silence is a real dropped write and must
    // still be reported.
    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(harness.onUnsaved).toHaveBeenCalledTimes(1);
  });

  it("honors a saved receipt that wins the race against the stop", () => {
    // The server writes the receipt once the ingest has committed and before it
    // closes the stream, so a Stop pressed in that window reports an abort for a
    // turn that WAS saved. Discarding the receipt would strand `resumedVersion`
    // on its pre-turn value and send the next turn into a false conflict.
    const harness = setup({
      aborted: true,
      receipt: { outcome: "saved", chatSessionId: "c", version: 5 },
    });

    harness.runTurn();

    expect(harness.consumePersistReceipt).toHaveBeenCalledTimes(1);
    expect(harness.syncResumedVersion).toHaveBeenCalledWith(5);
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("still says nothing when a stopped turn's receipt reports no write", () => {
    // The complement: only a receipt that PROVES a write outlives the abort.
    // A withdrawn turn has no reply to warn about, so `failed` stays silent —
    // and the receipt is still consumed so it cannot leak into the next turn.
    const harness = setup({
      aborted: true,
      receipt: { outcome: "failed", chatSessionId: "c" },
    });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.consumePersistReceipt).toHaveBeenCalledTimes(1);
    expect(harness.syncResumedVersion).not.toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("still refreshes the rail for a stopped turn on a fresh thread", () => {
    // A stop does not prove nothing was written: the server checks
    // `runSucceeded && !aborted` once and then awaits the ingest, so a Stop
    // landing after that check still lets the commit through. On a fresh thread
    // that means a ROW may now exist which this surface has never seen, and the
    // refresh is how it learns the id. It reads, so it stays silent either way.
    const harness = setup({
      resumedVersion: null,
      aborted: true,
      receipt: null,
    });

    harness.runTurn();

    expect(harness.refreshAfterStream).toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("silently picks up a version a stopped turn committed anyway", () => {
    // Same race, resumed thread: the commit landed but cancelling the response
    // kept its receipt from ever arriving. Without reconciliation
    // `resumedVersion` stays stale and the NEXT send carries a stale
    // `expectedVersion` into the false conflict this hook exists to remove.
    const harness = setup({ aborted: true, receipt: null });

    harness.runTurn();
    act(() => {
      harness.view.rerender({ ...harness.props, reactiveSessionVersion: 5 });
    });

    expect(harness.syncResumedVersion).toHaveBeenCalledWith(5);
    expect(harness.onUnsaved).not.toHaveBeenCalled();
  });

  it("never reports a stopped turn as unsaved when no version arrives", () => {
    // The other half of silence: the watch runs its full window and says
    // nothing, because an unsaved reply is the intended outcome of a stop.
    const harness = setup({ aborted: true, receipt: null });

    harness.runTurn();
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.syncResumedVersion).not.toHaveBeenCalled();
  });

  it("ignores a stop pressed while nothing is streaming", () => {
    const harness = setup({ aborted: true, receipt: null });

    // No turn ran, so there is no stream transition to react to and nothing
    // consumes the flag — it simply waits for a turn that never happened.
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(harness.consumeTurnAborted).not.toHaveBeenCalled();
    expect(harness.onUnsaved).not.toHaveBeenCalled();
    expect(harness.onConflict).not.toHaveBeenCalled();
  });

  it("stays inert when disabled", () => {
    const harness = setup({
      enabled: false,
      receipt: { outcome: "conflict", chatSessionId: "c" },
    });

    harness.runTurn();

    expect(harness.onConflict).not.toHaveBeenCalled();
    expect(harness.refreshAfterStream).not.toHaveBeenCalled();
    expect(harness.markHistorySessionRead).not.toHaveBeenCalled();
  });
});
