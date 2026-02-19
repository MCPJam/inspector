/**
 * useToolInputStreaming – manages the streaming delivery of tool input to
 * an MCP App bridge.
 *
 * Extracted from mcp-apps-renderer.tsx so the streaming logic can be tested
 * in isolation and extended with debug tooling (e.g. a streaming slider)
 * without touching the renderer component.
 */

import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const PARTIAL_INPUT_THROTTLE_MS = 120;
export const STREAMING_REVEAL_FALLBACK_MS = 700;
export const SIGNATURE_MAX_DEPTH = 4;
export const SIGNATURE_MAX_ARRAY_ITEMS = 24;
export const SIGNATURE_MAX_OBJECT_KEYS = 32;
export const SIGNATURE_STRING_EDGE_LENGTH = 24;
export const PARTIAL_HISTORY_MAX_ENTRIES = 200;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PartialHistoryEntry {
  timestamp: number;
  elapsedFromStart: number;
  input: Record<string, unknown>;
  isFinal?: boolean;
}

export interface StreamingPlaybackData {
  partialHistory: PartialHistoryEntry[];
  replayToPosition: (position: number) => void;
  exitReplay: () => void;
  isReplayActive: boolean;
}

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-denied"
  | "output-error";

// ── Signature helper ─────────────────────────────────────────────────────────

/**
 * Produce a compact structural fingerprint of `input` so we can cheaply
 * detect whether a new streaming partial is meaningfully different from the
 * last one we sent to the bridge.
 */
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

// ── Hook interface ───────────────────────────────────────────────────────────

export interface UseToolInputStreamingParams {
  bridgeRef: React.RefObject<AppBridge | null>;
  isReady: boolean;
  isReadyRef: React.RefObject<boolean>;
  toolState: ToolState | undefined;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  toolErrorText: string | undefined;
  toolCallId: string;
}

