import type { EvalTraceInput, EvalTraceSpanInput } from "./eval-reporting-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when an MCP {@link https://modelcontextprotocol.io CallToolResult}
 * indicates a tool execution error (`isError: true`).
 */
export function isCallToolResultError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function unwrapToolOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (!("type" in output) || !("value" in output)) return output;
  return output.value;
}

/**
 * Detect MCP-style tool failure on a single persisted trace message part
 * (aligns with inspector trace viewer heuristics).
 */
export function traceMessagePartIndicatesToolFailure(part: unknown): boolean {
  if (!isRecord(part) || typeof part.type !== "string") return false;
  if (part.type !== "tool-result") return false;

  if (typeof part.error === "string" && part.error.trim()) return true;
  if (
    isRecord(part.error) &&
    typeof part.error.message === "string" &&
    part.error.message.trim()
  ) {
    return true;
  }

  const output = part.output;
  if (isRecord(output) && output.type === "error-text") return true;

  if (isRecord(part.result) && part.result.isError === true) return true;

  const unwrapped = unwrapToolOutput(output);
  if (isRecord(unwrapped) && unwrapped.isError === true) return true;

  if (part.isError === true) return true;

  return false;
}

function walkMessageContent(content: unknown): boolean {
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (traceMessagePartIndicatesToolFailure(part)) return true;
  }
  return false;
}

function messagesIndicateToolExecutionFailure(
  messages: Array<{ role: string; content: unknown }> | undefined,
): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg.role !== "string") continue;
    if (walkMessageContent(msg.content)) return true;
  }
  return false;
}

function spansIndicateToolExecutionFailure(
  spans: EvalTraceSpanInput[] | undefined,
): boolean {
  if (!Array.isArray(spans)) return false;
  return spans.some(
    (s) => s.category === "tool" && s.status === "error",
  );
}

/**
 * Whether a stored eval trace shows at least one tool execution failure
 * (errored tool spans and/or MCP error tool-results in messages).
 */
export function traceIndicatesToolExecutionFailure(
  trace: EvalTraceInput | undefined,
): boolean {
  if (trace == null) return false;
  if (typeof trace === "string") return false;

  if (Array.isArray(trace)) {
    return messagesIndicateToolExecutionFailure(trace);
  }

  if (!isRecord(trace)) return false;

  const messages = trace.messages as
    | Array<{ role: string; content: unknown }>
    | undefined;
  const spans = trace.spans as EvalTraceSpanInput[] | undefined;

  if (spansIndicateToolExecutionFailure(spans)) return true;
  if (messagesIndicateToolExecutionFailure(messages)) return true;
  return false;
}

export type FinalizeEvalPassedParams = {
  /** Pass/fail from tool-call matching or user test assertion */
  matchPassed: boolean;
  trace?: EvalTraceInput;
  /** Non-empty when the runner aborted due to a step/tool/network error */
  iterationError?: string | null;
  /**
   * When not `false`, failed tool executions and iteration errors fail the case.
   * Default: treat as `true`.
   */
  failOnToolError?: boolean;
};

/**
 * Combine structural pass/fail with tool execution outcomes for eval reporting.
 */
export function finalizePassedForEval(
  params: FinalizeEvalPassedParams,
): boolean {
  const { matchPassed, trace, iterationError, failOnToolError } = params;
  const gateActive = failOnToolError !== false;
  if (!gateActive) {
    return matchPassed;
  }
  if (
    typeof iterationError === "string" &&
    iterationError.trim().length > 0
  ) {
    return false;
  }
  if (traceIndicatesToolExecutionFailure(trace)) {
    return false;
  }
  return matchPassed;
}
