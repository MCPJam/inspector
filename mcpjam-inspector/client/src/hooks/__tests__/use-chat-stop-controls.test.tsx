import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import {
  getChatComposerInteractivity,
  useChatStopControls,
} from "../use-chat-stop-controls";

function createSummary(
  status: MultiModelCardSummary["status"],
): MultiModelCardSummary {
  return {
    modelId: "model-1",
    durationMs: null,
    tokens: 0,
    toolCount: 0,
    status,
    hasMessages: false,
  };
}

describe("useChatStopControls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the single-model stop handler when not in multi-model mode", () => {
    const stop = vi.fn();

    const { result } = renderHook(() => {
      const [stopBroadcastRequestId, setStopBroadcastRequestId] = useState(0);
      const controls = useChatStopControls({
        isMultiModelMode: false,
        isStreaming: true,
        multiModelSummaries: {},
        setStopBroadcastRequestId,
        stop,
      });

      return {
        ...controls,
        stopBroadcastRequestId,
      };
    });

    expect(result.current.isAnyMultiModelStreaming).toBe(false);
    expect(result.current.isStreamingActive).toBe(true);

    act(() => {
      result.current.stopActiveChat();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.current.stopBroadcastRequestId).toBe(0);
  });

  it("increments the broadcast stop counter in multi-model mode", () => {
    const stop = vi.fn();

    const { result } = renderHook(() => {
      const [stopBroadcastRequestId, setStopBroadcastRequestId] = useState(0);
      const controls = useChatStopControls({
        isMultiModelMode: true,
        isStreaming: false,
        multiModelSummaries: {
          "model-1": createSummary("running"),
        },
        setStopBroadcastRequestId,
        stop,
      });

      return {
        ...controls,
        stopBroadcastRequestId,
      };
    });

    expect(result.current.isAnyMultiModelStreaming).toBe(true);
    expect(result.current.isStreamingActive).toBe(true);

    act(() => {
      result.current.stopActiveChat();
    });

    expect(stop).not.toHaveBeenCalled();
    expect(result.current.stopBroadcastRequestId).toBe(1);
  });

  it("only binds Escape when chat stopping is active", () => {
    const stop = vi.fn();

    const { rerender } = renderHook(
      ({ isStreaming }) => {
        const [stopBroadcastRequestId, setStopBroadcastRequestId] = useState(0);

        return useChatStopControls({
          isMultiModelMode: false,
          isStreaming,
          multiModelSummaries: {},
          setStopBroadcastRequestId,
          stop,
        });
      },
      {
        initialProps: { isStreaming: false },
      },
    );

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(stop).not.toHaveBeenCalled();

    rerender({ isStreaming: true });

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the composer editable while streaming but still blocks send", () => {
    expect(
      getChatComposerInteractivity({
        isStreamingActive: true,
        composerDisabled: false,
      }),
    ).toEqual({
      composerDisabled: false,
      sendBlocked: true,
    });
  });

  it("keeps hard-disabled composers read-only even when streaming is idle", () => {
    expect(
      getChatComposerInteractivity({
        isStreamingActive: false,
        composerDisabled: true,
      }),
    ).toEqual({
      composerDisabled: true,
      sendBlocked: true,
    });
  });
});
