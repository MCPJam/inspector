import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import { jsonRpcResult } from "../raw-http.js";
import { concurrentProbe, PING_ANSWERED_AS_JSON } from "./concurrent-probe.js";
import { inspectSseStreamMessages } from "./sse-stream-messages.js";
import {
  blockedResult,
  errorMessage,
  eraSkipMessage,
  failedResult,
  couldNotRunResult,
  notApplicableResult,
  passedResult,
} from "./helpers.js";
import { legacyInitialize, type LegacyHandshake } from "../legacy-handshake.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  legacyHeaders,
  modernHeaders,
  modernRequestBody,
  rawHeadersProbe,
  rawRequest,
  pollingOutcome,
  resumePolledStream,
  type RawHttpResult,
} from "../raw-http.js";

type TransportCheckId = keyof typeof TRANSPORT_CHECK_METADATA;

// Exported so `tests/conformance-catalog.test.ts` can assert the browser-safe
// catalog still matches these canonical strings.
export const TRANSPORT_CHECK_METADATA = {
  "server-sse-polling-session": {
    id: "server-sse-polling-session",
    category: "transport",
    title: "SSE Polling Session",
    description: "Server provides a streamable HTTP session id.",
  },
  "server-sse-streams-functional": {
    id: "server-sse-streams-functional",
    category: "transport",
    title: "Functional SSE Streams",
    description: "Concurrent SSE streams remain readable.",
  },
  "notification-post-accepted": {
    id: "notification-post-accepted",
    category: "transport",
    title: "Notification POST Accepted",
    description:
      "A POST carrying only a JSON-RPC notification is answered with HTTP 202 Accepted and no body.",
  },
  "get-stream-or-405": {
    id: "get-stream-or-405",
    category: "transport",
    title: "GET Opens SSE Or Returns 405",
    description:
      "A GET to the MCP endpoint either opens a text/event-stream response or returns HTTP 405 Method Not Allowed.",
  },
  "session-id-visible-ascii": {
    id: "session-id-visible-ascii",
    category: "transport",
    title: "Session Id Visible ASCII",
    description:
      "A minted session id contains only visible ASCII characters (0x21 to 0x7E).",
  },
  "post-response-content-type": {
    id: "post-response-content-type",
    category: "transport",
    title: "POST Response Content-Type",
    description:
      "The response to a JSON-RPC request carries Content-Type application/json or text/event-stream.",
  },
} as const satisfies Record<
  Extract<
    MCPCheckId,
    | "server-sse-polling-session"
    | "server-sse-streams-functional"
    | "notification-post-accepted"
    | "get-stream-or-405"
    | "session-id-visible-ascii"
    | "post-response-content-type"
  >,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

/**
 * SSE framing, body decoding, timeouts, and auth headers all come from the
 * shared raw harness (§15.5). This module used to carry its own incremental
 * SSE reader (`processSseLines` / `readSseEvents`) and its own response
 * decoder; both were deleted in favor of `rawRequest`, whose capture reports
 * `sse` frames parsed by the ONE `parseSseEvents` implementation.
 */

function isOk(result: RawHttpResult): boolean {
  return result.status >= 200 && result.status < 300;
}

/**
 * The bare media type, with parameters (`; charset=…`) and casing stripped.
 *
 * Every content-type verdict in this module goes through here so none of them
 * can drift back to a substring test: `text/event-streamish` and
 * `application/text/event-stream` both CONTAIN the required token without
 * being it, and either would otherwise read as a conforming stream.
 */
function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The transport MUST — identical in every revision, 2025-03-26 through
 * 2026-07-28 — names exactly two permitted response content types for a
 * JSON-RPC request.
 */
function isAllowedPostResponseContentType(contentType: string): boolean {
  const mediaType = mediaTypeOf(contentType);
  return mediaType === "application/json" || mediaType === "text/event-stream";
}

/**
 * "The session ID MUST only contain visible ASCII characters (ranging from
 * 0x21 to 0x7E)" — every 2025 revision, verbatim. ONLY the charset is a MUST;
 * uniqueness and cryptographic strength are SHOULD and are deliberately not
 * judged here.
 */
