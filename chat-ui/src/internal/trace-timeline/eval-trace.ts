// Rendering-only trace span types for the Tier-A trace timeline.
//
// This is a structural SUBSET of the inspector's `shared/eval-trace.ts`
// `EvalTraceSpan` (which the inspector server + persistence layer own and which
// must NOT move into a UI package). TypeScript is structural, so the inspector's
// richer `EvalTraceSpan[]` assigns directly to `TraceSpan[]` when it consumes
// `<TraceTimeline recordedSpans={...} />` from this package.
//
// Keep these field names in lockstep with the inspector type; a drift here only
// affects what the timeline can read, never what is persisted.

export type TraceSpanCategory = "step" | "llm" | "tool" | "error";
export type TraceSpanStatus = "ok" | "error";

export type TraceSpan = {
  id: string;
  parentId?: string;
  name: string;
  category: TraceSpanCategory;
  /** Milliseconds relative to the trace (or prompt-group) start. */
  startMs: number;
  /** Milliseconds relative to the trace (or prompt-group) start. */
  endMs: number;
  promptIndex?: number;
  stepIndex?: number;
  status?: TraceSpanStatus;
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Inclusive index of the first related transcript message. */
  messageStartIndex?: number;
  /** Inclusive index of the last related transcript message. */
  messageEndIndex?: number;
  // GenAI harness metadata (step/llm spans). Structural subset of the
  // inspector's EvalTraceSpan; the richer type assigns to this for rendering.
  finishReason?: string;
  provider?: string;
  responseId?: string;
  responseTimestamp?: string;
  ttfcMs?: number;
  // MCP error metadata (tool spans). Negative MCP-layer error code from a
  // failed tools/call — server JSON-RPC errors (-32602) OR SDK-local transport
  // failures (-32001 timeout, -32000 connection closed). See mcpErrorCodeLabel.
  mcpErrorCode?: number;
};

/**
 * Error-code names. Source of truth = the MCP SDK `ErrorCode` enum
 * (@modelcontextprotocol/sdk). -32700/-32600/-32601/-32602/-32603 are JSON-RPC
 * 2.0 spec standard; -32000/-32001/-32042 are MCP-SDK additions (-32000/-32001
 * are client-side transport conditions, not server faults). Unmapped codes fall
 * back to the raw number, so drift degrades to "show the code".
 */
const MCP_ERROR_CODE_NAMES: Record<number, string> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
  [-32000]: "Connection closed",
  [-32001]: "Request timeout",
  [-32042]: "URL elicitation required",
};

/** Human label for an MCP error code, e.g. "-32602 · Invalid params". */
export function mcpErrorCodeLabel(code: number): string {
  const name = MCP_ERROR_CODE_NAMES[code];
  return name ? `${code} · ${name}` : String(code);
}

// Internal aliases so the ported timeline keeps its original identifiers
// (`EvalTraceSpan`, `EvalTraceSpanCategory`) without churn. The public export
// name is `TraceSpan` (see src/trace-timeline.ts).
export type EvalTraceSpan = TraceSpan;
export type EvalTraceSpanCategory = TraceSpanCategory;
export type EvalTraceSpanStatus = TraceSpanStatus;
