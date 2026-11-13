/**
 * A submission's reviewer sign-in attempt: the newest one, read again while
 * it runs, and start, resume and cancel, each followed by a fresh read.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptIn,
  NOV_13,
  PASSWORD_SECRET,
  SCOPE,
  WAITING,
} from "@/components/readiness/__tests__/reviewer-fixtures";
import {
  IDLE_POLL_MS,
  RUNNING_POLL_MS,
  useReviewerAttempt,
} from "../use-reviewer-attempt";

const api = vi.hoisted(() => ({
  getLatestReviewerAttempt: vi.fn(),
  startReviewerAttempt: vi.fn(),
  resumeReviewerAttempt: vi.fn(),
  cancelReviewerAttempt: vi.fn(),
}));
vi.mock("@/lib/apis/reviewer-attempts-api", () => api);

/** Lets pending reads and the timers due by then run. */
const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useReviewerAttempt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is loading until the first read, then has no attempt", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(null);
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    expect(result.current.attempt).toBeUndefined();
    await settle();
    expect(result.current.attempt).toBeNull();
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledWith(
      SCOPE,
      expect.any(AbortSignal),
    );
  });

  it("reads a running attempt every few seconds and one at rest less often", async () => {
    api.getLatestReviewerAttempt
      .mockResolvedValueOnce(attemptIn("running"))
      .mockResolvedValue(WAITING);
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();
    expect(result.current.attempt?.state).toBe("running");

    await settle(RUNNING_POLL_MS);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(2);
    expect(result.current.attempt?.waitingFor?.action).toBe(
      "Finish the sign-in from the single-use link, then resume.",
    );

    // Waiting for a person: no reads at the running pace.
    await settle(RUNNING_POLL_MS);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(2);
    await settle(IDLE_POLL_MS);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(3);
  });

  it("skips a read while the tab is hidden", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(null);
    renderHook(() => useReviewerAttempt(SCOPE));
    await settle();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await settle(IDLE_POLL_MS);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
    await settle(IDLE_POLL_MS);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(2);
  });

  it("starts with the secrets' names, then reads again", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(null);
    const started = attemptIn("running", { createdAt: NOV_13 + 5 });
    api.startReviewerAttempt.mockResolvedValue(started);
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();

    api.getLatestReviewerAttempt.mockResolvedValue(started);
    await act(() =>
      result.current.start({ passwordSecretName: PASSWORD_SECRET }),
    );
    expect(api.startReviewerAttempt).toHaveBeenCalledWith(
      SCOPE,
      { passwordSecretName: PASSWORD_SECRET },
      expect.stringMatching(/^ui-reviewer-sub_1-/),
    );
    expect(result.current.attempt).toEqual(started);
    await settle();
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(2);
  });

  it("resumes and cancels the attempt by its id", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(WAITING);
    const resumed = attemptIn("running", {
      resumedAt: NOV_13 + 9,
      updatedAt: NOV_13 + 9,
    });
    api.resumeReviewerAttempt.mockResolvedValue(resumed);
    const cancelled = attemptIn("cancelled", { updatedAt: NOV_13 + 10 });
    api.cancelReviewerAttempt.mockResolvedValue(cancelled);
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();

    await act(() => result.current.resume(WAITING));
    expect(api.resumeReviewerAttempt).toHaveBeenCalledWith(SCOPE, "att_1");
    expect(result.current.attempt?.state).toBe("running");

    await act(() => result.current.cancel(resumed));
    expect(api.cancelReviewerAttempt).toHaveBeenCalledWith(SCOPE, "att_1");
    // A read that left before the cancel answered does not undo it.
    await settle();
    expect(result.current.attempt?.state).toBe("cancelled");
  });

  it("keeps an action's refusal while the attempt stays in that state", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(WAITING);
    api.resumeReviewerAttempt.mockRejectedValue(
      new Error(
        "This attempt expired before anyone resumed it. Start a new attempt.",
      ),
    );
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();

    await act(() => result.current.resume(WAITING));
    expect(result.current.failure?.action).toBe("resume");
    expect(result.current.busy).toBe(false);
    await settle();
    expect(result.current.failure?.action).toBe("resume");
    // A read that fails afterwards does not replace it.
    api.getLatestReviewerAttempt.mockRejectedValueOnce(
      new Error("Network error"),
    );
    await settle(IDLE_POLL_MS);
    expect(result.current.failure?.action).toBe("resume");

    // Someone else's change moves the attempt on: the refusal no longer applies.
    api.getLatestReviewerAttempt.mockResolvedValue(
      attemptIn("expired", { updatedAt: NOV_13 + 20 }),
    );
    await settle(IDLE_POLL_MS);
    expect(result.current.failure).toBeNull();
  });

  it("reports a failed first read, and keeps the last answer over a failed later one", async () => {
    api.getLatestReviewerAttempt.mockRejectedValueOnce(
      new Error("Network error"),
    );
    const { result } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();
    expect(result.current.failure?.action).toBe("load");

    api.getLatestReviewerAttempt.mockResolvedValueOnce(WAITING);
    await settle(IDLE_POLL_MS);
    expect(result.current.failure).toBeNull();
    expect(result.current.attempt).toEqual(WAITING);

    api.getLatestReviewerAttempt.mockRejectedValueOnce(
      new Error("Network error"),
    );
    await settle(IDLE_POLL_MS);
    expect(result.current.failure).toBeNull();
    expect(result.current.attempt).toEqual(WAITING);
  });

  it("stops reading once unmounted", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(attemptIn("running"));
    const { unmount } = renderHook(() => useReviewerAttempt(SCOPE));
    await settle();
    unmount();
    await settle(IDLE_POLL_MS * 2);
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledTimes(1);
  });
});
