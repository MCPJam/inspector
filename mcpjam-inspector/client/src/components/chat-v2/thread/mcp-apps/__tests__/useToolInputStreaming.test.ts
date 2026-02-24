import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getToolInputSignature,
  useToolInputStreaming,
  PARTIAL_INPUT_THROTTLE_MS,
  STREAMING_REVEAL_FALLBACK_MS,
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
  reinitCount: number;
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
    reinitCount: 0,
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

  it("re-sends tool input and result when reinitCount increments", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-available";
    props.toolInput = { code: "final" };
    props.toolOutput = { content: [{ type: "text", text: "result" }] };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);

    // Simulate guest re-initialization (e.g. SDK app after openai-compat shim)
    props.reinitCount = 1;
    rerender();

    expect(bridge.sendToolInput).toHaveBeenCalledTimes(2);
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(2);
  });
});
