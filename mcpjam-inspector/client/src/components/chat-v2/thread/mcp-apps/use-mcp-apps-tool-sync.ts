import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PARTIAL_INPUT_THROTTLE_MS,
  SIGNATURE_MAX_ARRAY_ITEMS,
  SIGNATURE_MAX_DEPTH,
  SIGNATURE_MAX_OBJECT_KEYS,
  SIGNATURE_STRING_EDGE_LENGTH,
  STREAMING_REVEAL_FALLBACK_MS,
  type ToolState,
} from "./mcp-apps-types";

export function getToolInputSignature(
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  const seen = new WeakSet<object>();

  const getValueSignature = (value: unknown, depth: number): string => {
    if (value == null) return "null";

    const valueType = typeof value;
    if (valueType === "string") {
      const text = value as string;
      const head = text.slice(0, SIGNATURE_STRING_EDGE_LENGTH);
      const tail = text.slice(-SIGNATURE_STRING_EDGE_LENGTH);
      return `str:${text.length}:${JSON.stringify(head)}:${JSON.stringify(tail)}`;
    }
    if (valueType === "number") {
      if (Number.isNaN(value)) return "num:NaN";
      if (value === Infinity) return "num:Infinity";
      if (value === -Infinity) return "num:-Infinity";
      if (Object.is(value, -0)) return "num:-0";
      return `num:${value as number}`;
    }
    if (valueType === "boolean") return `bool:${String(value)}`;
    if (valueType === "bigint") return `bigint:${String(value)}`;
    if (valueType === "undefined") return "undefined";
    if (valueType === "function") return "function";
    if (valueType === "symbol") return `symbol:${String(value)}`;

    if (depth >= SIGNATURE_MAX_DEPTH) {
      if (Array.isArray(value)) return `arr:max-depth:${value.length}`;
      return `obj:max-depth:${Object.keys(value as Record<string, unknown>).length}`;
    }

    if (Array.isArray(value)) {
      const length = value.length;
      if (length === 0) return "arr:0";

      const headCount = Math.min(length, SIGNATURE_MAX_ARRAY_ITEMS);
      const headSignatures: string[] = [];
      for (let index = 0; index < headCount; index += 1) {
        headSignatures.push(
          `${index}:${getValueSignature(value[index], depth + 1)}`,
        );
      }

      if (length <= SIGNATURE_MAX_ARRAY_ITEMS) {
        return `arr:${length}:[${headSignatures.join(",")}]`;
      }

      const tailStart = Math.max(headCount, length - 2);
      const tailSignatures: string[] = [];
      for (let index = tailStart; index < length; index += 1) {
        tailSignatures.push(
          `${index}:${getValueSignature(value[index], depth + 1)}`,
        );
      }

      return `arr:${length}:[${headSignatures.join(",")}]|tail:[${tailSignatures.join(",")}]`;
    }

    if (valueType === "object") {
      const record = value as Record<string, unknown>;
      if (seen.has(record)) return "obj:circular";
      seen.add(record);

      const keys = Object.keys(record).sort();
      const keyCount = Math.min(keys.length, SIGNATURE_MAX_OBJECT_KEYS);
      const entries: string[] = [];

      for (let index = 0; index < keyCount; index += 1) {
        const key = keys[index];
        entries.push(`${key}:${getValueSignature(record[key], depth + 1)}`);
      }

      if (keys.length > SIGNATURE_MAX_OBJECT_KEYS) {
        const omitted = keys.length - SIGNATURE_MAX_OBJECT_KEYS;
        const tailKeys = keys.slice(-2).join(",");
        entries.push(`omitted:${omitted}:tail-keys:${tailKeys}`);
      }

      seen.delete(record);
      return `obj:${keys.length}:{${entries.join("|")}}`;
    }

    return `other:${valueType}`;
  };

  return getValueSignature(input, 0);
}

interface UseMcpAppsToolSyncArgs {
  toolCallId: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolErrorText?: string;
  bridgeRef: RefObject<AppBridge | null>;
  isReady: boolean;
}