function invalidSessionIdCharacters(sessionId: string): string[] {
  const invalid = new Set<string>();
  for (const char of sessionId) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) {
      invalid.add(
        `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
  return [...invalid];
}

/** The checks that send more requests on the session the handshake opened. */
const SESSION_PROBE_CHECKS = [
  "server-sse-streams-functional",
  "notification-post-accepted",
  "get-stream-or-405",
] as const;

async function initializeSession(
  ctx: RawHttpCheckContext,
  recordInitialized: boolean,
): Promise<
  LegacyHandshake & {
    ok: boolean;
    status: number;
    body: unknown;
    contentType: string;
    /** The capabilities the `initialize` answer declared, as sent. */
    capabilities: unknown;
    isMcpLayerResponse: boolean;
  }
> {
  const handshake = await legacyInitialize(ctx, { recordInitialized });
  const { result } = handshake;
  return {
    ...handshake,
    ok: isOk(result),
    status: result.status,
    body: result.json ?? (result.bodyText || undefined),
    contentType: result.headers["content-type"] ?? "",
    capabilities: jsonRpcResult(result)?.capabilities,
    // Whether the server answered at the MCP layer at all. A non-2xx carrying
    // a JSON-RPC error IS the server's own response, so response-framing MUSTs
    // still bind to it; a non-2xx without one came from something in front of
    // the server (auth gateway, proxy) and binds to nothing here.
    isMcpLayerResponse: isOk(result) || jsonRpcError(result) !== undefined,
  };
}

function contentTypeCheckResult(
  contentType: string,
  durationMs: number,
  details: Record<string, unknown>,
): MCPCheckResult {
  const metadata = TRANSPORT_CHECK_METADATA["post-response-content-type"];
  return isAllowedPostResponseContentType(contentType)
    ? passedResult(metadata, durationMs, { contentType, ...details })
    : failedResult(
        metadata,
        durationMs,
        `Expected the response to a JSON-RPC request to carry Content-Type application/json or text/event-stream, got "${contentType || "(no content-type)"}"`,
        { contentType, ...details },
      );
}

/**
 * The modern half of `post-response-content-type`. The 2026 wire has no
 * initialize prelude, so the probe is a self-contained `tools/list` carrying
 * the full `_meta` envelope — an incomplete envelope would be rejected before
 * the response whose framing this check judges is ever produced.
 */
async function modernPostResponseContentTypeCheck(
  ctx: RawHttpCheckContext,
): Promise<MCPCheckResult> {
  const metadata = TRANSPORT_CHECK_METADATA["post-response-content-type"];
  const startedAt = Date.now();
  const version = ctx.config.protocolVersion ?? "2026-07-28";
  try {
    const result = await rawRequest(ctx, {
      headers: modernHeaders({
        protocolVersion: version,
        method: "tools/list",
      }),
      body: modernRequestBody({
        id: 1300,
        method: "tools/list",
        protocolVersion: version,
      }),
    });
    if (!isOk(result) && jsonRpcError(result) === undefined) {
      // A non-2xx that carries no JSON-RPC error is not an MCP-layer response
      // at all — an OAuth gateway's 401 HTML page, a proxy 404, a load
      // balancer 502. The server under test never framed it, so failing the
      // content-type MUST on it would blame the wrong party. A non-2xx that
      // DOES carry a JSON-RPC error is the server answering, and the MUST
      // applies to it in full (falls through to the judgement below).
      return couldNotRunResult(
        metadata,
        `tools/list returned HTTP ${result.status} with no JSON-RPC error body, so no MCP-layer response was observed to judge`,
        { status: result.status },
      );
    }
    return contentTypeCheckResult(
      result.headers["content-type"] ?? "",
      Date.now() - startedAt,
      { method: "tools/list", status: result.status },
    );
  } catch (error) {
    return couldNotRunResult(
      metadata,
      `tools/list request failed: ${errorMessage(error)}`,
    );
  }
}

export async function terminateSession(
  ctx: RawHttpCheckContext,
  sessionId: string | undefined,
  negotiatedVersion: string | undefined,
): Promise<void> {
  if (!sessionId) {
    return;
  }

  // The version header rides on every request after initialize
  // (2025-06-18 and later), the closing DELETE included, and carries the
  // version the server agreed to: a server that answered an older version
  // may refuse the one we asked for, and the session would stay open.
  await rawRequest(ctx, {
    method: "DELETE",
    headers: legacyHeaders({
      protocolVersion:
        negotiatedVersion ??
        ctx.config.protocolVersion ??
        DEFAULT_LEGACY_PROTOCOL_VERSION,
      sessionId,
    }),
  }).catch(() => undefined);
}

export async function runTransportChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  ctx.config.signal?.throwIfAborted();
  const results: MCPCheckResult[] = [];
  // Membership in the metadata record, NOT a name-prefix test: a prefix
  // predicate silently drops any new transport id that doesn't happen to match
  // it, and that hazard has already bitten once.
  const requestedTransportChecks = [...selectedCheckIds].filter(
    (checkId): checkId is TransportCheckId =>
      checkId in TRANSPORT_CHECK_METADATA,
  );

  if (requestedTransportChecks.length === 0) {
    return results;
  }

  // Era gate: the session/SSE/notification/GET checks assert 2025-era wire
  // mechanics that do not exist in the sessionless 2026 era, so they are
  // legacy-only. On a modern run they are skipped up front — the skips fire
  // BEFORE `initializeSession` is ever called, so no handshake is attempted.
  // `post-response-content-type` is the one both-era transport check.
  const applicableTransportChecks: TransportCheckId[] = [];
  for (const id of requestedTransportChecks) {
    if (CHECK_ERAS[id].includes(ctx.config.era)) {
      applicableTransportChecks.push(id);
    } else {
      results.push(
        notApplicableResult(
          TRANSPORT_CHECK_METADATA[id],
          eraSkipMessage(ctx.config.era, ctx.config.protocolVersion),
        ),
      );
    }
  }

  if (applicableTransportChecks.length === 0) {
    return results;
  }

  if (ctx.config.era === "modern") {
    // The era gate leaves only the both-era check standing on a modern run,
    // and the 2026 wire has no initialize prelude to share — so it probes on
    // its own and the legacy session flow below is never entered.
    if (applicableTransportChecks.includes("post-response-content-type")) {
      results.push(await modernPostResponseContentTypeCheck(ctx));
    }
    return results;
  }

  const initializationStartedAt = Date.now();
  let sessionId: string | undefined;
  let session: Awaited<ReturnType<typeof initializeSession>> | undefined;

  try {
    try {
      session = await initializeSession(
        ctx,
        selectedCheckIds.has("notification-post-accepted"),
      );
    } catch (error) {
      ctx.config.signal?.throwIfAborted();
      if (selectedCheckIds.has("server-sse-polling-session")) {
        results.push(
          failedResult(
            TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
            Date.now() - initializationStartedAt,
            `Initialize request failed: ${errorMessage(error)}`,
            undefined,
            error,
          ),
        );
      }

      for (const id of [
        "server-sse-streams-functional",
        "notification-post-accepted",
        "get-stream-or-405",
        "session-id-visible-ascii",
        "post-response-content-type",
      ] as const) {
        if (selectedCheckIds.has(id)) {
          results.push(
            selectedCheckIds.has("server-sse-polling-session")
              ? blockedResult(
                  TRANSPORT_CHECK_METADATA[id],
                  TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
                  { reason: errorMessage(error) },
                )
              : couldNotRunResult(
                  TRANSPORT_CHECK_METADATA[id],
                  `Skipping check because the Streamable HTTP session could not be initialized: ${errorMessage(error)}`,
                ),
          );
        }
      }

      return results;
    }

    sessionId = session.sessionId;
    const hasStatefulSession = !!sessionId;
    // A 2xx that carries a JSON-RPC error is a refusal too: no session was
    // opened, so there is no session id or stream to say anything about. So
    // is a refusal of the run's version, on any status: the server may refuse
    // it, so nothing here fails or is blocked for it.
    const stop = session.stop;
    const refused =
      stop?.kind === "pin-refused" || (session.ok && stop?.kind === "refused")
        ? stop
        : undefined;

    if (selectedCheckIds.has("server-sse-polling-session")) {
      results.push(
        refused
          ? couldNotRunResult(
              TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
              refused.message,
              refused.details,
            )
          : !session.ok
          ? failedResult(
              TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
              Date.now() - initializationStartedAt,
              `Initialize request failed with HTTP ${session.status}`,
              {
                status: session.status,
                body: session.body as Record<string, unknown> | string | undefined,
              },
            )
          : hasStatefulSession
          ? passedResult(
              TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
              Date.now() - initializationStartedAt,
              {
                sessionId,
                status: session.status,
              },
            )
          : notApplicableResult(
              TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
              "Server initialized successfully without an mcp-session-id header (stateless Streamable HTTP)",
              {
                status: session.status,
                body: session.body as Record<string, unknown> | string | undefined,
              },
            ),
      );
    }

    if (selectedCheckIds.has("post-response-content-type")) {
      results.push(
        session.isMcpLayerResponse
          ? contentTypeCheckResult(
              session.contentType,
              Date.now() - initializationStartedAt,
              { method: "initialize", status: session.status },
            )
          : couldNotRunResult(
              TRANSPORT_CHECK_METADATA["post-response-content-type"],
              `Initialize returned HTTP ${session.status} with no JSON-RPC error body, so no MCP-layer response was observed to judge`,
              { status: session.status },
            ),
      );
    }

    if (selectedCheckIds.has("session-id-visible-ascii")) {
      if (refused) {
        results.push(
          couldNotRunResult(
            TRANSPORT_CHECK_METADATA["session-id-visible-ascii"],
            refused.message,
            refused.details,
          ),
        );
      } else if (!session.ok) {
        results.push(
          couldNotRunResult(
            TRANSPORT_CHECK_METADATA["session-id-visible-ascii"],
            `Initialize failed with HTTP ${session.status}, so no session id was observed`,
            { status: session.status },
          ),
        );
      } else if (!sessionId) {
        // Assigning a session id at all is MAY, so a stateless legacy server
        // leaves nothing for the charset MUST to bind to.
        results.push(
          notApplicableResult(
            TRANSPORT_CHECK_METADATA["session-id-visible-ascii"],
            "Server initialized without minting a session id (assigning one is MAY), so the charset requirement has no subject",
          ),
        );
      } else {
        const invalidCharacters = invalidSessionIdCharacters(sessionId);
        results.push(
          invalidCharacters.length === 0
            ? passedResult(
                TRANSPORT_CHECK_METADATA["session-id-visible-ascii"],
                Date.now() - initializationStartedAt,
                { sessionIdLength: sessionId.length },
              )
            : failedResult(
                TRANSPORT_CHECK_METADATA["session-id-visible-ascii"],
                Date.now() - initializationStartedAt,
                `Session id contains characters outside visible ASCII (0x21–0x7E): ${invalidCharacters.join(", ")}`,
                { invalidCharacters, sessionIdLength: sessionId.length },
              ),
        );
      }
    }

    if (!session.ok && !refused) {
      for (const id of SESSION_PROBE_CHECKS) {
        if (selectedCheckIds.has(id)) {
          results.push(
            selectedCheckIds.has("server-sse-polling-session")
              ? blockedResult(
                  TRANSPORT_CHECK_METADATA[id],
                  TRANSPORT_CHECK_METADATA["server-sse-polling-session"],
                  { status: session.status },
                )
              : couldNotRunResult(
                  TRANSPORT_CHECK_METADATA[id],
                  "Streamable HTTP session could not be initialized",
                  { status: session.status },
                ),
          );
        }
      }

      return results;
    }

    // The checks above read the `initialize` answer itself. The ones below
    // send more requests on the session, which this run does only after a
    // handshake that ended: `initialize` accepted, on the run's version, and
    // the `initialized` notification delivered.
    if (stop !== undefined) {
      for (const id of SESSION_PROBE_CHECKS) {
        if (selectedCheckIds.has(id)) {
          results.push(
            couldNotRunResult(
              TRANSPORT_CHECK_METADATA[id],
              stop.message,
              stop.details,
            ),
          );
        }
      }

      return results;
    }
    const { initialized } = session;

    // Three requests at once, each answered on a stream of its own: "The
    // client MAY remain connected to multiple SSE streams simultaneously."
    // That sentence permits the client to do this. It asks nothing of the
    // server, so accepting all three is not graded; what is graded is the
    // streams that come back.
    if (selectedCheckIds.has("server-sse-streams-functional")) {
      const activeSessionId = sessionId;
      const streamVersion =
        ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION;
      const multiStreamStartedAt = Date.now();
      const probe = concurrentProbe(session.capabilities);
      const firstRequestId = 1000;
      const settledResponses = await Promise.allSettled(
        Array.from({ length: 3 }).map((_, index) =>
          rawRequest(ctx, {
            headers: {
              ...legacyHeaders({
                protocolVersion: streamVersion,
                sessionId: activeSessionId,
              }),
              Accept: "text/event-stream, application/json",
            },
            body: probe.body(firstRequestId + index),
          }).then((response) =>
            // A polled answer needs a call-back; the three wait at once.
            resumePolledStream(ctx, response, {
              sessionId: activeSessionId,
              protocolVersion: streamVersion,
              inspectAllMessages: true,
            }),
          ),
        ),
      );

      const responses = settledResponses.map((result) =>
        result.status === "fulfilled" ? result.value : undefined,
      );
      // A broken response BODY is not a rejected request: the capture keeps the
      // status line, so acceptance and stream health stay separate facts (the
      // `server-sse-streams-functional` check owns `bodyError`).
      const requestErrors = settledResponses.map((result) =>
        result.status === "rejected" ? errorMessage(result.reason) : undefined,
      );
      const statuses = responses.map((response) => response?.status ?? null);
      const contentTypes = responses.map(
        (response) => response?.headers["content-type"] ?? "",
      );
      // What the server accepted. Refusals and request errors are reported in
      // the details, never graded: a server may turn a concurrent POST away.
      const answered = responses.filter(
        (response) => response !== undefined && isOk(response),
      ).length;
      const anyRequestError = requestErrors.some(
        (error) => error !== undefined,
      );
      // Every verdict names the probe: it follows the declared capabilities,
      // so it can be any of the three listings or a ping.
      const acceptance = {
        probeMethod: probe.method,
        statuses,
        ...(anyRequestError ? { requestErrors } : {}),
      };
      const sseResponses = responses
        .map((response, index) => ({ response, index }))
        .filter(
          (
            candidate,
          ): candidate is { response: RawHttpResult; index: number } =>
            candidate.response !== undefined &&
            isOk(candidate.response) &&
            (candidate.response.headers["content-type"] ?? "").includes(
              "text/event-stream",
            ),
        );

      const inspection = inspectSseStreamMessages(
        sseResponses,
        streamVersion,
        firstRequestId,
      );
      const polling = pollingOutcome(sseResponses);
      if ("violation" in inspection) {
        const { message, ...evidence } = inspection.violation;
        results.push(
          failedResult(
            TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
            Date.now() - multiStreamStartedAt,
            message,
            { ...acceptance, ...evidence },
          ),
        );
      } else if (sseResponses.length === 0) {
        results.push(
          answered === 0 && !anyRequestError
            ? // Every request was turned down with an HTTP status. A server may
              // refuse concurrent requests, so there is no stream to grade, and
              // that must not hold the run at "incomplete" either.
              notApplicableResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                `The server turned down all three concurrent requests (HTTP ${statuses.join(", ")}), so there was no stream to check. A server does not have to accept concurrent requests.`,
                { ...acceptance, contentTypes },
              )
            : answered === 0
            ? // A request that never got an HTTP answer might have streamed:
              // unknown, so this was not tested rather than not applicable.
              couldNotRunResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                `None of the three concurrent requests was accepted (${requestErrors.filter((error) => error !== undefined).length} failed before any HTTP answer), so no stream came back to check.`,
                { ...acceptance, contentTypes },
              )
            : probe.capability === undefined
            ? notApplicableResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                PING_ANSWERED_AS_JSON,
                { probeMethod: probe.method, contentTypes },
              )
            : passedResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                Date.now() - multiStreamStartedAt,
                {
                  message:
                    "Concurrent requests returned JSON responses instead of SSE streams",
                  contentTypes,
                  ...acceptance,
                },
              ),
        );
      } else if (polling.unreadMessage !== undefined) {
        // A polled stream that was never read cannot be judged readable.
        results.push(
          couldNotRunResult(
            TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
            polling.unreadMessage,
            {
              probeMethod: probe.method,
              unreadStreams: polling.unreadStreams,
            },
          ),
        );
      } else {
        const { unansweredStreams, eventCounts, readErrors } = inspection;
        const allStreamsReadable =
          readErrors.every((error) => error === undefined) &&
          unansweredStreams.length === 0;

        results.push(
          allStreamsReadable
            ? passedResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                Date.now() - multiStreamStartedAt,
                {
                  eventCounts,
                  sseStreamCount: sseResponses.length,
                  ...acceptance,
                  ...polling.resumedDetail,
                },
              )
            : failedResult(
                TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                Date.now() - multiStreamStartedAt,
                unansweredStreams.length > 0
                  ? "One or more concurrent SSE streams ended without the JSON-RPC response to its request"
                  : "One or more concurrent SSE streams could not be read to the end",
                {
                  contentTypes,
                  ...acceptance,
                  eventCounts,
                  unansweredStreams,
                  readErrors,
                  sseStreamCount: sseResponses.length,
                  sseResponseIndexes: sseResponses.map(({ index }) => index),
                  ...polling.resumedDetail,
                },
              ),
        );
      }
    }
    if (selectedCheckIds.has("notification-post-accepted")) {
      // The notification under test is the one the handshake already sent.
      // `notifications/initialized` is the one notification every client
      // sends, so "cannot accept" has no legitimate reading here, and a second
      // copy would be a notification no conforming client sends.
      const { response, durationMs } = initialized;
      const hasBody = response.bodyText !== "";
      results.push(
        // A body that could not be read to completion leaves the "no body"
        // half of the requirement unestablished. Certifying a pass off a
        // broken read would claim a fact the run never observed, and failing
        // would blame the server for our own truncated read.
        response.bodyError !== undefined
          ? couldNotRunResult(
              TRANSPORT_CHECK_METADATA["notification-post-accepted"],
              `Response body could not be read to completion (${response.bodyError}), so "202 Accepted with no body" could not be confirmed`,
              { status: response.status },
            )
          : response.status === 202 && !hasBody
          ? passedResult(
              TRANSPORT_CHECK_METADATA["notification-post-accepted"],
              durationMs,
              { status: response.status },
            )
          : failedResult(
              TRANSPORT_CHECK_METADATA["notification-post-accepted"],
              durationMs,
              response.status === 202
                ? "Server answered a notification-only POST with HTTP 202 but included a body; the requirement is 202 Accepted with no body"
                : `Expected HTTP 202 Accepted with no body for a notification-only POST, got HTTP ${response.status}`,
              {
                status: response.status,
                contentType: response.headers["content-type"] ?? "",
                bodyPreview: response.bodyText.slice(0, 200),
              },
            ),
      );
    }

    if (selectedCheckIds.has("get-stream-or-405")) {
      const startedAt = Date.now();
      try {
        // An accepted GET stream legitimately stays open forever, so only the
        // status line and headers are observed — the verdict lives entirely
        // there, and reading the body would burn the whole check timeout.
        const response = await rawHeadersProbe(ctx, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "mcp-protocol-version":
              ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
        });
        const contentType = response.headers["content-type"] ?? "";
        const opensStream =
          response.status >= 200 &&
          response.status < 300 &&
          mediaTypeOf(contentType) === "text/event-stream";
        results.push(
          opensStream || response.status === 405
            ? passedResult(
                TRANSPORT_CHECK_METADATA["get-stream-or-405"],
                Date.now() - startedAt,
                { status: response.status, contentType },
              )
            : failedResult(
                TRANSPORT_CHECK_METADATA["get-stream-or-405"],
                Date.now() - startedAt,
                `Expected the GET to open a text/event-stream response or return HTTP 405 Method Not Allowed, got HTTP ${response.status} with Content-Type "${contentType || "(no content-type)"}"`,
                { status: response.status, contentType },
              ),
        );
      } catch (error) {
        ctx.config.signal?.throwIfAborted();
        results.push(
          couldNotRunResult(
            TRANSPORT_CHECK_METADATA["get-stream-or-405"],
            `GET request could not be delivered: ${errorMessage(error)}`,
          ),
        );
      }
    }
  } finally {
    // The version the server answered, even one MCPJam does not speak: the
    // session is on it, and the run's version may be refused.
    await terminateSession(
      ctx,
      sessionId,
      session?.negotiatedVersion ?? session?.versionStop?.answeredVersion
    );
  }

  return results;
}
