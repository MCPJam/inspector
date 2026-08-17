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
  }) {
    const sendBaselineRef = createRef<{
      sessionId: string;
      version: number;
    } | null>() as React.MutableRefObject<{
      sessionId: string;
      version: number;
    } | null>;
    sendBaselineRef.current = null;

    const consumePersistReceipt = vi.fn(
      () => overrides?.receipt ?? null
    ) as unknown as () => PersistReceiptData | null;
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
      consumePersistReceipt,
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
    expect(harness.refreshAfterStream).toHaveBeenCalled();
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

  it("refreshes the rail on every non-conflict outcome", () => {
    for (const receipt of [
      { outcome: "saved" as const, chatSessionId: "c", version: 5 },
      { outcome: "skipped" as const, chatSessionId: "c", version: 4 },
      { outcome: "failed" as const, chatSessionId: "c" },
    ]) {
      const harness = setup({ receipt });
      harness.runTurn();
      expect(harness.refreshAfterStream).toHaveBeenCalled();
    }
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