export interface UseToolInputStreamingReturn {
  canRenderStreamingInput: boolean;
  /** Called by LoggingTransport onReceive when a size-changed notification arrives. */
  signalStreamingRender: () => void;
  /** Called on CSP mode change (or externally) to clear all streaming state. */
  resetStreamingState: () => void;
  /** Recorded history of partial inputs (populated after streaming completes). */
  partialHistory: PartialHistoryEntry[];
  /** Replay the widget to a specific history position. */
  replayToPosition: (position: number) => void;
  /** Exit replay mode and restore widget to final state. */
  exitReplay: () => void;
  /** Whether the hook is currently in replay mode. */
  isReplayActive: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useToolInputStreaming({
  bridgeRef,
  isReady,
  isReadyRef,
  toolState,
  toolInput,
  toolOutput,
  toolErrorText,
  toolCallId,
}: UseToolInputStreamingParams): UseToolInputStreamingReturn {
  // ── Internal refs ────────────────────────────────────────────────────────

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

  // ── History recording refs ──────────────────────────────────────────────
  const partialHistoryRef = useRef<PartialHistoryEntry[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);

  // ── Internal state ───────────────────────────────────────────────────────

  const [streamingRenderSignaled, setStreamingRenderSignaled] = useState(false);
  const [hasDeliveredStreamingInput, setHasDeliveredStreamingInput] =
    useState(false);
  const [partialHistory, setPartialHistory] = useState<PartialHistoryEntry[]>(
    [],
  );
  const [isReplayActive, setIsReplayActive] = useState(false);

  // ── Derived values ───────────────────────────────────────────────────────

  const hasToolInputData = useMemo(
    () => !!toolInput && Object.keys(toolInput).length > 0,
    [toolInput],
  );

  const canRenderStreamingInput = useMemo(() => {
    if (toolState !== "input-streaming") return true;
    return streamingRenderSignaled && hasDeliveredStreamingInput;
  }, [hasDeliveredStreamingInput, streamingRenderSignaled, toolState]);

  // ── Callbacks ────────────────────────────────────────────────────────────

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
    partialHistoryRef.current = [];
    recordingStartTimeRef.current = null;
    setPartialHistory([]);
    setIsReplayActive(false);
  }, []);

  const signalStreamingRender = useCallback(() => {
    setStreamingRenderSignaled(true);
  }, []);

  const recordPartialEntry = useCallback(
    (input: Record<string, unknown>, isFinal?: boolean) => {
      if (partialHistoryRef.current.length >= PARTIAL_HISTORY_MAX_ENTRIES)
        return;
      const now = Date.now();
      if (recordingStartTimeRef.current === null) {
        recordingStartTimeRef.current = now;
      }
      partialHistoryRef.current.push({
        timestamp: now,
        elapsedFromStart: now - recordingStartTimeRef.current,
        input: structuredClone(input),
        isFinal,
      });
    },
    [],
  );

  // ── Replay callbacks ──────────────────────────────────────────────────────

  const replayToPosition = useCallback(
    (position: number) => {
      const bridge = bridgeRef.current;
      if (!bridge || !isReadyRef.current) return;
      const history = partialHistoryRef.current;
      if (position < 0 || position >= history.length) return;

      setIsReplayActive(true);

      // Clear dedup guards so bridge accepts the replayed message
      lastToolInputRef.current = null;
      lastToolInputPartialRef.current = null;

      const entry = history[position];
      if (entry.isFinal) {
        Promise.resolve(
          bridge.sendToolInput({ arguments: entry.input }),
        ).catch(() => {});
      } else {
        Promise.resolve(
          bridge.sendToolInputPartial({ arguments: entry.input }),
        ).catch(() => {});
      }
    },
    [bridgeRef, isReadyRef],
  );

  const exitReplay = useCallback(() => {
    setIsReplayActive(false);

    // Restore widget to final state
    const bridge = bridgeRef.current;
    if (!bridge || !isReadyRef.current) return;
    const history = partialHistoryRef.current;
    if (history.length === 0) return;

    const finalEntry = history[history.length - 1];
    lastToolInputRef.current = null;
    Promise.resolve(
      bridge.sendToolInput({ arguments: finalEntry.input }),
    ).catch(() => {});
  }, [bridgeRef, isReadyRef]);

  // ── Effects ──────────────────────────────────────────────────────────────

  // 1. Clear reveal timer when signaled
  useEffect(() => {
    if (!streamingRenderSignaled) return;
    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }
  }, [streamingRenderSignaled]);

  // 2. Fallback reveal timer
  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || streamingRenderSignaled)
      return;
    if (streamingRevealTimerRef.current !== null) return;

    streamingRevealTimerRef.current = window.setTimeout(() => {
      streamingRevealTimerRef.current = null;
      setStreamingRenderSignaled(true);
    }, STREAMING_REVEAL_FALLBACK_MS);
  }, [isReady, streamingRenderSignaled, toolState]);

  // 3. Re-entry detection
  useEffect(() => {
    const prevToolState = previousToolStateRef.current;

    // Some providers may re-enter input-streaming for a new call while reusing
    // the same toolCallId. Reset send guards so we can stream/send fresh input.
    if (
      toolState === "input-streaming" &&
      prevToolState &&
      prevToolState !== "input-streaming"
    ) {
      resetStreamingState();
    }

    previousToolStateRef.current = toolState;
  }, [resetStreamingState, toolState]);

  // 4. Partial input throttled delivery
  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || toolInputSentRef.current)
      return;
    if (!hasToolInputData) return;
    const resolvedToolInput = toolInput ?? {};
    pendingToolInputPartialRef.current = resolvedToolInput;

    const flushPartialInput = () => {
      const bridge = bridgeRef.current;
      if (!bridge || !isReadyRef.current || toolInputSentRef.current) return;
      const pending = pendingToolInputPartialRef.current;
      if (!pending) return;

      const signature = getToolInputSignature(pending);
      if (lastToolInputPartialRef.current === signature) return;
      lastToolInputPartialRef.current = signature;
      lastToolInputPartialSentAtRef.current = Date.now();
      setHasDeliveredStreamingInput(true);
      setStreamingRenderSignaled(true);
      recordPartialEntry(pending);
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
  }, [hasToolInputData, isReady, toolInput, toolState, bridgeRef, isReadyRef, recordPartialEntry]);

  // 5. Complete input delivery
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
    // Allow live editors/previews to update tool input repeatedly while keeping
    // duplicate sends suppressed for identical payloads.
    if (lastToolInputRef.current === serialized) {
      toolInputSentRef.current = true;
      return;
    }
    lastToolInputRef.current = serialized;
    toolInputSentRef.current = true;
    recordPartialEntry(resolvedToolInput, true);
    setPartialHistory([...partialHistoryRef.current]);
    Promise.resolve(
      bridge.sendToolInput({ arguments: resolvedToolInput }),
    ).catch(() => {
      toolInputSentRef.current = false;
      lastToolInputRef.current = null;
    });
  }, [isReady, toolInput, toolState, bridgeRef, recordPartialEntry]);

  // 6. Tool result delivery
  useEffect(() => {
    if (!isReady || toolState !== "output-available") return;
    const bridge = bridgeRef.current;
    if (!bridge || !toolOutput) return;

    const serialized = JSON.stringify(toolOutput);
    if (lastToolOutputRef.current === serialized) return;
    lastToolOutputRef.current = serialized;
    bridge.sendToolResult(toolOutput as CallToolResult);
  }, [isReady, toolOutput, toolState, bridgeRef]);

  // 7. Tool error/cancellation delivery
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

    // SEP-1865: Send tool-cancelled for errors instead of tool-result with isError
    bridge.sendToolCancelled({ reason: errorMessage });
  }, [isReady, toolErrorText, toolOutput, toolState, bridgeRef]);

  // 8. Reset on toolCallId change
  useEffect(() => {
    resetStreamingState();
  }, [toolCallId, resetStreamingState]);

  // 9. Cleanup on unmount
  useEffect(() => {
    return () => resetStreamingState();
  }, [resetStreamingState]);

  return {
    canRenderStreamingInput,
    signalStreamingRender,
    resetStreamingState,
    partialHistory,
    replayToPosition,
    exitReplay,
    isReplayActive,
  };
}
