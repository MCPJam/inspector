import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CaptureAttempt } from "@mcpjam/sdk/browser";
import {
  REFRESH_WAIT_MS,
  SERVER_CANVAS_REFRESH_PATH,
  requestServerCanvasRefresh,
  useServerCanvasRefresh,
} from "../server-canvas-refresh";

const mode = vi.hoisted(() => ({ hosted: true }));
const mockAuthFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mode.hosted;
  },
}));
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("requestServerCanvasRefresh", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
    mode.hosted = true;
  });

  it("posts the project server to the hosted route", async () => {
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    await expect(
      requestServerCanvasRefresh({ projectId: "p1", serverId: "s1" }),
    ).resolves.toBe("accepted");
    expect(mockAuthFetch).toHaveBeenCalledWith(
      SERVER_CANVAS_REFRESH_PATH.hosted,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "p1", serverId: "s1" }),
      }),
    );
  });

  it("uses the local route in local mode", async () => {
    mode.hosted = false;
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    await requestServerCanvasRefresh({ projectId: "p1", serverId: "s1" });
    expect(mockAuthFetch.mock.calls[0][0]).toBe(SERVER_CANVAS_REFRESH_PATH.local);
  });

  it("reports a turned-off canvas as disabled", async () => {
    mockAuthFetch.mockResolvedValue(reply(409, { status: "disabled" }));
    await expect(
      requestServerCanvasRefresh({ projectId: "p1", serverId: "s1" }),
    ).resolves.toBe("disabled");
  });

  it("throws the route's message, or a plain one without it", async () => {
    mockAuthFetch.mockResolvedValue(
      reply(403, { code: "FORBIDDEN", message: "You cannot refresh this server." }),
    );
    await expect(
      requestServerCanvasRefresh({ projectId: "p1", serverId: "s1" }),
    ).rejects.toThrow("You cannot refresh this server.");
    mockAuthFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    await expect(
      requestServerCanvasRefresh({ projectId: "p1", serverId: "s1" }),
    ).rejects.toThrow("Could not start a refresh. Try again in a moment.");
  });
});

describe("useServerCanvasRefresh", () => {
  beforeEach(() => mockAuthFetch.mockReset());
  afterEach(() => vi.useRealTimers());

  function setup(initial: { stamp: string; attempt?: CaptureAttempt }) {
    return renderHook(
      (props: { stamp: string; attempt?: CaptureAttempt }) =>
        useServerCanvasRefresh({
          projectId: "p1",
          serverId: "s1",
          evidenceStamp: props.stamp,
          latestAttempt: props.attempt,
        }),
      { initialProps: initial },
    );
  }

  it("shows Refreshing until the saved evidence changes", async () => {
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    const hook = setup({ stamp: "a" });
    act(() => hook.result.current.refresh());
    expect(hook.result.current.state).toEqual({ status: "running" });
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    hook.rerender({ stamp: "a" });
    expect(hook.result.current.state).toEqual({ status: "running" });
    hook.rerender({ stamp: "b" });
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({ status: "idle" }),
    );
  });

  it("names the failed attempt that ended the refresh", async () => {
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    const hook = setup({ stamp: "a" });
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    hook.rerender({
      stamp: "b",
      attempt: { status: "failed", at: Date.now() + 1, error: "list_failed" },
    });
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({
        status: "failed",
        message:
          "The refresh failed because one of the server's lists did not load. Try again in a moment.",
      }),
    );
  });

  it("never shows a failure code it cannot put into words", async () => {
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    const hook = setup({ stamp: "a" });
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    hook.rerender({
      stamp: "b",
      attempt: { status: "failed", at: Date.now() + 1, error: "capture_failed" },
    });
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({
        status: "failed",
        message: "The refresh failed. Try again in a moment.",
      }),
    );
  });

  it("stops waiting after a minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockAuthFetch.mockResolvedValue(reply(202, { status: "accepted" }));
    const hook = setup({ stamp: "a" });
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(REFRESH_WAIT_MS + 10);
    });
    expect(hook.result.current.state).toMatchObject({
      status: "failed",
      message:
        "The refresh did not finish within a minute. New results appear here when it does.",
    });
  });

  it("shows a turned-off route and a refused request", async () => {
    mockAuthFetch.mockResolvedValue(reply(409, { status: "disabled" }));
    const hook = setup({ stamp: "a" });
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({ status: "disabled" }),
    );
    mockAuthFetch.mockResolvedValue(reply(500, { message: "Probe queue is full." }));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({
        status: "failed",
        message: "Probe queue is full.",
      }),
    );
  });
});
