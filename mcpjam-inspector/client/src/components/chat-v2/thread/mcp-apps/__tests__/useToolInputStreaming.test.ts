import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getToolInputSignature,
  useToolInputStreaming,
  PARTIAL_INPUT_THROTTLE_MS,
  STREAMING_REVEAL_FALLBACK_MS,
  PARTIAL_HISTORY_MAX_ENTRIES,
  type ToolState,
} from "../useToolInputStreaming";

// ── getToolInputSignature unit tests ─────────────────────────────────────────

describe("getToolInputSignature", () => {
  it("returns empty string for undefined", () => {
    expect(getToolInputSignature(undefined)).toBe("");
  });

  it("returns empty object signature for empty input", () => {
    const sig = getToolInputSignature({});
    expect(sig).toContain("obj:0");
  });

  it("encodes primitive values", () => {
    const sig = getToolInputSignature({
      s: "hello",
      n: 42,
      b: true,
    });
    expect(sig).toContain("str:");
    expect(sig).toContain("num:42");
    expect(sig).toContain("bool:true");
  });

  it("encodes string edges with head/tail and length", () => {
    const long = "A".repeat(100);
    const sig = getToolInputSignature({ text: long });
    expect(sig).toContain("str:100:");
  });

  it("encodes special number values", () => {
    expect(getToolInputSignature({ v: NaN })).toContain("num:NaN");
    expect(getToolInputSignature({ v: Infinity })).toContain("num:Infinity");
    expect(getToolInputSignature({ v: -Infinity })).toContain("num:-Infinity");
    expect(getToolInputSignature({ v: -0 })).toContain("num:-0");
  });

  it("encodes nested objects and arrays", () => {
    const sig = getToolInputSignature({
      list: [1, 2, 3],
      nested: { a: "b" },
    });
    expect(sig).toContain("arr:3");
    expect(sig).toContain("a:str:");
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const sig = getToolInputSignature(obj);
    expect(sig).toContain("obj:circular");
  });

  it("truncates at max depth", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: "deep" } } } } };
    const sig = getToolInputSignature(deep);
    expect(sig).toContain("max-depth");
  });

  it("encodes large arrays with tail", () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const sig = getToolInputSignature({ items: arr });
    expect(sig).toContain("arr:30");
    expect(sig).toContain("tail:");
  });

  it("encodes large objects with omitted keys", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      obj[`key${String(i).padStart(3, "0")}`] = i;
    }
    const sig = getToolInputSignature(obj);
    expect(sig).toContain("omitted:");
    expect(sig).toContain("tail-keys:");
  });

  it("produces different signatures for different inputs", () => {
    const sig1 = getToolInputSignature({ a: "hello" });
    const sig2 = getToolInputSignature({ a: "world" });
    expect(sig1).not.toBe(sig2);
  });

  it("produces same signature for identical inputs", () => {
    const input = { a: 1, b: [2, 3], c: { d: "e" } };
    expect(getToolInputSignature(input)).toBe(getToolInputSignature(input));
  });

  it("encodes null values", () => {
    const sig = getToolInputSignature({ a: null });
    expect(sig).toContain("null");
  });

  it("encodes boolean false", () => {
    const sig = getToolInputSignature({ a: false });
    expect(sig).toContain("bool:false");
  });

  it("encodes empty array", () => {
    const sig = getToolInputSignature({ a: [] });
    expect(sig).toContain("arr:0");
  });
});

// ── useToolInputStreaming hook tests ─────────────────────────────────────────

function createMockBridge() {
  return {
    sendToolInputPartial: vi.fn().mockResolvedValue(undefined),
    sendToolInput: vi.fn().mockResolvedValue(undefined),
    sendToolResult: vi.fn(),
    sendToolCancelled: vi.fn(),
  };
}

interface HookProps {
  bridgeRef: React.RefObject<any>;
  isReady: boolean;
  isReadyRef: React.RefObject<boolean>;
  toolState: ToolState | undefined;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  toolErrorText: string | undefined;
  toolCallId: string;
}

