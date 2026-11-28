import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("@/lib/session-token", () => ({ authFetch: mocks.authFetch }));

import {
  useHarnessBoxPreparation,
  type HarnessBoxPreparationRequest,
} from "../use-harness-box-preparation";

const request = (chatSessionId: string): HarnessBoxPreparationRequest => ({
  chatSessionId,
  body: { projectId: "project_1", chatSessionId, hostId: "host_1" },
});

function render(initial: {
  request: HarnessBoxPreparationRequest | null;
  input: string;
}) {
  return renderHook(
    ({ request, input }) => useHarnessBoxPreparation(request, input),
    { initialProps: initial },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.authFetch.mockReset();
  mocks.authFetch.mockResolvedValue(new Response("{}"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useHarnessBoxPreparation", () => {
  it("asks 500 ms after the first input, once per chat, however much is typed", () => {
    const view = render({ request: request("chat-a"), input: "" });
    expect(mocks.authFetch).not.toHaveBeenCalled();
    view.rerender({ request: request("chat-a"), input: "h" });
    vi.advanceTimersByTime(499);
    view.rerender({ request: request("chat-a"), input: "he" });
    expect(mocks.authFetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/web/chat/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("chat-a").body),
    });

    view.rerender({ request: request("chat-a"), input: "hello there" });
    view.rerender({ request: request("chat-a"), input: "" });
    view.rerender({ request: request("chat-a"), input: "again" });
    vi.advanceTimersByTime(5_000);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);

    // A new chat gets its own request; a remount of an asked one does not.
    view.rerender({ request: request("chat-b"), input: "x" });
    vi.advanceTimersByTime(500);
    expect(mocks.authFetch).toHaveBeenCalledTimes(2);
    render({ request: request("chat-a"), input: "x" });
    vi.advanceTimersByTime(500);
    expect(mocks.authFetch).toHaveBeenCalledTimes(2);
  });

  it("does not ask when the text is cleared before the debounce", () => {
    const view = render({ request: request("chat-c"), input: "h" });
    vi.advanceTimersByTime(200);
    view.rerender({ request: request("chat-c"), input: "" });
    vi.advanceTimersByTime(1_000);
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });

  it("sends nothing for a chat that cannot be prepared", () => {
    render({ request: null, input: "hello" });
    vi.advanceTimersByTime(1_000);
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });

  it("does not ask once the chat stops qualifying", () => {
    const view = render({ request: request("chat-d"), input: "h" });
    view.rerender({ request: null, input: "hi" });
    vi.advanceTimersByTime(1_000);
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });

  it("stays silent when the request fails", async () => {
    mocks.authFetch.mockRejectedValue(new Error("offline"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    render({ request: request("chat-e"), input: "h" });
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    // Only the error's class reaches the console, never its message.
    expect(debug).toHaveBeenCalledWith(
      "[harness-prepare] request failed",
      "Error",
    );
  });
});
