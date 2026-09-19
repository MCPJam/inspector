export type EvalExpectedToolCall = {
  toolName: string;
  arguments?: Record<string, unknown>;
};

export type EvalTraceSpanCategory =
  | "step"
  | "llm"
  | "tool"
  | "error"
  | "connection"
  | "discovery";
export type EvalTraceSpanStatus = "ok" | "error";

export type EvalTraceSpanInput = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
  promptIndex?: number;
  stepIndex?: number;
  status?: EvalTraceSpanStatus;
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  // GenAI harness metadata (step/llm spans). Mirror of inspector
  // shared/eval-trace.ts EvalTraceSpan; kept in parity via the shared fixture.
  finishReason?: string;
  provider?: string;
  responseId?: string;
  responseTimestamp?: string;
  ttfcMs?: number;
  // MCP server-contract metadata (tool spans). JSON-RPC error code from a
  // failed tools/call (OTel rpc.response.status_code).
  mcpErrorCode?: number;
  // Harness evidence provenance (tool spans on harness runs): where the
  // recorded output came from, and whether the wire corroborates it. Mirror of
  // the inspector's `EvalTraceSpan`; see it for what each field claims. An SDK
  // producer normally leaves these absent — they describe MCPJam's own proxy
  // seam, which an externally-executed run does not have.
  outputSource?: "narration" | "evidence" | "reconstructed";
  wireCorroborated?: boolean;
  evidenceRequestId?: string;
  evidenceStatus?: "complete" | "incomplete";
};

export type EvalTraceInput =
  | string
  | Array<{ role: string; content: unknown }>
  | {
      recordedContext?: unknown;
      widgetSnapshots?: unknown[];
      messages?: Array<{ role: string; content: unknown }>;
      spans?: EvalTraceSpanInput[];
      prompts?: unknown[];
      raw?: unknown;
    };
