import type {
  EvalTraceInput,
  EvalTraceSpanInput,
} from "./eval-reporting-types.js";
import type { ToolErrorKind, ToolErrorRecord } from "./predicates/types.js";

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
 * Classify a tool failure on a single persisted trace message part, or `null`
 * if the part is not a failed tool result. Distinguishes:
 *   - `protocol-error` — the call itself failed (AI SDK `error` field /
 *     `error-text` output): JSON-RPC / transport / execution failure.
 *   - `content-error` — an MCP `CallToolResult` with `isError: true`: the tool
 *     ran and reported a domain error the protocol-correct way.
 */
export function classifyToolFailurePart(
  part: unknown,
): { kind: ToolErrorKind; toolName?: string } | null {
  if (!isRecord(part) || typeof part.type !== "string") return null;
  if (part.type !== "tool-result") return null;

  const toolName =
    typeof part.toolName === "string" ? part.toolName : undefined;
  const record = (
    kind: ToolErrorKind,
  ): { kind: ToolErrorKind; toolName?: string } =>
    toolName ? { kind, toolName } : { kind };

  // Transport / execution failures → protocol-error.
  if (typeof part.error === "string" && part.error.trim())
    return record("protocol-error");
  if (
    isRecord(part.error) &&
    typeof part.error.message === "string" &&
    part.error.message.trim()
  ) {
    return record("protocol-error");
  }
  const output = part.output;
  if (isRecord(output) && output.type === "error-text")
    return record("protocol-error");

  // Protocol-correct domain errors (tool ran, isError:true) → content-error.
  if (isRecord(part.result) && part.result.isError === true)
    return record("content-error");
  const unwrapped = unwrapToolOutput(output);
  if (isRecord(unwrapped) && unwrapped.isError === true)
    return record("content-error");
  if (part.isError === true) return record("content-error");

  return null;
}

/**
 * Detect MCP-style tool failure on a single persisted trace message part
 * (aligns with inspector trace viewer heuristics). Behaviour-preserving
 * boolean over {@link classifyToolFailurePart}.
 */
export function traceMessagePartIndicatesToolFailure(part: unknown): boolean {
  return classifyToolFailurePart(part) !== null;
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
  messages: Array<{ role: string; content: unknown }> | undefined
): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg.role !== "string") continue;
    if (walkMessageContent(msg.content)) return true;
  }
  return false;
}

function spansIndicateToolExecutionFailure(
  spans: EvalTraceSpanInput[] | undefined
): boolean {
  if (!Array.isArray(spans)) return false;
  return spans.some((s) => s.category === "tool" && s.status === "error");
}

/**
 * Whether a stored eval trace shows at least one tool execution failure
 * (errored tool spans and/or MCP error tool-results in messages).
 */
export function traceIndicatesToolExecutionFailure(
  trace: EvalTraceInput | undefined
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

function messageToolErrorRecords(
  messages: Array<{ role: string; content: unknown }> | undefined
): ToolErrorRecord[] {
  if (!Array.isArray(messages)) return [];
  const records: ToolErrorRecord[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg.role !== "string") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const classified = classifyToolFailurePart(part);
      if (classified) {
        records.push(
          classified.toolName
            ? { kind: classified.kind, toolName: classified.toolName }
            : { kind: classified.kind }
        );
      }
    }
  }
  return records;
}

function spanToolErrorRecords(
  spans: EvalTraceSpanInput[] | undefined
): ToolErrorRecord[] {
  if (!Array.isArray(spans)) return [];
  const records: ToolErrorRecord[] = [];
  for (const span of spans) {
    if (span.category !== "tool" || span.status !== "error") continue;
    const name = (span as { name?: unknown }).name;
    // An errored tool span = the execution failed → protocol-error.
    records.push(
      typeof name === "string"
        ? { kind: "protocol-error", toolName: name }
        : { kind: "protocol-error" }
    );
  }
  return records;
}

/**
 * Extract classified tool failures from a stored eval trace, for the
 * `noToolErrors` predicate. Mirrors {@link traceIndicatesToolExecutionFailure}'s
 * detection but returns one classified record per failure rather than a boolean.
 */
export function extractToolErrors(
  trace: EvalTraceInput | undefined
): ToolErrorRecord[] {
  if (trace == null || typeof trace === "string") return [];
  if (Array.isArray(trace)) return messageToolErrorRecords(trace);
  if (!isRecord(trace)) return [];
  const messages = trace.messages as
    | Array<{ role: string; content: unknown }>
    | undefined;
  const spans = trace.spans as EvalTraceSpanInput[] | undefined;
  return [...spanToolErrorRecords(spans), ...messageToolErrorRecords(messages)];
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
  /**
   * State-based predicate verdicts (see `./predicates`). When present, the case
   * additionally fails unless every predicate passed. Predicates are their own
   * assertion layer — they apply regardless of `failOnToolError`.
   */
  predicateResults?: ReadonlyArray<{ passed: boolean }>;
};

/**
 * Combine structural pass/fail with tool execution outcomes for eval reporting.
 */
export function finalizePassedForEval(
  params: FinalizeEvalPassedParams
): boolean {
  const { matchPassed, trace, iterationError, failOnToolError, predicateResults } =
    params;
  // The predicate gate is independent of failOnToolError: a failing predicate
  // fails the case even when tool-error gating is disabled.
  if (predicateResults && predicateResults.some((r) => !r.passed)) {
    return false;
  }
  const gateActive = failOnToolError !== false;
  if (!gateActive) {
    return matchPassed;
  }
  if (typeof iterationError === "string" && iterationError.trim().length > 0) {
    return false;
  }
  if (traceIndicatesToolExecutionFailure(trace)) {
    return false;
  }
  return matchPassed;
}
