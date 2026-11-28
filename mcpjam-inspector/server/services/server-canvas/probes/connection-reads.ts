/**
 * Reads the background probes make on a live connection, and how their
 * failures are told apart.
 *
 * A read goes straight to the connection's client, not through the manager's
 * multi-round-trip loop: a result that answers `input_required` would
 * otherwise reach the input collector, which asks the user. Without opting
 * in, the client refuses such a result, and the read counts as `input`.
 *
 * Only a failure the server itself caused is graded: a JSON-RPC error answer
 * or a result that is not valid. A timeout, an abort, a closed connection or a
 * network error says nothing about the server, so it is `unanswered` and no
 * check fails because of it.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import {
  isInvalidEventsPayloadError,
  isUnsupportedResultType,
  type MCPAppsResourceReadOutcome,
  type MCPClientManager,
} from "@mcpjam/sdk";
import { isRecord } from "./shared.js";

export type ReadResourceResult = NonNullable<MCPAppsResourceReadOutcome["result"]>;

export type ConnectionRead =
  | { kind: "read"; result: ReadResourceResult }
  /** The server answered with an error or an invalid result. */
  | { kind: "error"; error: unknown }
  /** The server asked for input. */
  | { kind: "input" }
  /** No answer: timed out, connection closed, or the network failed. */
  | { kind: "unanswered" }
  /** The probe's own budget ran out. */
  | { kind: "stopped" };

/** Whether a failed request failed because of what the server answered. */
export function serverAnswered(error: unknown): boolean {
  if (ProtocolError.isInstance(error)) return true;
  if (SdkError.isInstance(error)) return error.code === SdkErrorCode.InvalidResult;
  return isInvalidEventsPayloadError(error);
}

/** Whether the server answered a request by asking for input. */
export function askedForInput(error: unknown): boolean {
  return (
    isUnsupportedResultType(error) ||
    (ProtocolError.isInstance(error) &&
      error.code === ProtocolErrorCode.UrlElicitationRequired)
  );
}

/** One `resources/read` of `uri` on the connection; never throws. */
export async function readOnConnection(
  manager: Pick<MCPClientManager, "getManagedClient">,
  managerKey: string,
  uri: string,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<ConnectionRead> {
  const client = manager.getManagedClient(managerKey);
  if (!client) return { kind: "unanswered" };
  try {
    const result: ReadResourceResult = await client.readResource(
      { uri },
      { signal: options.signal, timeout: options.timeoutMs, cacheMode: "bypass" },
    );
    const raw: unknown = result;
    if (isRecord(raw) && raw.resultType === "input_required") {
      return { kind: "input" };
    }
    return { kind: "read", result };
  } catch (error) {
    if (askedForInput(error)) return { kind: "input" };
    if (options.signal.aborted) return { kind: "stopped" };
    return serverAnswered(error) ? { kind: "error", error } : { kind: "unanswered" };
  }
}
