import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { ConvexError } from "convex/values";

import { useChatboxTurnRating } from "../useChatboxTurnRating";

const mockSubmitScore = vi.fn();
const mockUseQuery = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "sessionScores:submitScore") return mockSubmitScore;
    throw new Error(`Unexpected mutation: ${name}`);
  },
  useQuery: (name: string, args: unknown) => mockUseQuery(name, args),
}));

const CHAT_SESSION_ID = "chat-session-1";
const TURN_ID = "turn-abc";

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function staleError() {
  return new ConvexError({
    code: "chatbox_access_stale",
    message: "stale",
    currentAccessVersion: 2,
  });
}

describe("useChatboxTurnRating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue(undefined);
    mockSubmitScore.mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits without a promptIndex — the server derives it from the turn trace", async () => {
    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 4,
      });
    });
    await flushMicrotasks();

    expect(mockSubmitScore).toHaveBeenCalledWith({
      chatboxId: "cbx_1",
      accessVersion: 1,
      chatSessionId: CHAT_SESSION_ID,
      turnId: TURN_ID,
      key: "user_rating",
      value: 4,
    });
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 4,
      status: "submitted",
    });
  });

  it("does not report submitted on not_ready", async () => {
    // `not_ready` means the ingest race hasn't resolved. Rendering "submitted"
    // would tell a tester their words were saved when no row exists.
    vi.useFakeTimers();
    mockSubmitScore.mockResolvedValue({ status: "not_ready" });

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 2,
      });
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "pending"
    );
  });

  it("retries not_ready with backoff and settles once the turn lands", async () => {
    vi.useFakeTimers();
    mockSubmitScore
      .mockResolvedValueOnce({ status: "not_ready" })
      .mockResolvedValue({ status: "ok" });

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 5,
      });
    });
    await flushMicrotasks();
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushMicrotasks();

    expect(mockSubmitScore).toHaveBeenCalledTimes(2);
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "submitted"
    );
  });

  it("a superseded not_ready retry never overwrites a newer rating", async () => {
    // The exact ingest-race window: rate 3★ right as the turn ends →
    // not_ready arms a retry for the OLD value; the tester revises to 5★,
    // which lands. The armed retry must self-cancel — before the generation
    // guard it would re-enter and quietly persist 3★ over the 5★.
    vi.useFakeTimers();
    mockSubmitScore
      .mockResolvedValueOnce({ status: "not_ready" })
      .mockResolvedValue({ status: "ok" });

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 3,
      });
    });
    await flushMicrotasks();
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);

    // Revision lands while the 3★ retry timer is still armed.
    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 5,
      });
    });
    await flushMicrotasks();
    expect(mockSubmitScore).toHaveBeenCalledTimes(2);
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 5,
      status: "submitted",
    });

    // Burn through every backoff tier: the superseded retry must neither hit
    // the server nor touch the key's state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushMicrotasks();

    expect(mockSubmitScore).toHaveBeenCalledTimes(2);
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 5,
      status: "submitted",
    });
    const values = mockSubmitScore.mock.calls.map(
      (call) => (call[0] as { value: number }).value
    );
    expect(values).toEqual([3, 5]);
  });

  it("a fresh click stands down a superseded stale-queue entry", async () => {
    // Rating A hits stale access and queues; before the redeem lands the
    // tester revises and the new submission succeeds. The queued A is now
    // superseded — the stale backoff must stop re-asking for a redeem the
    // newer submission proved unnecessary, not keep firing over a queue
    // entry whose generation guard would discard it anyway.
    vi.useFakeTimers();
    mockSubmitScore
      .mockRejectedValueOnce(staleError())
      .mockResolvedValue({ status: "ok" });
    const onStaleHostedAccess = vi.fn();

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
        onStaleHostedAccess,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 2,
      });
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 5,
      });
    });
    await flushMicrotasks();
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 5,
      status: "submitted",
    });

    // Burn every stale-backoff tier: the timer must find an empty queue and
    // stand down instead of re-asking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    await flushMicrotasks();

    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 5,
      status: "submitted",
    });
  });

  it("queues on stale access, asks for a re-redeem, and replays on the new version", async () => {
    mockSubmitScore.mockRejectedValueOnce(staleError());
    const onStaleHostedAccess = vi.fn();

    const { result, rerender } = renderHook(
      (props: { accessVersion: number }) =>
        useChatboxTurnRating({
          enabled: true,
          chatboxId: "cbx_1",
          accessVersion: props.accessVersion,
          onStaleHostedAccess,
        }),
      { initialProps: { accessVersion: 1 } }
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 1,
      });
    });
    await flushMicrotasks();

    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);
    // Still in flight, not failed — the rating is queued, not lost.
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "pending"
    );
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);

    mockSubmitScore.mockResolvedValue({ status: "ok" });
    rerender({ accessVersion: 2 });
    await flushMicrotasks();

    expect(mockSubmitScore).toHaveBeenCalledTimes(2);
    expect(mockSubmitScore).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessVersion: 2, value: 1 })
    );
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "submitted"
    );
  });

  it("reports an error for a rejection that is not a stale-access one", async () => {
    mockSubmitScore.mockRejectedValue(
      new ConvexError({ code: "score_value_out_of_range", message: "nope" })
    );

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 9,
      });
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "error"
    );
  });

  it("rehydrates stored stars once the session is observed", async () => {
    mockUseQuery.mockReturnValue([
      { turnId: TURN_ID, value: 3, comment: "meh" },
    ]);

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    // The query is skipped until the widget reports which session is on
    // screen — the id is minted inside ChatTabV2, not passed down.
    expect(mockUseQuery).toHaveBeenLastCalledWith(
      "sessionScores:listMySessionScores",
      "skip"
    );

    act(() => {
      result.current.observeChatSession(CHAT_SESSION_ID);
    });

    expect(mockUseQuery).toHaveBeenLastCalledWith(
      "sessionScores:listMySessionScores",
      { chatboxId: "cbx_1", accessVersion: 1, chatSessionId: CHAT_SESSION_ID }
    );
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toEqual({
      value: 3,
      comment: "meh",
      status: "submitted",
    });
  });

  it("gives up visibly after the not_ready retry budget is spent", async () => {
    // The bound exists so a turn that never lands does not spin forever. The
    // terminal state has to be `error` — `pending` would keep claiming the
    // rating is in flight.
    vi.useFakeTimers();
    mockSubmitScore.mockResolvedValue({ status: "not_ready" });

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 3,
      });
    });
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "error"
    );
    const callsAtGiveUp = mockSubmitScore.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mockSubmitScore).toHaveBeenCalledTimes(callsAtGiveUp);
  });

  it("stays inert while the hosted identity has not resolved", async () => {
    // `enabled` is the config gate; a missing chatboxId is the not-yet-redeemed
    // gate. Both must keep the query skipped and the mutation unsent.
    const { result } = renderHook(() =>
      useChatboxTurnRating({ enabled: true, chatboxId: undefined })
    );

    act(() => {
      result.current.observeChatSession(CHAT_SESSION_ID);
    });
    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 4,
      });
    });
    await flushMicrotasks();

    expect(mockSubmitScore).not.toHaveBeenCalled();
    expect(mockUseQuery).toHaveBeenLastCalledWith(
      "sessionScores:listMySessionScores",
      "skip"
    );
  });

  it("replays when identity returns on the SAME accessVersion", async () => {
    // A blip where chatboxId goes missing and comes back unchanged would never
    // re-run a replay effect keyed only on accessVersion — the rating would sit
    // in `pending` forever.
    mockSubmitScore.mockRejectedValueOnce(staleError());

    const { result, rerender } = renderHook(
      (props: { chatboxId: string | undefined }) =>
        useChatboxTurnRating({
          enabled: true,
          chatboxId: props.chatboxId,
          accessVersion: 1,
          onStaleHostedAccess: () => {},
        }),
      { initialProps: { chatboxId: "cbx_1" as string | undefined } }
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 2,
      });
    });
    await flushMicrotasks();
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);

    mockSubmitScore.mockResolvedValue({ status: "ok" });
    // Identity drops and returns — accessVersion never moves.
    rerender({ chatboxId: undefined });
    await flushMicrotasks();
    rerender({ chatboxId: "cbx_1" });
    await flushMicrotasks();

    expect(mockSubmitScore).toHaveBeenCalledTimes(2);
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "submitted"
    );
  });

  it("clears state for a retry dropped by a chatbox switch", async () => {
    // Dropping the retry is right — the rating is for a conversation no longer
    // on screen — but leaving the key on `pending` would show a permanent
    // spinner if the tester navigated back.
    vi.useFakeTimers();
    mockSubmitScore.mockResolvedValue({ status: "not_ready" });

    const { result, rerender } = renderHook(
      (props: { chatboxId: string }) =>
        useChatboxTurnRating({
          enabled: true,
          chatboxId: props.chatboxId,
          accessVersion: 1,
        }),
      { initialProps: { chatboxId: "cbx_1" } }
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 3,
      });
    });
    await flushMicrotasks();
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "pending"
    );

    rerender({ chatboxId: "cbx_2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "idle"
    );
  });

  it("keeps a rehydrated comment when the first action is a star change", async () => {
    // The optimistic map is empty on that first click, so the merge has to
    // reach past it to what the server already reported.
    mockUseQuery.mockReturnValue([
      { turnId: TURN_ID, value: 2, comment: "lost my order" },
    ]);

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.observeChatSession(CHAT_SESSION_ID);
    });
    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 5,
      });
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 5,
      comment: "lost my order",
    });
  });

  it("survives StrictMode's mount → cleanup → mount cycle", async () => {
    // A cleanup-only `unmountedRef` write latches true on the synthetic
    // teardown and never clears, silently disabling every unmount guard — in
    // development only, which is the worst place for it to hide.
    vi.useFakeTimers();
    mockSubmitScore.mockRejectedValue(staleError());
    const onStaleHostedAccess = vi.fn();

    const { result } = renderHook(
      () =>
        useChatboxTurnRating({
          enabled: true,
          chatboxId: "cbx_1",
          accessVersion: 1,
          onStaleHostedAccess,
        }),
      { wrapper: StrictMode }
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 1,
      });
    });
    await flushMicrotasks();

    // Recovery still runs: the direct ask fires, and the backoff re-arms.
    expect(onStaleHostedAccess).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not re-ask for a redeem after unmount", async () => {
    // A mutation can reject after the page is gone; the rejection handler must
    // not re-arm timers or ask for a redeem for a chat nobody is looking at.
    vi.useFakeTimers();
    let rejectWrite: ((reason: unknown) => void) | undefined;
    mockSubmitScore.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        })
    );
    const onStaleHostedAccess = vi.fn();

    const { result, unmount } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
        onStaleHostedAccess,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 1,
      });
    });
    await flushMicrotasks();

    unmount();
    rejectWrite?.(staleError());
    await flushMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });

    // Zero, not "at most one": the direct ask in the catch block is just as
    // wrong as a re-armed timer once the page is gone.
    expect(onStaleHostedAccess).not.toHaveBeenCalled();
  });

  it("drops a queued retry once the active chatbox changes", async () => {
    // A retry that fires after a chatbox switch would submit the old session
    // and turn under the new chatbox's credentials. The server rejects that,
    // but spending a round-trip and surfacing an error for a rating no longer
    // on screen is worse than dropping it.
    vi.useFakeTimers();
    mockSubmitScore.mockResolvedValue({ status: "not_ready" });

    const { result, rerender } = renderHook(
      (props: { chatboxId: string }) =>
        useChatboxTurnRating({
          enabled: true,
          chatboxId: props.chatboxId,
          accessVersion: 1,
        }),
      { initialProps: { chatboxId: "cbx_1" } }
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 3,
      });
    });
    await flushMicrotasks();
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);

    rerender({ chatboxId: "cbx_2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushMicrotasks();

    // The retry fired, saw the identity move, and stopped.
    expect(mockSubmitScore).toHaveBeenCalledTimes(1);
  });

  it("re-asks for a redeem on a backoff, then gives up visibly", async () => {
    // If the host's redeem never succeeds, `accessVersion` never advances and
    // the replay effect never fires — the rating would sit in `pending`
    // forever. An honest dead end beats a silent hang.
    vi.useFakeTimers();
    mockSubmitScore.mockRejectedValue(staleError());
    const onStaleHostedAccess = vi.fn();

    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
        onStaleHostedAccess,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 1,
      });
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);

    // Redeem keeps failing: the hook keeps asking on a growing backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess.mock.calls.length).toBeGreaterThan(1);

    // Eventually it stops asking and says so.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await flushMicrotasks();
    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID).status).toBe(
      "error"
    );
  });

  it("keeps a turn's comment when only the stars are resubmitted", async () => {
    // `comment: undefined` means "leave the stored comment alone" to the
    // mutation; the optimistic state has to say the same thing or the widget
    // blanks an annotation the server still holds.
    const { result } = renderHook(() =>
      useChatboxTurnRating({
        enabled: true,
        chatboxId: "cbx_1",
        accessVersion: 1,
      })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 2,
        comment: "lost my order",
      });
    });
    await flushMicrotasks();

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 4,
      });
    });
    await flushMicrotasks();

    expect(result.current.getState(CHAT_SESSION_ID, TURN_ID)).toMatchObject({
      value: 4,
      comment: "lost my order",
    });
  });

  it("does nothing when the surface is disabled", async () => {
    const { result } = renderHook(() =>
      useChatboxTurnRating({ enabled: false, chatboxId: "cbx_1" })
    );

    act(() => {
      result.current.submit({
        chatSessionId: CHAT_SESSION_ID,
        turnId: TURN_ID,
        value: 4,
      });
    });
    await flushMicrotasks();

    expect(mockSubmitScore).not.toHaveBeenCalled();
  });
});
