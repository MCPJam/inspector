import { mergeHeaders } from "../../oauth/state-machines/shared/headers.js";
import {
  buildInitializeRequestBody,
  resolveInitializeProtocolVersion,
} from "../../oauth/state-machines/shared/initialize.js";
import type {
  NormalizedOAuthConformanceConfig,
  TrackedRequestFn,
} from "../types.js";
import {
  buildTransportFailure,
  type OAuthServerObligationInput,
  type OAuthServerObligationOutcome,
} from "./oauth-server-obligations.js";

// Unlike every other check, these requests carry the REAL access token.
// buildTransportFailure redacts the Authorization header before embedding a
// request in error details, so the token never enters a StepResult regardless
// of whether the consumer applies the report-level redaction.
function buildSessionMcpRequest(
  config: NormalizedOAuthConformanceConfig,
  accessToken: string,
  request: {
    method: "POST" | "DELETE";
    sessionId?: string;
    body?: Record<string, unknown>;
  },
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
} {
  // Merged case-insensitively, as the OAuth machines do, so a custom header
  // never rides alongside ours under a different casing.
  const headers = mergeHeaders(config.customHeaders, {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/event-stream",
    ...(request.body ? { "Content-Type": "application/json" } : {}),
    ...(config.protocolVersion !== "2025-03-26"
      ? { "MCP-Protocol-Version": config.protocolVersion }
      : {}),
    ...(request.sessionId ? { "Mcp-Session-Id": request.sessionId } : {}),
  });

  return {
    method: request.method,
    url: config.serverUrl,
    headers,
    ...(request.body ? { body: request.body } : {}),
  };
}

function responseHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/**
 * Finding 5: once a session has ended, a request carrying its id must be
 * answered with HTTP 404. "The server MAY terminate the session at any time,
 * after which it MUST respond to requests containing that session ID with HTTP
 * 404 Not Found" (basic/transports#session-management, every 2025 revision).
 *
 * The requirement binds to a session that really existed and really ended, so
 * the check produces one: it initializes with the access token, ends the
 * session with DELETE, then sends one more request under that session id.
 * Exactly 404 passes; anything else fails.
 *
 * An id the server never issued is NOT that scenario and the spec states no
 * status for it, so the check no longer invents one. Where no ended session
 * can be produced it skips instead of guessing: assigning a session id is MAY,
 * and so is refusing a client DELETE with 405.
 */
export async function runStaleSessionRejectionCheck(
  input: OAuthServerObligationInput,
): Promise<OAuthServerObligationOutcome> {
  const startedAt = Date.now();
  const step = "oauth_stale_session_rejection" as const;
  const skipped = (
    message: string,
    details?: Record<string, unknown>,
  ): OAuthServerObligationOutcome => ({
    step,
    status: "skipped",
    durationMs: Date.now() - startedAt,
    error: { message, ...(details ? { details } : {}) },
  });

  // The 2026-07-28 wire is stateless — there is no Mcp-Session-Id to go stale.
  if (input.config.protocolVersion === "2026-07-28") {
    return {
      step,
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "The 2026-07-28 transport is stateless; there is no session id to invalidate",
      },
    };
  }

  const accessToken = input.state.accessToken;
  if (!accessToken) {
    return {
      step,
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "No access token is available to isolate stale-session handling from authentication",
      },
    };
  }

  // 1. Open a real session.
  const initializeRequest = buildSessionMcpRequest(input.config, accessToken, {
    method: "POST",
    body: buildInitializeRequestBody({
      protocolVersion: resolveInitializeProtocolVersion(
        input.config.protocolVersion,
      ),
      authMode: input.config.auth.mode,
      clientName: "MCPJam SDK OAuth Conformance",
      clientVersion: "1.0.0",
      id: 1002,
    }),
  });
  let initialized: Awaited<ReturnType<TrackedRequestFn>>;
  try {
    initialized = await input.trackedRequest(initializeRequest);
  } catch (error) {
    return buildTransportFailure(
      step,
      startedAt,
      initializeRequest,
      error,
      "Stale-session MCP request failed",
    );
  }

  if (initialized.status < 200 || initialized.status >= 300) {
    return skipped(
      `MCP server answered the authenticated initialize with HTTP ${initialized.status}, so no session could be opened to end`,
      { status: initialized.status, statusText: initialized.statusText },
    );
  }

  const sessionId = responseHeader(initialized.headers, "mcp-session-id");
  if (!sessionId) {
    // Assigning a session id is MAY: a server without one has no session that
    // can end, so the requirement has no subject.
    return skipped(
      "MCP server did not assign an Mcp-Session-Id at initialization; it does not use sessions, so there is no ended session to test",
      { status: initialized.status },
    );
  }

  // 2. Finish the handshake, as the lifecycle requires of a client, before
  //    any other request on the session. Its outcome is not graded here.
  try {
    await input.trackedRequest(
      buildSessionMcpRequest(input.config, accessToken, {
        method: "POST",
        sessionId,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
    );
  } catch {
    // Not graded here. A server that cannot take the notification shows it on
    // the DELETE and the request that follows, which are.
  }

  // 3. End the session.
  let terminated: Awaited<ReturnType<TrackedRequestFn>> | undefined;
  try {
    terminated = await input.trackedRequest(
      buildSessionMcpRequest(input.config, accessToken, {
        method: "DELETE",
        sessionId,
      }),
    );
  } catch {
    terminated = undefined;
  }

  if (!terminated || terminated.status < 200 || terminated.status >= 300) {
    // "The server MAY respond to this request with HTTP 405 Method Not
    // Allowed, indicating that the server does not allow clients to terminate
    // sessions." The session is then still live, and nothing a client sends
    // can end it.
    return skipped(
      terminated
        ? `MCP server answered the session DELETE with HTTP ${terminated.status}, so the session was not ended and there is no ended session to test`
        : "The session DELETE could not be delivered, so the session was not ended and there is no ended session to test",
      terminated ? { deleteStatus: terminated.status } : undefined,
    );
  }

  // 4. Use the ended session id once more. `ping` is the one request every
  //    server answers, so the status reflects the session and nothing else.
  const staleRequest = buildSessionMcpRequest(input.config, accessToken, {
    method: "POST",
    sessionId,
    body: { jsonrpc: "2.0", method: "ping", id: 1003 },
  });
  let response: Awaited<ReturnType<TrackedRequestFn>>;
  try {
    response = await input.trackedRequest(staleRequest);
  } catch (error) {
    return buildTransportFailure(
      step,
      startedAt,
      staleRequest,
      error,
      "Stale-session MCP request failed",
    );
  }

  const durationMs = Date.now() - startedAt;

  if (response.status === 404) {
    return { step, status: "passed", durationMs };
  }

  return {
    step,
    status: "failed",
    durationMs,
    error: {
      message: `MCP server returned HTTP ${response.status} for a request carrying the session id it had just ended; the transport spec requires HTTP 404 Not Found`,
      details: {
        status: response.status,
        statusText: response.statusText,
        deleteStatus: terminated.status,
        response: response.body,
      },
    },
  };
}
