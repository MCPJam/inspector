import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";

const { mockGetXRayPayload } = vi.hoisted(() => ({
  mockGetXRayPayload: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-xray-api", () => ({
  getXRayPayload: mockGetXRayPayload,
}));

import { useDebouncedXRayPayload } from "../use-debounced-x-ray-payload";

const PAYLOAD_RESPONSE = {
  system: "You are helpful",
  tools: {},
  messages: [{ role: "user", content: "hello" }],
};

function makeMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function DebouncedPayloadProbe(
  props: Parameters<typeof useDebouncedXRayPayload>[0],
) {
  useDebouncedXRayPayload(props);
  return null;
}

describe("useDebouncedXRayPayload", () => {
  beforeEach(() => {
    mockGetXRayPayload.mockReset();
    mockGetXRayPayload.mockResolvedValue(PAYLOAD_RESPONSE);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not fetch immediately — waits for debounce", () => {
    render(
      <DebouncedPayloadProbe
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
        enabled
      />,
    );

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });

  it("fetches once after debounce period", async () => {
    render(
      <DebouncedPayloadProbe
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
        enabled
      />,
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).toHaveBeenCalledTimes(1);
  });

  it("resets debounce on rapid message changes — only fetches once", async () => {
    const { rerender } = render(
      <DebouncedPayloadProbe
        systemPrompt="test"
        messages={[makeMessage("1", "h")]}
        selectedServers={["s1"]}
        enabled
      />,
    );

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      rerender(
        <DebouncedPayloadProbe
          systemPrompt="test"
          messages={[makeMessage("1", "hello".slice(0, i + 2))]}
          selectedServers={["s1"]}
          enabled
        />,
      );
    }

    expect(mockGetXRayPayload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when messages is empty", async () => {
    render(
      <DebouncedPayloadProbe
        systemPrompt="test"
        messages={[]}
        selectedServers={["s1"]}
        enabled
      />,
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });

  it("cancels pending fetch on unmount", async () => {
    const { unmount } = render(
      <DebouncedPayloadProbe
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
        enabled
      />,
    );

    unmount();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });

  it("retains payload when disabled (e.g. Chat tab) so Raw shows it immediately", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useDebouncedXRayPayload({
          systemPrompt: "test",
          messages: [makeMessage("1", "hi")],
          selectedServers: ["s1"],
          enabled,
        }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.payload).toEqual(PAYLOAD_RESPONSE);

    rerender({ enabled: false });

    expect(result.current.payload).toEqual(PAYLOAD_RESPONSE);

    rerender({ enabled: true });

    expect(result.current.payload).toEqual(PAYLOAD_RESPONSE);
  });

  it("clears payload when messages become empty", async () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useDebouncedXRayPayload({
          systemPrompt: "test",
          messages,
          selectedServers: ["s1"],
          enabled: true,
        }),
      { initialProps: { messages: [makeMessage("1", "hi")] } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.payload).toEqual(PAYLOAD_RESPONSE);

    rerender({ messages: [] });

    expect(result.current.payload).toBeNull();
  });
});
