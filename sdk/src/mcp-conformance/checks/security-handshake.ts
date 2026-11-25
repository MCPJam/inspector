/**
 * What a client does after the `initialize` it sent by hand was answered.
 *
 * The localhost host-header checks build `initialize` with `node:http`, because
 * `fetch` cannot set `Host`. That makes each one a session of its own, opened
 * outside the normal client, so the rest of the handshake is theirs to finish:
 * "After successful initialization, the client MUST send an `initialized`
 * notification to indicate it is ready to begin normal operations."
 *
 * This module only decides. `security.ts` sends.
 */

import type { IncomingHttpHeaders } from "node:http";
import { isKnownProtocolVersion } from "../../mcp-client-manager/mcp-protocol-version.js";
import { parseSseEvents } from "../raw-capture.js";

/** The `initialize` answer, as much of it as the decision needs. */
export interface InitializeAnswer {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** The response body, verbatim. */
  bodyText: string;
}

export type HandshakeFollowUp =
  /**
   * Initialization did not succeed, so there is no notification to send and no
   * session to close. `refused`: a status outside 2xx, or a JSON-RPC error.
   * `no-result`: a 2xx answer with no JSON-RPC result to read.
   */
  | { kind: "none"; reason: "refused" | "no-result" }
  /**
   * The server answered with a version MCPJam does not support. "If the client
   * does not support the version in the server's response, it SHOULD
   * disconnect", so nothing is sent but the DELETE that closes the session.
   */
  | { kind: "disconnect"; sessionId?: string; answeredVersion: string }
  /**
   * Initialization succeeded: send `notifications/initialized`, then close the
   * session. `protocolVersion` is the negotiated version, which goes in
   * `MCP-Protocol-Version` on both.
   */
  | { kind: "complete"; sessionId?: string; protocolVersion: string };

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every JSON-RPC message in the body, whether it came as JSON or as SSE. */
function jsonRpcMessages(answer: InitializeAnswer): Record<string, unknown>[] {
  const contentType = header(answer.headers, "content-type") ?? "";
  const parsed: unknown[] = [];
  if (contentType.toLowerCase().includes("text/event-stream")) {
    for (const event of parseSseEvents(answer.bodyText)) {
      if (event.json !== undefined) parsed.push(event.json);
    }
  } else if (answer.bodyText !== "") {
    try {
      parsed.push(JSON.parse(answer.bodyText));
    } catch {
      // Not JSON: there is no message to read, which the caller reports as
      // "no-result". Nothing else to do with a body that does not parse.
    }
  }
  return parsed
    .map(asRecord)
    .filter((message): message is Record<string, unknown> => message !== undefined);
}

/**
 * Decide what follows an `initialize` answer.
 *
 * `requestedVersion` is the version the probe sent. It stands in for the
 * negotiated one when the answer names none.
 */
export function planHandshakeFollowUp(
  answer: InitializeAnswer,
  requestedVersion: string,
): HandshakeFollowUp {
  if (answer.statusCode < 200 || answer.statusCode >= 300) {
    return { kind: "none", reason: "refused" };
  }
  const messages = jsonRpcMessages(answer);
  if (messages.some((message) => asRecord(message.error) !== undefined)) {
    return { kind: "none", reason: "refused" };
  }
  const result = messages
    .map((message) => asRecord(message.result))
    .find((payload) => payload !== undefined);
  if (result === undefined) {
    return { kind: "none", reason: "no-result" };
  }

  const sessionId = header(answer.headers, "mcp-session-id");
  const session = sessionId ? { sessionId } : {};
  const answeredVersion = result.protocolVersion;
  if (typeof answeredVersion !== "string") {
    return { kind: "complete", ...session, protocolVersion: requestedVersion };
  }
  if (!isKnownProtocolVersion(answeredVersion)) {
    return { kind: "disconnect", ...session, answeredVersion };
  }
  return { kind: "complete", ...session, protocolVersion: answeredVersion };
}
