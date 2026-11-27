import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  couldNotRunResult,
  eraSkipMessage,
  failedResult,
  passedResult,
  notApplicableResult,
} from "./helpers.js";
import {
  legacyInitialize,
  type LegacyHandshakeStop,
} from "../legacy-handshake.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  legacyHeaders,
  modernHeaders,
  modernRequestBody,
  rawRequest,
  resumePolledStream,
  unreadPolledAnswerMessage,
  type RawHttpResult,
} from "../raw-http.js";
import { hasWireField } from "../raw-capture.js";

// JSON-RPC "Method not found" — the only conforming error for an unrecognized
// method name (JSON-RPC 2.0 §5.1). Accepting any numeric code would let a
// server pass this check with an unrelated error (e.g. -32602 Invalid params).
const METHOD_NOT_FOUND = -32601;

// 2026-07-28 ties the HTTP status to that error: "If the server does not
// implement the requested RPC method, it MUST respond with `404 Not Found` and
// a JSON-RPC error with code `-32601`" (streamable-http.mdx:271-273). The 2025
// revisions name no status for it, so there the code alone is graded.
const MODERN_METHOD_NOT_FOUND_STATUS = 404;

/**
 * What is wrong with the HTTP status of a `-32601` answer, or `undefined`
 * when nothing is. Only the modern era has a rule about it.
 */
export function invalidMethodStatusProblem(
  era: RawHttpCheckContext["config"]["era"],
  status: number,
): string | undefined {
  if (era !== "modern" || status === MODERN_METHOD_NOT_FOUND_STATUS) {
    return undefined;
  }
  return `Expected HTTP ${MODERN_METHOD_NOT_FOUND_STATUS} Not Found with the ${METHOD_NOT_FOUND} error for an unrecognized method (required on 2026-07-28), got HTTP ${status}`;
}

// Exported so `tests/conformance-catalog.test.ts` can assert the browser-safe
// catalog still matches these canonical strings.
export const PROTOCOL_CHECK_METADATA = {
  "protocol-invalid-method-error": {
    id: "protocol-invalid-method-error",
    category: "protocol",
    title: "Invalid Method Error",
    description:
      "Server answers an unrecognized method name with the JSON-RPC Method not found error (-32601), and with HTTP 404 on 2026-07-28.",
  },
} as const satisfies Record<
  Extract<MCPCheckId, "protocol-invalid-method-error">,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

const INVALID_METHOD = "nonexistent/method_that_does_not_exist";

/**
 * Send the invalid-method probe through the shared raw harness (§15.5): one
 * capture primitive, one place that knows how to frame a request per era.
 *
 *   - Legacy: `initialize` first (to obtain a session for stateful servers),
 *     then the bad-method POST carrying the session id.
 *   - Modern (2026 era): no prelude. The 2026 era is sessionless, so the
 *     bad-method POST stands alone, framed with the `MCP-Protocol-Version`
 *     header and the per-request `_meta` envelope the modern wire requires
 *     (plus the SEP-2243 `Mcp-Method` mirror header). An INCOMPLETE envelope
 *     would be rejected as malformed (-32602) before dispatch, so the probe
 *     would never exercise unknown-method handling at all.
 */
async function sendInvalidMethodProbe(
  ctx: RawHttpCheckContext,
): Promise<RawHttpResult | { stop: LegacyHandshakeStop }> {
  if (ctx.config.era === "modern") {
    const version =
      ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION;
    return await rawRequest(ctx, {
      headers: modernHeaders({
        protocolVersion: version,
        method: INVALID_METHOD,
      }),
      body: modernRequestBody({
        id: 99,
        method: INVALID_METHOD,
        protocolVersion: version,
      }),
    });
  }

  const { sessionId, negotiatedVersion, stop } = await legacyInitialize(ctx);
  if (stop !== undefined) {
    // The handshake did not end in a session on the version this run uses, so
    // the probe is not sent: a refusal it drew would be MCPJam's doing.
    return { stop };
  }
  const protocolVersion =
    negotiatedVersion ??
    ctx.config.protocolVersion ??
    DEFAULT_LEGACY_PROTOCOL_VERSION;
  const response = await rawRequest(ctx, {
    // Only the method name is the test. 2025-06-18 and later require the
    // version header on every request after initialize, so it is sent here
    // like on any other request, with the version the server agreed to: a
    // server that answered an older version may refuse the one we asked for.
    headers: legacyHeaders({ protocolVersion, sessionId }),
    body: {
      jsonrpc: "2.0",
      id: 99,
      method: INVALID_METHOD,
      params: {},
    },
  });
  // A server may hand the error to polling; grading the empty stream it
  // closed would fail it for an answer it did send.
  return await resumePolledStream(ctx, response, {
    sessionId,
    protocolVersion,
  });
}