function createDefaultProps(
  bridge: ReturnType<typeof createMockBridge>,
): HookProps {
  const bridgeRef = { current: bridge };
  const isReadyRef = { current: true };
  return {
    bridgeRef,
    isReady: true,
    isReadyRef,
    toolState: undefined,
    toolInput: undefined,
    toolOutput: undefined,
    toolErrorText: undefined,
    toolCallId: "call-1",
  };
}

describe("useToolInputStreaming", () => {
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = createMockBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns canRenderStreamingInput=true when not in input-streaming state", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-available";

    const { result } = renderHook(() => useToolInputStreaming(props));
    expect(result.current.canRenderStreamingInput).toBe(true);
  });

  it("returns canRenderStreamingInput=false during input-streaming before partial delivery", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";

    const { result } = renderHook(() => useToolInputStreaming(props));
    expect(result.current.canRenderStreamingInput).toBe(false);
  });

  it("sends partial input during input-streaming state", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInputPartial).toHaveBeenCalledWith({
      arguments: { code: "hello" },
    });
  });

  it("deduplicates identical partials via signature", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    // Same input on rerender — should not send again
    rerender();

    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
  });

  it("sends new partial when input changes", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    props.toolInput = { code: "he" };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(1);

    // Advance past throttle
    act(() => {
      vi.advanceTimersByTime(PARTIAL_INPUT_THROTTLE_MS + 10);
    });

    // Update input
    props.toolInput = { code: "hello" };
    rerender();

    // Should send the updated partial (may require timer flush for throttle)
    act(() => {
      vi.advanceTimersByTime(PARTIAL_INPUT_THROTTLE_MS + 10);
    });

    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
    expect(bridge.sendToolInputPartial).toHaveBeenLastCalledWith({
      arguments: { code: "hello" },
    });
  });

  it("sends complete input on transition to input-available", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-available";
    props.toolInput = { code: "final" };

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInput).toHaveBeenCalledWith({
      arguments: { code: "final" },
    });
  });

  it("sends tool result on output-available", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-available";
    props.toolInput = { code: "final" };
    props.toolOutput = { content: [{ type: "text", text: "done" }] };

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolResult).toHaveBeenCalledWith({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("sends tool cancelled on output-error", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-error";
    props.toolErrorText = "Something went wrong";

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({
      reason: "Something went wrong",
    });
  });

  it("sends tool cancelled with Error message when toolErrorText is undefined", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-error";
    props.toolOutput = new Error("Custom error");

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({
      reason: "Custom error",
    });
  });

  it("resets state on toolCallId change", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(1);

    // Change toolCallId
    props.toolCallId = "call-2";
    props.toolInput = { code: "hello" };
    rerender();

    // After reset, should send again
    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
  });

  it("re-entry detection resets state when transitioning back to input-streaming", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-available";
    props.toolInput = { code: "first" };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);

    // Transition back to input-streaming (re-entry)
    props.toolState = "input-streaming";
    props.toolInput = { code: "second" };
    rerender();

    // Should send partial for the new input
    expect(bridge.sendToolInputPartial).toHaveBeenCalledWith({
      arguments: { code: "second" },
    });
  });

  it("signalStreamingRender sets the render signal", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    // Start without toolInput — the reset-on-toolCallId effect also fires on
    // the first render and would undo the partial delivery state.
    props.toolInput = undefined;

    const { result, rerender } = renderHook(() => useToolInputStreaming(props));

    expect(result.current.canRenderStreamingInput).toBe(false);

    // Now set toolInput — only the partial delivery effect re-fires,
    // the reset effect does NOT (toolCallId hasn't changed).
    props.toolInput = { code: "hello" };
    rerender();

    expect(bridge.sendToolInputPartial).toHaveBeenCalled();
    expect(result.current.canRenderStreamingInput).toBe(true);
  });

  it("canRenderStreamingInput becomes true after first partial is delivered", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    props.toolInput = undefined;

    const { result, rerender } = renderHook(() => useToolInputStreaming(props));

    // No toolInput yet — still false
    expect(result.current.canRenderStreamingInput).toBe(false);

    // Deliver first partial (toolCallId unchanged, so reset effect doesn't re-fire)
    props.toolInput = { code: "hello" };
    rerender();

    expect(result.current.canRenderStreamingInput).toBe(true);
  });

  it("fallback reveal timer fires after STREAMING_REVEAL_FALLBACK_MS", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    // No toolInput — so no partial will be sent, relying on fallback timer

    const { result } = renderHook(() => useToolInputStreaming(props));

    // Before fallback timer: not signaled, no delivery
    expect(result.current.canRenderStreamingInput).toBe(false);

    // Advance past fallback timer
    act(() => {
      vi.advanceTimersByTime(STREAMING_REVEAL_FALLBACK_MS + 10);
    });

    // Fallback timer sets streamingRenderSignaled, but hasDeliveredStreamingInput
    // is still false — so canRenderStreamingInput remains false
    // (both conditions must be true)
    expect(result.current.canRenderStreamingInput).toBe(false);
  });

  it("does not send partial when bridge is null", () => {
    const props = createDefaultProps(bridge);
    props.bridgeRef = { current: null };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInputPartial).not.toHaveBeenCalled();
  });

  it("does not send partial when isReady is false", () => {
    const props = createDefaultProps(bridge);
    props.isReady = false;
    props.isReadyRef = { current: false };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };

    renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInputPartial).not.toHaveBeenCalled();
  });

  it("does not send complete input for duplicate payload", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-available";
    props.toolInput = { code: "final" };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);

    // Same input on rerender
    rerender();

    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
  });

  it("does not send tool result for duplicate payload", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-available";
    props.toolInput = { code: "final" };
    props.toolOutput = { content: [{ type: "text", text: "result" }] };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);

    // Same output on rerender
    rerender();

    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
  });

  it("does not send tool error for duplicate error message", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-error";
    props.toolErrorText = "failed";

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(1);

    // Same error on rerender
    rerender();

    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(1);
  });

  // ── Partial history tests ───────────────────────────────────────────────

  describe("partialHistory", () => {
    it("is empty during streaming, populated after transition to input-available", () => {
      const props = createDefaultProps(bridge);
      props.toolState = "input-streaming";
      props.toolInput = { code: "he" };

      const { result, rerender } = renderHook(() =>
        useToolInputStreaming(props),
      );

      // During streaming, partialHistory state has not been snapshotted yet
      expect(result.current.partialHistory).toEqual([]);

      // Transition to input-available
      props.toolState = "input-available";
      props.toolInput = { code: "hello" };
      rerender();

      // Now partialHistory should be populated (includes the streaming partial + final)
      expect(result.current.partialHistory.length).toBeGreaterThan(0);
    });

    it("final entry has isFinal: true", () => {
      const props = createDefaultProps(bridge);
      props.toolState = "input-streaming";
      props.toolInput = { code: "he" };

      const { result, rerender } = renderHook(() =>
        useToolInputStreaming(props),
      );

      // Transition to input-available
      props.toolState = "input-available";
      props.toolInput = { code: "hello" };
      rerender();

      const history = result.current.partialHistory;
      expect(history.length).toBeGreaterThan(0);
      expect(history[history.length - 1].isFinal).toBe(true);
    });

    it("elapsedFromStart is relative to first entry", () => {
      const props = createDefaultProps(bridge);
      props.toolState = "input-streaming";
      props.toolInput = { code: "h" };

      const { result, rerender } = renderHook(() =>
        useToolInputStreaming(props),
      );

      // Advance time, change input
      act(() => {
        vi.advanceTimersByTime(PARTIAL_INPUT_THROTTLE_MS + 10);
      });
      props.toolInput = { code: "he" };
      rerender();

      // Transition to complete
      props.toolState = "input-available";
      props.toolInput = { code: "hello" };
      rerender();

      const history = result.current.partialHistory;
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].elapsedFromStart).toBe(0);
      // Later entries should have positive elapsed time
      for (let i = 1; i < history.length; i++) {
        expect(history[i].elapsedFromStart).toBeGreaterThanOrEqual(0);
      }
    });

    it("history resets on toolCallId change", () => {
      const props = createDefaultProps(bridge);
      props.toolState = "input-streaming";
      props.toolInput = { code: "hello" };

      const { result, rerender } = renderHook(() =>
        useToolInputStreaming(props),
      );

      // Complete to populate history
      props.toolState = "input-available";
      rerender();

      expect(result.current.partialHistory.length).toBeGreaterThan(0);

      // Change toolCallId — history should reset
      props.toolCallId = "call-2";
      props.toolState = "input-streaming";
      props.toolInput = { code: "new" };
      rerender();

      expect(result.current.partialHistory).toEqual([]);
    });

    it("history is capped at PARTIAL_HISTORY_MAX_ENTRIES", () => {
      const props = createDefaultProps(bridge);
      props.toolState = "input-streaming";

      const { result, rerender } = renderHook(() =>
        useToolInputStreaming(props),
      );

      // Send many distinct partials
      for (let i = 0; i < PARTIAL_HISTORY_MAX_ENTRIES + 50; i++) {
        act(() => {
          vi.advanceTimersByTime(PARTIAL_INPUT_THROTTLE_MS + 10);
        });
        props.toolInput = { code: `input-${i}` };
        rerender();
      }

      // Complete to snapshot history
      props.toolState = "input-available";
      props.toolInput = { code: "final" };
      rerender();

      // The final entry addition is also guarded, so total should be capped
      expect(
        result.current.partialHistory.length,
      ).toBeLessThanOrEqual(PARTIAL_HISTORY_MAX_ENTRIES);
    });
  });

  // ── Replay tests ────────────────────────────────────────────────────────

  describe("replay", () => {
    function setupWithHistory(b: ReturnType<typeof createMockBridge>) {
      const props = createDefaultProps(b);
      props.toolState = "input-streaming";
      props.toolInput = { code: "h" };

      const hookResult = renderHook(() => useToolInputStreaming(props));

      // Advance and add another partial
      act(() => {
        vi.advanceTimersByTime(PARTIAL_INPUT_THROTTLE_MS + 10);
      });
      props.toolInput = { code: "he" };
      hookResult.rerender();

      // Complete
      props.toolState = "input-available";
      props.toolInput = { code: "hello" };
      hookResult.rerender();

      // Clear mock call history for cleaner assertions
      b.sendToolInputPartial.mockClear();
      b.sendToolInput.mockClear();

      return { hookResult, props };
    }

    it("replayToPosition(0) calls bridge.sendToolInputPartial", () => {
      const { hookResult } = setupWithHistory(bridge);
      // The first entry in history is { code: "he" } — the mount-time entry
      // { code: "h" } gets cleared by the reset effect that runs in the same cycle.
      const firstEntry = hookResult.result.current.partialHistory[0];

      act(() => {
        hookResult.result.current.replayToPosition(0);
      });

      expect(bridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: firstEntry.input,
      });
    });

    it("replayToPosition(lastIndex) calls bridge.sendToolInput for final entry", () => {
      const { hookResult } = setupWithHistory(bridge);
      const lastIndex =
        hookResult.result.current.partialHistory.length - 1;

      act(() => {
        hookResult.result.current.replayToPosition(lastIndex);
      });

      expect(bridge.sendToolInput).toHaveBeenCalledWith({
        arguments: { code: "hello" },
      });
    });

    it("replayToPosition sets isReplayActive = true", () => {
      const { hookResult } = setupWithHistory(bridge);

      expect(hookResult.result.current.isReplayActive).toBe(false);

      act(() => {
        hookResult.result.current.replayToPosition(0);
      });

      expect(hookResult.result.current.isReplayActive).toBe(true);
    });

    it("exitReplay calls bridge.sendToolInput with final args and sets isReplayActive = false", () => {
      const { hookResult } = setupWithHistory(bridge);

      act(() => {
        hookResult.result.current.replayToPosition(0);
      });
      expect(hookResult.result.current.isReplayActive).toBe(true);

      bridge.sendToolInput.mockClear();

      act(() => {
        hookResult.result.current.exitReplay();
      });

      expect(hookResult.result.current.isReplayActive).toBe(false);
      expect(bridge.sendToolInput).toHaveBeenCalledWith({
        arguments: { code: "hello" },
      });
    });
  });
});
