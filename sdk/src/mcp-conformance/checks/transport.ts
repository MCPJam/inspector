import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  errorMessage,
  eraSkipMessage,
  failedResult,
  couldNotRunResult,
  notApplicableResult,
  passedResult,
} from "./helpers.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  legacyHeaders,
  legacyInitialize,
  rawRequest,
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
  "server-accepts-multiple-post-streams": {
    id: "server-accepts-multiple-post-streams",
    category: "transport",
    title: "Multiple POST Streams",
    description: "The server accepts multiple concurrent POST requests.",
  },
  "server-sse-streams-functional": {
    id: "server-sse-streams-functional",
    category: "transport",
    title: "Functional SSE Streams",
    description: "Concurrent SSE streams remain readable.",
  },
} as const satisfies Record<
  Extract<
    MCPCheckId,
    | "server-sse-polling-session"
    | "server-accepts-multiple-post-streams"
    | "server-sse-streams-functional"
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

async function initializeSession(ctx: RawHttpCheckContext): Promise<{
  ok: boolean;
  status: number;
  sessionId?: string;
  body: unknown;
}> {
  const { result, sessionId } = await legacyInitialize(ctx);
  return {
    ok: isOk(result),
    status: result.status,
    sessionId,
    body: result.json ?? (result.bodyText || undefined),
  };
}

async function terminateSession(
  ctx: RawHttpCheckContext,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    return;
  }

  await rawRequest(ctx, {
    method: "DELETE",
    headers: legacyHeaders({ sessionId }),
  }).catch(() => undefined);
}

export async function runTransportChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  const results: MCPCheckResult[] = [];
  const requestedTransportChecks = [...selectedCheckIds].filter(
    (checkId): checkId is TransportCheckId =>
      checkId.startsWith("server-sse") ||
      checkId === "server-accepts-multiple-post-streams",
  );

  if (requestedTransportChecks.length === 0) {
    return results;
  }

  // Era gate: every transport check asserts 2025-era stateful-session / SSE
  // mechanics that do not exist in the sessionless 2026 era, so they are
  // legacy-only. On a modern run they are skipped up front — the skips fire
  // BEFORE `initializeSession` is ever called, so no handshake is attempted.
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

  const initializationStartedAt = Date.now();
  let sessionId: string | undefined;
  let session:
    | {
        ok: boolean;
        status: number;
        sessionId?: string;
        body: unknown;
      }
    | undefined;

  try {
    try {
      session = await initializeSession(ctx);
    } catch (error) {
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
        "server-accepts-multiple-post-streams",
        "server-sse-streams-functional",
      ] as const) {
        if (selectedCheckIds.has(id)) {
          results.push(
            couldNotRunResult(
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

    if (selectedCheckIds.has("server-sse-polling-session")) {
      results.push(
        !session.ok
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

    if (!session.ok) {
      for (const id of [
        "server-accepts-multiple-post-streams",
        "server-sse-streams-functional",
      ] as const) {
        if (selectedCheckIds.has(id)) {
          results.push(
            couldNotRunResult(
              TRANSPORT_CHECK_METADATA[id],
              "Streamable HTTP session could not be initialized",
            ),
          );
        }
      }

      return results;
    }

    const needsMultiStreamChecks =
      selectedCheckIds.has("server-accepts-multiple-post-streams") ||
      selectedCheckIds.has("server-sse-streams-functional");

    if (needsMultiStreamChecks) {
      const activeSessionId = sessionId;
      const multiStreamStartedAt = Date.now();
      const settledResponses = await Promise.allSettled(
        Array.from({ length: 3 }).map((_, index) =>
          rawRequest(ctx, {
            headers: {
              ...legacyHeaders({
                protocolVersion:
                  ctx.config.protocolVersion ??
                  DEFAULT_LEGACY_PROTOCOL_VERSION,
                sessionId: activeSessionId,
              }),
              Accept: "text/event-stream, application/json",
            },
            body: {
              jsonrpc: "2.0",
              id: 1000 + index,
              method: "tools/list",
              params: {},
            },
          }),
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
      const allAccepted =
        requestErrors.every((error) => error === undefined) &&
        responses.every((response) => response !== undefined && isOk(response));
      const responseFailures = responses.some(
        (response) => response !== undefined && !isOk(response),
      );
      const requestOutcomeSummary = statuses.map(
        (status, index) => status ?? `error:${requestErrors[index] ?? "unknown"}`,
      );

      if (selectedCheckIds.has("server-accepts-multiple-post-streams")) {
        results.push(
          allAccepted
            ? passedResult(
                TRANSPORT_CHECK_METADATA["server-accepts-multiple-post-streams"],
                Date.now() - multiStreamStartedAt,
                {
                  statuses,
                  contentTypes,
                },
              )
            : failedResult(
                TRANSPORT_CHECK_METADATA["server-accepts-multiple-post-streams"],
                Date.now() - multiStreamStartedAt,
                `Expected all concurrent POST requests to return 2xx, got ${requestOutcomeSummary.join(", ")}`,
                {
                  statuses,
                  contentTypes,
                  requestErrors,
                },
              ),
        );
      }

      if (selectedCheckIds.has("server-sse-streams-functional")) {
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

        if (sseResponses.length === 0) {
          results.push(
            requestErrors.some((error) => error !== undefined) || responseFailures
              ? failedResult(
                  TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                  Date.now() - multiStreamStartedAt,
                  "One or more concurrent POST requests failed before any SSE stream could be validated",
                  {
                    statuses,
                    contentTypes,
                    requestErrors,
                  },
                )
              : passedResult(
                  TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                  Date.now() - multiStreamStartedAt,
                  {
                    message:
                      "Concurrent requests returned JSON responses instead of SSE streams",
                    contentTypes,
                  },
                ),
          );
        } else {
          // The frames were already parsed off each capture by the shared
          // harness, so "readable" is now a property of the recorded exchange
          // rather than a second pass over the live stream. Only DELIMITED
          // frames count: a stream cut mid-frame leaves an unterminated tail,
          // which is not a delivered event.
          const eventCounts = sseResponses.map(
            ({ response }) =>
              response.sse?.filter((event) => event.terminated).length ?? 0,
          );
          const readErrors = sseResponses.map(
            ({ response }) => response.bodyError,
          );
          const allStreamsReadable =
            requestErrors.every((error) => error === undefined) &&
            !responseFailures &&
            readErrors.every((error) => error === undefined) &&
            eventCounts.every((count) => count > 0);

          results.push(
            allStreamsReadable
              ? passedResult(
                  TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                  Date.now() - multiStreamStartedAt,
                  {
                    eventCounts,
                    sseStreamCount: sseResponses.length,
                  },
                )
              : failedResult(
                  TRANSPORT_CHECK_METADATA["server-sse-streams-functional"],
                  Date.now() - multiStreamStartedAt,
                  "One or more concurrent SSE streams produced no readable events",
                  {
                    statuses,
                    contentTypes,
                    requestErrors,
                    eventCounts,
                    readErrors,
                    sseStreamCount: sseResponses.length,
                    sseResponseIndexes: sseResponses.map(({ index }) => index),
                  },
                ),
          );
        }
      }
    }
  } finally {
    await terminateSession(ctx, sessionId);
  }

  return results;
}
