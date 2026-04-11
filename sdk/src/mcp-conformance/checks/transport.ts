import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import {
  errorMessage,
  failedResult,
  skippedResult,
  passedResult,
} from "./helpers.js";

const TRANSPORT_CHECK_METADATA = {
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

function buildBaseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

function withSessionHeaders(
  headers: Record<string, string>,
  sessionId?: string,
): Record<string, string> {
  return sessionId
    ? {
        ...headers,
        "mcp-session-id": sessionId,
      }
    : headers;
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchFn(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

type SseEvent = {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
};

function processSseLines(
  buffer: string,
  events: SseEvent[],
  current: SseEvent,
  seenFields: { value: boolean },
): string {
  const endedWithDelimiter = /\r?\n\r?\n$/.test(buffer);
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  const flushEvent = () => {
    if (!seenFields.value) {
      return;
    }

    events.push({
      ...current,
      data: current.data,
    });
    current.id = undefined;
    current.event = undefined;
    current.data = "";
    current.retry = undefined;
    seenFields.value = false;
  };

  for (const line of lines) {
    if (line === "") {
      flushEvent();
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field =
      separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue =
      separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    seenFields.value = true;

    switch (field) {
      case "id":
        current.id = value;
        break;
      case "event":
        current.event = value;
        break;
      case "data":
        current.data = current.data ? `${current.data}\n${value}` : value;
        break;
      case "retry": {
        const retry = Number(value);
        if (Number.isFinite(retry)) {
          current.retry = retry;
        }
        break;
      }
      default:
        break;
    }
  }

  if (endedWithDelimiter && seenFields.value) {
    flushEvent();
  }

  return remainder;
}

async function readSseEvents(
  response: Response,
  timeoutMs: number,
): Promise<SseEvent[]> {
  if (!response.body) {
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  const current: SseEvent = { data: "" };
  const seenFields = { value: false };

  const readWithTimeout = async () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new Error(`SSE stream read timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await readWithTimeout();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = processSseLines(buffer, events, current, seenFields);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort stream cleanup.
    }
  }

  if (buffer.length > 0) {
    processSseLines(`${buffer}\n`, events, current, seenFields);
  }

  return events;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function initializeSession(
  ctx: RawHttpCheckContext,
): Promise<{
  ok: boolean;
  status: number;
  sessionId?: string;
  body: unknown;
}> {
  const response = await fetchWithTimeout(
    ctx.fetchFn,
    ctx.serverUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...buildBaseHeaders(ctx),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "mcpjam-sdk-conformance",
            version: "1.0.0",
          },
        },
      }),
    },
    ctx.config.checkTimeout,
  );

  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
    body: await parseResponseBody(response),
  };
}

async function terminateSession(
  ctx: RawHttpCheckContext,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    return;
  }

  await fetchWithTimeout(
    ctx.fetchFn,
    ctx.serverUrl,
    {
      method: "DELETE",
      headers: withSessionHeaders({
        Accept: "application/json, text/event-stream",
        ...buildBaseHeaders(ctx),
      }, sessionId),
    },
    ctx.config.checkTimeout,
  ).catch(() => undefined);
}

export async function runTransportChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  const results: MCPCheckResult[] = [];
  const requestedTransportChecks = [...selectedCheckIds].filter((checkId) =>
    checkId.startsWith("server-sse") || checkId === "server-accepts-multiple-post-streams",
  );

  if (requestedTransportChecks.length === 0) {
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
            skippedResult(
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
          : skippedResult(
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
            skippedResult(
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
          fetchWithTimeout(
            ctx.fetchFn,
            ctx.serverUrl,
            {
              method: "POST",
              headers: withSessionHeaders({
                "Content-Type": "application/json",
                Accept: "text/event-stream, application/json",
                "mcp-protocol-version": "2025-11-25",
                ...buildBaseHeaders(ctx),
              }, activeSessionId),
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1000 + index,
                method: "tools/list",
                params: {},
              }),
            },
            ctx.config.checkTimeout,
          ),
        ),
      );

      const responses = settledResponses.map((result) =>
        result.status === "fulfilled" ? result.value : undefined,
      );
      const requestErrors = settledResponses.map((result) =>
        result.status === "rejected" ? errorMessage(result.reason) : undefined,
      );
      const statuses = responses.map((response) => response?.status ?? null);
      const contentTypes = responses.map(
        (response) => response?.headers.get("content-type") ?? "",
      );
      const allAccepted =
        requestErrors.every((error) => error === undefined) &&
        responses.every((response) => response?.ok === true);
      const responseFailures = responses.some(
        (response) => response !== undefined && !response.ok,
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
            ): candidate is { response: Response; index: number } =>
              candidate.response !== undefined &&
              candidate.response.ok &&
              (candidate.response.headers.get("content-type") ?? "").includes(
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
          const settledEventReads = await Promise.allSettled(
            sseResponses.map(async ({ response }) => {
              const events = await readSseEvents(
                response,
                Math.min(ctx.config.checkTimeout, 2_000),
              );
              return events.length;
            }),
          );
          const eventCounts = settledEventReads.map((result) =>
            result.status === "fulfilled" ? result.value : 0,
          );
          const readErrors = settledEventReads.map((result) =>
            result.status === "rejected" ? errorMessage(result.reason) : undefined,
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
