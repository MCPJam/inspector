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
  sendToolInput: boolean;
  onToolInputSent?: () => void;
  reinitCount: number;
  mcpAppsCapabilitiesRef: React.RefObject<any>;
}

function createDefaultProps(
  bridge: ReturnType<typeof createMockBridge>,
): HookProps {
  const bridgeRef = { current: bridge };
  const isReadyRef = { current: true };
  // Default to null → "default on" per the hook's gate contract.
  // Tests that want to exercise the gate flip mcpAppsCapabilitiesRef.current
  // to a resolved matrix value with the relevant dimension off.
  const mcpAppsCapabilitiesRef = { current: null };
  return {
    bridgeRef,
    isReady: true,
    isReadyRef,
    toolState: undefined,
    toolInput: undefined,
    toolOutput: undefined,
    toolErrorText: undefined,
    toolCallId: "call-1",
    sendToolInput: true,
    reinitCount: 0,
    mcpAppsCapabilitiesRef,
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
    props.toolInput = undefined;

    const { result, rerender } = renderHook(() => useToolInputStreaming(props));

    expect(result.current.canRenderStreamingInput).toBe(false);

    // Now set toolInput — only the partial delivery effect re-fires
    // because toolCallId hasn't changed.
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

  it("fallback reveal timer does not render before parseable partial args arrive", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "input-streaming";
    // No toolInput — so no partial will be sent, relying on fallback timer

    const { result } = renderHook(() => useToolInputStreaming(props));

    // Before fallback timer: not signaled, no delivery
    expect(result.current.canRenderStreamingInput).toBe(false);

    // Advance past fallback timer. This is only a render signal; without
    // delivered input, revealing the iframe produces a blank-shell flicker.
    act(() => {
      vi.advanceTimersByTime(STREAMING_REVEAL_FALLBACK_MS + 10);
    });

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

  it("suppresses tool input while still rendering and delivering results", () => {
    const props = createDefaultProps(bridge);
    props.sendToolInput = false;
    props.toolState = "output-available";
    props.toolInput = { code: "final" };
    props.toolOutput = { content: [{ type: "text", text: "result" }] };

    const { result } = renderHook(() => useToolInputStreaming(props));

    expect(result.current.canRenderStreamingInput).toBe(true);
    expect(bridge.sendToolInput).not.toHaveBeenCalled();
    expect(bridge.sendToolInputPartial).not.toHaveBeenCalled();
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
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

  it("sends identical tool results for different tool calls", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-available";
    props.toolOutput = { content: [{ type: "text", text: "same" }] };

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);

    props.toolCallId = "call-2";
    rerender();

    expect(bridge.sendToolResult).toHaveBeenCalledTimes(2);
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

  it("re-sends tool error when reinitCount increments", () => {
    const props = createDefaultProps(bridge);
    props.toolState = "output-error";
    props.toolErrorText = "Something failed";

    const { rerender } = renderHook(() => useToolInputStreaming(props));

    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(1);

    // Simulate guest re-initialization
    props.reinitCount = 1;
    rerender();

    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(2);
  });
});

describe("useToolInputStreaming — MCP Apps matrix notification gates", () => {
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = createMockBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: build a resolved matrix with all dimensions on except the
  // ones the test wants to flip off. Mirrors the inspector's
  // MCP_APPS_FULL_SURFACE so tests stay self-contained.
  function fullSurfaceMatrix(overrides: Record<string, unknown> = {}) {
    return {
      availableDisplayModes: ["inline", "fullscreen", "pip"],
      toolInputPartial: true,
      toolCancelled: true,
      hostContextChanged: true,
      resourceTeardown: true,
      toolInfo: true,
      openLinks: true,
      serverTools: true,
      serverResources: true,
      logging: true,
      updateModelContext: true,
      message: true,
      sandboxPermissions: true,
      cspFrameDomains: true,
      cspBaseUriDomains: true,
      resourcePrefersBorder: true,
      downloadFile: true,
      requestTeardown: true,
      ...overrides,
    };
  }

  it("suppresses bridge.sendToolInputPartial when matrix has toolInputPartial: false (simulates Copilot)", () => {
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = {
      current: fullSurfaceMatrix({ toolInputPartial: false }),
    };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };
    renderHook(() => useToolInputStreaming(props));
    // The streaming UX still progressed internally, but the wire
    // notification was suppressed. Widget on this simulated host
    // sees no `tool-input-partial` — same as real Copilot.
    expect(bridge.sendToolInputPartial).not.toHaveBeenCalled();
  });

  it("emits bridge.sendToolInputPartial when matrix is null (default-on fallback)", () => {
    // Null matrix ref → fail-open. During initial mount before the
    // renderer's matrix resolver runs, notifications must still
    // emit (matches pre-matrix behavior for any host).
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = { current: null };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };
    renderHook(() => useToolInputStreaming(props));
    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
  });

  it("emits bridge.sendToolInputPartial when matrix.toolInputPartial: true (default ChatGPT/Claude surface)", () => {
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = { current: fullSurfaceMatrix() };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };
    renderHook(() => useToolInputStreaming(props));
    expect(bridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
  });

  it("suppresses bridge.sendToolCancelled on tool error when matrix has toolCancelled: false (simulates Copilot)", () => {
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = {
      current: fullSurfaceMatrix({ toolCancelled: false }),
    };
    props.toolState = "output-error";
    props.toolErrorText = "boom";
    renderHook(() => useToolInputStreaming(props));
    expect(bridge.sendToolCancelled).not.toHaveBeenCalled();
  });

  it("emits bridge.sendToolCancelled on tool error when matrix.toolCancelled: true", () => {
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = { current: fullSurfaceMatrix() };
    props.toolState = "output-error";
    props.toolErrorText = "boom";
    renderHook(() => useToolInputStreaming(props));
    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({ reason: "boom" });
  });

  it("toolInputPartial gate and toolCancelled gate are independent (flipping one doesn't suppress the other)", () => {
    // Two-matrix isolation defense at the runtime-gate level —
    // each row gates exactly its own emission, no spurious
    // coupling.
    const props = createDefaultProps(bridge);
    props.mcpAppsCapabilitiesRef = {
      current: fullSurfaceMatrix({
        toolInputPartial: false,
        toolCancelled: true,
      }),
    };
    props.toolState = "input-streaming";
    props.toolInput = { code: "hello" };
    const { rerender } = renderHook(() => useToolInputStreaming(props));
    expect(bridge.sendToolInputPartial).not.toHaveBeenCalled();
    // Now flip to error state with the same matrix → tool-cancelled
    // must still fire because that row is on.
    props.toolState = "output-error";
    props.toolErrorText = "boom";
    rerender();
    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({ reason: "boom" });
  });
});
