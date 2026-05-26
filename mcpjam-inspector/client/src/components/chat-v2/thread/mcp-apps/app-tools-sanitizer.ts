import type { CallToolResult } from "@modelcontextprotocol/client";

/**
 * Result of an App-Provided Tool call, narrowed to what's safe to put
 * into the model's tool-result message part.
 *
 * Per SEP-1865, `content` is the model-facing surface. `structuredContent`
 * and `_meta` are UI/metadata and must not leak into model context — the
 * server already enforces this for MCP server tool results via
 * `scrubPayload` in `server/utils/chat-helpers.ts`. This is the client-side
 * mirror for results that originated in an iframe (App-Provided Tools)
 * and are injected directly via `addToolOutput` without round-tripping
 * the server scrubber.
 */
export type ModelSafeAppToolResult = {
  content: CallToolResult["content"];
  isError?: boolean;
};

export function scrubAppToolResultForModel(
  result: CallToolResult,
): ModelSafeAppToolResult {
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
  };
}