export async function runProtocolChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  ctx.config.signal?.throwIfAborted();
  const results: MCPCheckResult[] = [];

  if (!selectedCheckIds.has("protocol-invalid-method-error")) {
    return results;
  }

  // Era gate: route the raw protocol track through CHECK_ERAS, the single
  // source of truth shared with the client / security / transport tracks. The
  // invalid-method probe currently applies to both eras, so this is inert
  // today — but keeping the runner on the map means a future reclassification
  // (e.g. the Phase 3 safety valve downgrading it to legacy-only) becomes a
  // safe era-skip instead of silently drifting into a false failure.
  if (!CHECK_ERAS["protocol-invalid-method-error"].includes(ctx.config.era)) {
    results.push(
      notApplicableResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        eraSkipMessage(ctx.config.era, ctx.config.protocolVersion),
      ),
    );
    return results;
  }

  const startedAt = Date.now();
  try {
    const response = await sendInvalidMethodProbe(ctx);
    if ("stop" in response) {
      results.push(
        couldNotRunResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          response.stop.message,
          response.stop.details,
        ),
      );
      return results;
    }
    // `jsonRpcError` reads JSON and SSE bodies alike off the capture, so the
    // check never has to know how the server framed its answer.
    const rpcError = jsonRpcError(response);

    // The server handed the answer to polling and asked for a longer wait
    // than the check had: nothing was graded, so this is not a failure.
    const unread = rpcError
      ? undefined
      : unreadPolledAnswerMessage(response.resumed);
    if (unread !== undefined) {
      results.push(
        couldNotRunResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          unread,
          { status: response.status },
        ),
      );
      return results;
    }

    if (!rpcError) {
      // `jsonRpcError` only reports a WELL-FORMED error (numeric code + string
      // message), so distinguish "no error at all" from "an error member that
      // is not a conforming JSON-RPC error".
      const malformed = hasWireField(response.json, "error");
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          malformed
            ? "JSON-RPC error is malformed: it needs a numeric code and a message string"
            : "Server did not return a JSON-RPC error object for an invalid method",
          {
            status: response.status,
            body: response.json ?? response.bodyText,
          },
        ),
      );
      return results;
    }

    if (rpcError.code !== METHOD_NOT_FOUND) {
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          `Expected JSON-RPC error code ${METHOD_NOT_FOUND} (Method not found) for an unrecognized method, got ${String(rpcError.code)}`,
          {
            status: response.status,
            error: rpcError,
          },
        ),
      );
      return results;
    }

    // The code is right. On 2026-07-28 the status it rides on is graded too.
    const statusProblem = invalidMethodStatusProblem(
      ctx.config.era,
      response.status,
    );
    if (statusProblem !== undefined) {
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          statusProblem,
          {
            status: response.status,
            expectedStatus: MODERN_METHOD_NOT_FOUND_STATUS,
            error: rpcError,
          },
        ),
      );
      return results;
    }

    results.push(
      passedResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        Date.now() - startedAt,
        {
          status: response.status,
          errorCode: rpcError.code,
          errorMessage: rpcError.message,
        },
      ),
    );
  } catch (error) {
    ctx.config.signal?.throwIfAborted();
    results.push(
      failedResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        Date.now() - startedAt,
        error instanceof Error ? error.message : String(error),
        undefined,
        error,
      ),
    );
  }

  return results;
}
