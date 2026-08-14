import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