export function useMcpAppsToolSync({
  toolCallId,
  toolState,
  toolInput,
  toolOutput,
  toolErrorText,
  bridgeRef,
  isReady,
}: UseMcpAppsToolSyncArgs) {
  const [streamingRenderSignaled, setStreamingRenderSignaled] = useState(false);
  const [hasDeliveredStreamingInput, setHasDeliveredStreamingInput] =
    useState(false);

  const lastToolInputRef = useRef<string | null>(null);
  const lastToolInputPartialRef = useRef<string | null>(null);
  const lastToolInputPartialSentAtRef = useRef(0);
  const pendingToolInputPartialRef = useRef<Record<string, unknown> | null>(
    null,
  );
  const partialInputTimerRef = useRef<number | null>(null);
  const streamingRevealTimerRef = useRef<number | null>(null);
  const lastToolOutputRef = useRef<string | null>(null);
  const lastToolErrorRef = useRef<string | null>(null);
  const toolInputSentRef = useRef(false);
  const previousToolStateRef = useRef<ToolState | undefined>(toolState);

  const resetStreamingState = useCallback(() => {
    lastToolInputRef.current = null;
    lastToolInputPartialRef.current = null;
    lastToolInputPartialSentAtRef.current = 0;
    pendingToolInputPartialRef.current = null;

    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
      partialInputTimerRef.current = null;
    }

    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }

    lastToolOutputRef.current = null;
    lastToolErrorRef.current = null;
    toolInputSentRef.current = false;
    setStreamingRenderSignaled(false);
    setHasDeliveredStreamingInput(false);
  }, []);

  const hasToolInputData = useMemo(
    () => !!toolInput && Object.keys(toolInput).length > 0,
    [toolInput],
  );

  const canRenderStreamingInput = useMemo(() => {
    if (toolState !== "input-streaming") return true;
    return streamingRenderSignaled && hasDeliveredStreamingInput;
  }, [hasDeliveredStreamingInput, streamingRenderSignaled, toolState]);

  useEffect(() => {
    if (!streamingRenderSignaled) return;
    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }
  }, [streamingRenderSignaled]);

  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || streamingRenderSignaled)
      return;
    if (streamingRevealTimerRef.current !== null) return;

    streamingRevealTimerRef.current = window.setTimeout(() => {
      streamingRevealTimerRef.current = null;
      setStreamingRenderSignaled(true);
    }, STREAMING_REVEAL_FALLBACK_MS);
  }, [isReady, streamingRenderSignaled, toolState]);

  useEffect(() => {
    const previousState = previousToolStateRef.current;

    if (
      toolState === "input-streaming" &&
      previousState &&
      previousState !== "input-streaming"
    ) {
      resetStreamingState();
    }

    previousToolStateRef.current = toolState;
  }, [resetStreamingState, toolState]);

  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || toolInputSentRef.current)
      return;
    if (!hasToolInputData) return;

    const resolvedToolInput = toolInput ?? {};
    pendingToolInputPartialRef.current = resolvedToolInput;

    const flushPartialInput = () => {
      const bridge = bridgeRef.current;
      if (!bridge || !isReady || toolInputSentRef.current) return;

      const pending = pendingToolInputPartialRef.current;
      if (!pending) return;

      const signature = getToolInputSignature(pending);
      if (lastToolInputPartialRef.current === signature) return;

      lastToolInputPartialRef.current = signature;
      lastToolInputPartialSentAtRef.current = Date.now();
      setHasDeliveredStreamingInput(true);
      setStreamingRenderSignaled(true);
      Promise.resolve(
        bridge.sendToolInputPartial({ arguments: pending }),
      ).catch(() => {});
    };

    const now = Date.now();
    const elapsed = now - lastToolInputPartialSentAtRef.current;

    if (
      lastToolInputPartialSentAtRef.current === 0 ||
      elapsed >= PARTIAL_INPUT_THROTTLE_MS
    ) {
      if (partialInputTimerRef.current !== null) {
        window.clearTimeout(partialInputTimerRef.current);
        partialInputTimerRef.current = null;
      }
      flushPartialInput();
      return;
    }

    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
    }

    partialInputTimerRef.current = window.setTimeout(() => {
      partialInputTimerRef.current = null;
      flushPartialInput();
    }, PARTIAL_INPUT_THROTTLE_MS - elapsed);
  }, [bridgeRef, hasToolInputData, isReady, toolInput, toolState]);

  useEffect(() => {
    if (!isReady) return;
    if (toolState !== "input-available" && toolState !== "output-available")
      return;

    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
      partialInputTimerRef.current = null;
    }

    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }

    pendingToolInputPartialRef.current = null;

    const bridge = bridgeRef.current;
    if (!bridge) return;

    const resolvedToolInput = toolInput ?? {};
    const serialized = JSON.stringify(resolvedToolInput);

    if (lastToolInputRef.current === serialized) {
      toolInputSentRef.current = true;
      return;
    }

    lastToolInputRef.current = serialized;
    toolInputSentRef.current = true;

    Promise.resolve(
      bridge.sendToolInput({ arguments: resolvedToolInput }),
    ).catch(() => {
      toolInputSentRef.current = false;
      lastToolInputRef.current = null;
    });
  }, [bridgeRef, isReady, toolInput, toolState]);

  useEffect(() => {
    if (!isReady || toolState !== "output-available") return;

    const bridge = bridgeRef.current;
    if (!bridge || !toolOutput) return;

    const serialized = JSON.stringify(toolOutput);
    if (lastToolOutputRef.current === serialized) return;

    lastToolOutputRef.current = serialized;
    bridge.sendToolResult(toolOutput as CallToolResult);
  }, [bridgeRef, isReady, toolOutput, toolState]);

  useEffect(() => {
    if (!isReady || toolState !== "output-error") return;

    const bridge = bridgeRef.current;
    if (!bridge) return;

    const errorMessage =
      toolErrorText ??
      (toolOutput instanceof Error
        ? toolOutput.message
        : typeof toolOutput === "string"
          ? toolOutput
          : "Tool execution failed");

    if (lastToolErrorRef.current === errorMessage) return;

    lastToolErrorRef.current = errorMessage;
    bridge.sendToolCancelled({ reason: errorMessage });
  }, [bridgeRef, isReady, toolErrorText, toolOutput, toolState]);

  useEffect(() => {
    resetStreamingState();
  }, [toolCallId, resetStreamingState]);

  useEffect(() => () => resetStreamingState(), [resetStreamingState]);

  return {
    streamingRenderSignaled,
    setStreamingRenderSignaled,
    canRenderStreamingInput,
    resetStreamingState,
  };
}
