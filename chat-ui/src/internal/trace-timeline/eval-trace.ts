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
  // MCP server-contract metadata (tool spans).
  mcpErrorCode?: number;
};

// Internal aliases so the ported timeline keeps its original identifiers
// (`EvalTraceSpan`, `EvalTraceSpanCategory`) without churn. The public export
// name is `TraceSpan` (see src/trace-timeline.ts).
export type EvalTraceSpan = TraceSpan;
export type EvalTraceSpanCategory = TraceSpanCategory;
export type EvalTraceSpanStatus = TraceSpanStatus;
