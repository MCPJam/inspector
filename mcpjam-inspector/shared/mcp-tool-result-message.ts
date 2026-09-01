/**
 * The one place that knows what a tool-result message looks like.
 *
 * Two engines produce these. The EMULATED engine builds them in
 * `http-tool-calls.ts` as it executes tools itself. The HARNESS engine cannot:
 * a real agent runtime executes tools inside its own sandbox and MCPJam only
 * sees the traffic at its MCP proxy, so a harness run's trace transcript has to
 * be PROJECTED from evidence rows after the fact.
 *
 * If those two projections are written twice they drift, and the drift is
 * invisible in the worst way: predicates and the judge read whichever
 * transcript they were handed, so "the same tool result" starts grading
 * differently depending on which engine produced it — which is the exact
 * comparison harness/emulated parity exists to make possible. Hence one
 * builder, used by both.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: project the model-visible `output` from a
 * raw result. That projection is the SDK's (`mcpCallToolResultToModelOutput`
 * and its linked-resource variant) and depends on per-call policy, resource
 * reading and MCP-App scrubbing that only the executing engine has in hand.
 * Callers pass the `output` they already computed; this file decides the
 * message SHAPE around it.
 */
import type { ToolResultPart } from "ai";
import { mergeMcpToolOriginMetadata } from "./mcp-tool-origin-metadata";

/** The `role: "tool"` message shape both engines persist. */
export type McpToolResultMessage = {
  role: "tool";
  content: Array<Record<string, unknown>>;
};

export type McpToolResultMessageInput = {
  toolCallId: string;
  toolName: string;
  /** Resolved target server, as the bridge routed it. Drives widget resolution. */
  serverId?: string;
  /** Model-visible output, already projected by the caller. */
  output: ToolResultPart;
  /**
   * The raw `CallToolResult` — `_meta`, `structuredContent` and all.
   *
   * Kept beside the model-visible output rather than replacing it, because the
   * two answer different questions: `output` is what the model saw, `result` is
   * what the server returned. Widget hydration and evidence-graded assertions
   * need the second; a transcript that carried only the first cannot tell a
   * server that returned nothing from one whose output was scrubbed.
   */
  rawResult?: unknown;
  /**
   * Whether to attach `rawResult`. Explicit rather than inferred from
   * `rawResult !== undefined`: the MCP-App path deliberately withholds the raw
   * result unless the tool opts in, and a caller passing the result "just in
   * case" must not accidentally publish it.
   */
  includeRawResult?: boolean;
};

/**
 * Build the tool-result message for a call that RETURNED — including one that
 * returned `isError: true`.
 *
 * A `CallToolResult` with `isError` is not a transport failure; it is a domain
 * error the model is meant to read and react to, and it travels the same shape
 * as a success. Only a thrown/JSON-RPC failure gets the error shape below.
 */
export function buildMcpToolResultMessage(
  input: McpToolResultMessageInput,
): McpToolResultMessage {
  const includeRaw = input.includeRawResult ?? input.rawResult !== undefined;
  return {
    role: "tool" as const,
    content: [
      {
        type: "tool-result",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: input.output,
        ...(includeRaw ? { result: input.rawResult } : {}),
        serverId: input.serverId,
        ...(input.serverId
          ? {
              providerOptions: mergeMcpToolOriginMetadata(
                undefined,
                input.serverId,
              ),
            }
          : {}),
      },
    ],
  };
}

/**
 * Build the tool-result message for a call that FAILED to return a result at
 * all — a thrown execution error, or the JSON-RPC error envelope the bridge
 * generates for one.
 *
 * Carries no `result` and no `serverId`, matching the emulated engine's catch
 * path: there is no server result to preserve, and attaching an origin to a
 * call that never reached its server would make a failure look like a reply.
 */
export function buildMcpToolErrorResultMessage(input: {
  toolCallId: string;
  toolName: string;
  /**
   * The error output part. Taken already-shaped rather than built from a
   * string, because the emulated path reshapes some failures before they reach
   * the model (a `-32042` URL elicitation becomes a retry hint, not a raw
   * protocol error) and that shaping belongs to the caller that understands
   * the failure.
   */
  output: ToolResultPart;
}): McpToolResultMessage {
  return {
    role: "tool" as const,
    content: [
      {
        type: "tool-result",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: input.output,
      },
    ],
  };
}

/**
 * An `error-text` output part carrying `message`.
 *
 * `ToolResultPart` in the AI SDK describes the whole part (tool name, call id
 * and all) rather than just its `output`, so the two do not structurally
 * overlap and a direct cast is rejected. The double cast is the honest
 * spelling of what the emulated engine already does inline at its own catch —
 * this is the same value, named once.
 */
export function mcpToolErrorOutput(message: string): ToolResultPart {
  return { type: "error-text", value: message } as unknown as ToolResultPart;
}

/**
 * The message text for a JSON-RPC error envelope, in the shape the emulated
 * engine's catch produces from a thrown `Error` — its `message`, nothing else.
 *
 * The code is NOT folded into the text. It rides the trace span's
 * `mcpErrorCode` instead, where a reader can match on it; concatenating it
 * here would make every assertion about an error message depend on a number
 * that is already recorded elsewhere.
 */
export function jsonRpcErrorMessageText(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    const nested = (error as { error?: { message?: unknown } }).error?.message;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "Tool call failed";
}
