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
import { decodeResponseBody } from "../raw-capture.js";
import { jsonRpcError, jsonRpcResult } from "../raw-http.js";

/** The `initialize` answer, as much of it as the decision needs. */
export interface InitializeAnswer {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** The response body, verbatim. */
  bodyText: string;
}

export type HandshakeFollowUp =
  /**
   * Initialization did not succeed, so there is no notification to send.
   * `refused`: a status outside 2xx. `error-answer`: a 2xx that carries a
   * JSON-RPC error. `no-result`: a 2xx with no JSON-RPC result to read.
   *
   * `sessionId` is set when a 2xx answer came with one. A server can hand out
   * the session id before its `initialize` handler runs (the official
   * TypeScript SDK does), so an answer that failed can still have opened a
   * session, and that session is closed.
   */
  | {
      kind: "none";
      reason: "refused" | "error-answer" | "no-result";
      sessionId?: string;
    }
  /**
   * The server answered with a version other than the one the run asked for.
   * It only does that when it does not support the one it was asked for, and
   * a run is about one version: MCPJam's pinned client refuses that answer,
   * and so do the other hand-built probes. Nothing is sent but the DELETE that
   * closes the session.
   */
  | { kind: "disconnect"; sessionId?: string; answeredVersion: string }
  /**
   * Initialization succeeded on the version the run asked for: send
   * `notifications/initialized`, then close the session.
   */
  | { kind: "complete"; sessionId?: string };

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decide what follows an `initialize` answer.
 *
 * `requestedVersion` is the version the probe sent, which is the version the
 * run is about.
 */
export function planHandshakeFollowUp(
  answer: InitializeAnswer,
  requestedVersion: string,
): HandshakeFollowUp {
  if (answer.statusCode < 200 || answer.statusCode >= 300) {
    return { kind: "none", reason: "refused" };
  }
  const sessionId = header(answer.headers, "mcp-session-id");
  const session = sessionId ? { sessionId } : {};
  // The same decoder the other raw checks read their answers with.
  const body = decodeResponseBody(
    header(answer.headers, "content-type") ?? "",
    answer.bodyText,
  );
  if (jsonRpcError(body) !== undefined) {
    return { kind: "none", reason: "error-answer", ...session };
  }
  const result = jsonRpcResult(body);
  if (result === undefined) {
    return { kind: "none", reason: "no-result", ...session };
  }

  const answeredVersion = result.protocolVersion;
  if (typeof answeredVersion === "string" && answeredVersion !== requestedVersion) {
    return { kind: "disconnect", ...session, answeredVersion };
  }
  return { kind: "complete", ...session };
}

/**
 * How long one follow-up may wait for its status line. The notification and
 * the DELETE are best effort, so a server that never answers them must not
 * hold the check for its whole timeout, twice. The same bound the readiness
 * probe gives its own closing DELETE.
 */
export function followUpTimeoutMs(checkTimeout: number): number {
  return Math.min(checkTimeout, 3_000);
}
