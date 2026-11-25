import { ProtocolError } from "@modelcontextprotocol/client";

/** Longest refusal text a launch error carries; the run group's failure line is capped near 500. */
export const SERVER_REFUSAL_MAX_CHARS = 300;

const WORDED_REFUSAL = /^MCP error -?\d+:\s*(.+)$/s;

/**
 * What the server itself said when it answered a request with a JSON-RPC error
 * (a mock names the tool it edits that the real server lost). The client
 * raises such an answer as a `ProtocolError` carrying only the server's text;
 * a listing recorded as a string has it worded "MCP error <code>: <text>". A
 * transport failure is neither, so only these shapes are passed on and the
 * rest keeps the generic wording.
 */
export function serverRefusalText(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const text =
    error instanceof ProtocolError
      ? error.message.trim()
      : WORDED_REFUSAL.exec(error.message.trim())?.[1]?.trim();
  if (!text) return undefined;
  return text.length > SERVER_REFUSAL_MAX_CHARS
    ? `${text.slice(0, SERVER_REFUSAL_MAX_CHARS - 1)}…`
    : text;
}

/**
 * The text a tool snapshot keeps for a server it could not list. A server's
 * own refusal keeps the worded shape `serverRefusalText` reads back, because
 * the snapshot holds a string, not the error: without the prefix a refusal
 * and a transport failure look alike when the launch is refused.
 */
export function snapshotCaptureError(error: unknown): string {
  if (error instanceof ProtocolError) {
    return `MCP error ${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
