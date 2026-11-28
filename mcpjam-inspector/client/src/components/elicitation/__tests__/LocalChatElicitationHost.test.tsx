import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElicitationResponseError } from "@/lib/apis/mcp-tasks-api";
import { LocalChatElicitationHost } from "../LocalChatElicitationHost";

const respondToTaskElicitation = vi.fn();
vi.mock("@/lib/apis/mcp-tasks-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apis/mcp-tasks-api")>()),
  respondToTaskElicitation: (...args: unknown[]) =>
    respondToTaskElicitation(...args),
}));
vi.mock("@/lib/session-token", () => ({ addTokenToUrl: (url: string) => url }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/** jsdom has no EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function emit(frame: unknown) {
  act(() => {
    for (const source of FakeEventSource.instances)
      if (!source.closed) source.onmessage?.({ data: JSON.stringify(frame) });
  });
}

const question = {
  type: "elicitation_request",
  requestId: "req-1",
  serverId: "weather",
  message: "Which city?",
  schema: {
    type: "object",
    properties: { city: { type: "string" } },
  },
  timestamp: "2026-11-28T00:00:00.000Z",
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  respondToTaskElicitation.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LocalChatElicitationHost", () => {
  it("shows a chat question from the local elicitation stream and sends the answer", async () => {
    render(<LocalChatElicitationHost />);
    expect(FakeEventSource.instances[0]?.url).toBe(
      "/api/mcp/elicitation/stream",
    );

    emit(question);
    expect(await screen.findByText("Which city?")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(respondToTaskElicitation).toHaveBeenCalledWith(
      "req-1",
      "decline",
      undefined,
    );
    expect(screen.queryByText("Which city?")).toBeNull();
  });

  it("leaves task questions to the Tasks tab", () => {
    render(<LocalChatElicitationHost />);
    emit({ ...question, relatedTaskId: "task-1" });
    expect(screen.queryByText("Which city?")).toBeNull();
  });

  it("drops only the failed question when its answer can't be sent", async () => {
    let fail!: (error: Error) => void;
    respondToTaskElicitation.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)),
    );
    render(<LocalChatElicitationHost />);
    emit(question);
    emit({ ...question, requestId: "req-2", message: "Which day?" });
    expect(await screen.findByText("Which city?")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));
    // req-1 is completed elsewhere while its answer is in flight, so req-2
    // becomes the current question before the answer fails.
    emit({ type: "elicitation_complete", requestId: "req-1" });
    await act(async () =>
      fail(new ElicitationResponseError("Unknown or expired requestId", true)),
    );

    expect(await screen.findByText("Which day?")).toBeTruthy();
  });

  it("keeps the question open to retry when the answer doesn't arrive", async () => {
    respondToTaskElicitation.mockRejectedValueOnce(
      new ElicitationResponseError("Respond to elicitation failed (500)", false),
    );
    render(<LocalChatElicitationHost />);
    emit(question);
    expect(await screen.findByText("Which city?")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(respondToTaskElicitation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Which city?")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(respondToTaskElicitation).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Which city?")).toBeNull();
  });

  it("drops questions settled while the stream was away", async () => {
    render(<LocalChatElicitationHost />);
    emit(question);
    emit({ ...question, requestId: "req-2", message: "Which day?" });
    expect(await screen.findByText("Which city?")).toBeTruthy();
    // On reconnect the server sends the open set before replaying it.
    emit({ type: "elicitation_open", requestIds: ["req-2"] });
    expect(await screen.findByText("Which day?")).toBeTruthy();
    expect(screen.queryByText("Which city?")).toBeNull();
  });

  it("closes the dialog when the question is answered elsewhere", async () => {
    render(<LocalChatElicitationHost />);
    emit(question);
    expect(await screen.findByText("Which city?")).toBeTruthy();
    emit({ type: "elicitation_complete", requestId: "req-1" });
    expect(screen.queryByText("Which city?")).toBeNull();
  });
});
