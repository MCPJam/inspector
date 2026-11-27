import { withAbortSignalFetch } from "../abort-signal.js";
import { drainFrames, sseRetryMs, type RawSseEvent } from "./raw-capture.js";
import { baseHeaders, type RawHttpResult } from "./raw-http.js";
import type { RawHttpCheckContext } from "./types.js";

/** What {@link resumePolledStream} did to get an answer back. */
export interface PolledStreamResume {
  /** One entry per call-back GET: its HTTP status, or why it failed. */
  attempts: Array<number | string>;
  /** The `Last-Event-ID` the last call-back sent. */
  lastEventId: string;
  /** Whether a JSON-RPC response arrived on a call-back. */
  gotResponse: boolean;
  /**
   * The `Mcp-Session-Id` of the call-back that carried the answer. A server
   * assigns the session on "the HTTP response containing the InitializeResult",
   * which for a polled answer is the call-back, not the original POST.
   */
  sessionId?: string;
  /**
   * Set when the stream was handed to polling but no call-back was sent: the
   * wait the server asked for does not fit in the time the check has left.
   * The answer was never read, so a check that grades it could not run.
   */
  waitTooLong?: { waitMs: number };
}

/**
 * The "could not run" reason for an answer that was handed to polling and
 * never read, or undefined when the call-back was sent (or not needed).
 */
export function unreadPolledAnswerMessage(
  resumed: PolledStreamResume | undefined
): string | undefined {
  if (!resumed?.waitTooLong) return undefined;
  return `The server handed its answer to polling and asked to be called back after ${resumed.waitTooLong.waitMs} ms, more than this check had left, so the answer was never read. Raise the check timeout (--check-timeout, SDK: checkTimeout) to let MCPJam wait that long.`;
}

/**
 * How a check's streams fared with polling: why one handed to polling was
 * never read (and which ones), and which got their answer only through a
 * call-back, so a reader can tell a polled stream from one that answered.
 */
export function pollingOutcome(
  streams: ReadonlyArray<{
    response: { resumed?: PolledStreamResume };
    index: number;
  }>
): {
  unreadMessage?: string;
  unreadStreams: number[];
  resumedDetail: { resumedStreams?: number[] };
} {
  const unread = streams.filter(({ response }) =>
    unreadPolledAnswerMessage(response.resumed)
  );
  const resumedStreams = streams
    .filter(({ response }) => response.resumed?.gotResponse)
    .map(({ index }) => index);
  return {
    unreadMessage: unreadPolledAnswerMessage(unread[0]?.response.resumed),
    unreadStreams: unread.map(({ index }) => index),
    resumedDetail: resumedStreams.length > 0 ? { resumedStreams } : {},
  };
}

// How the normal client paces its call-backs (`@modelcontextprotocol/client`,
// DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS): wait what the server asked
// for with `retry`, else back off from 1 s, and give up after two failed tries
// in a row. The cap on call-backs is ours: a probe must end even when a
// server keeps handing out new event ids.
const RESUME_INITIAL_DELAY_MS = 1_000;
const RESUME_MAX_DELAY_MS = 30_000;
const RESUME_DELAY_GROW_FACTOR = 1.5;
const RESUME_MAX_FAILED_ATTEMPTS = 2;
const RESUME_MAX_ATTEMPTS = 5;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A JSON-RPC response (result or error), which is what ends a request's stream. */
function isJsonRpcResponse(message: unknown): boolean {
  const record = asRecord(message);
  return (
    record !== undefined &&
    "id" in record &&
    ("result" in record || "error" in record)
  );
}

/**
 * The response to the request being resumed. The spec forbids replaying
 * "messages that would have been delivered on a different stream", so a
 * response with another id is not this request's answer.
 */
function answersRequest(message: unknown, requestId: unknown): boolean {
  return (
    isJsonRpcResponse(message) &&
    String(asRecord(message)?.id) === String(requestId)
  );
}

/** The id of the last complete event that had one: the next `Last-Event-ID`. */
function lastEventIdOf(events: readonly RawSseEvent[]): string | undefined {
  let lastEventId: string | undefined;
  for (const event of events) {
    if (event.terminated && event.id) lastEventId = event.id;
  }
  return lastEventId;
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CallBack {
  status: number | string;
  events: RawSseEvent[];
  text: string;
  sessionId?: string;
}

/**
 * One call-back GET, read frame by frame until a JSON-RPC response arrives,
 * the stream ends, or `deadline` passes. Read incrementally rather than
 * through `rawRequest`: a server may keep the resumed stream open, and a
 * capture that waits for the end would only time out and lose the text.
 */
async function readCallBack(
  ctx: RawHttpCheckContext,
  headers: Headers,
  deadline: number,
  isAnswer: (event: RawSseEvent) => boolean
): Promise<CallBack> {
  const events: RawSseEvent[] = [];
  let text = "";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - Date.now())
  );
  try {
    const response = await withAbortSignalFetch(ctx.fetchFn, ctx.config.signal)(
      ctx.serverUrl,
      { method: "GET", headers, signal: controller.signal }
    );
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    const isStream = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream"
    );
    if (response.status < 200 || response.status >= 300 || !isStream) {
      try {
        await response.body?.cancel();
      } catch {
        // Nothing here is read; a body that is already gone needs no release.
      }
      return { status: response.status, events, text, sessionId };
    }
    if (!response.body) {
      return { status: response.status, events, text, sessionId };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let status: number | string = response.status;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const piece = decoder.decode(chunk.value, { stream: true });
        text += piece;
        buffer += piece;
        const drained = drainFrames(buffer);
        buffer = drained.rest;
        events.push(...drained.frames);
        if (drained.frames.some(isAnswer)) {
          break;
        }
      }
    } catch (error) {
      // The stream broke or ran out of time; the frames read so far still count.
      ctx.config.signal?.throwIfAborted();
      if (!events.some(isAnswer)) {
        status = `stream error: ${errorText(error)}`;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone; the frames read are the evidence.
      }
    }
    return { status, events, text, sessionId };
  } catch (error) {
    ctx.config.signal?.throwIfAborted();
    return { status: `request error: ${errorText(error)}`, events, text };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Call a 2025 server back for an answer it handed to polling.
 *
 * 2025-11-25 Transports, Sending Messages to the Server: after an event with
 * an ID the server "MAY close the connection (without terminating the SSE
 * stream)", and the client "SHOULD then 'poll' the SSE stream by attempting
 * to reconnect", waiting the `retry` time first ("The client MUST respect the
 * retry field"). Resumability and Redelivery: the client resumes with "an
 * HTTP GET to the MCP endpoint" carrying `Last-Event-ID`; 2025-06-18 and
 * 2025-03-26 have the same section. 2026-07-28 streams are not resumable
 * ("Resumable SSE streams via Last-Event-ID are not supported"), so a modern
 * run is never called back.
 *
 * The rule for when to call back is the normal client's: the answer was an
 * SSE stream, it ended without a JSON-RPC response, and an event carried an
 * id. Anything else returns `result` unchanged without a request. When the
 * wait the server asked for does not fit in the check's time, nothing is
 * sent and `resumed.waitTooLong` says why the answer was never read.
 *
 * The answer joins `sse`, so `jsonRpcError` and `jsonRpcResult` find it;
 * status, headers, body and exchange stay the original request's, so a check
 * that judges the request itself sees what it always saw. The answer also
 * enters the wire record against the request it answers.
 *
 * Never throws, except when the run itself is cancelled: a failed call-back
 * leaves `result` as the server sent it.
 */
export async function resumePolledStream(
  ctx: RawHttpCheckContext,
  result: RawHttpResult,
  options: {
    sessionId?: string;
    protocolVersion?: string;
    /** Keep other requests' responses and handle March 2025 batches for the stream grader. */
    inspectAllMessages?: boolean;
  } = {}
): Promise<RawHttpResult> {
  if (ctx.config.era === "modern") return result;
  const request = asRecord(result.exchange.request.json);
  const requestId = request?.id;
  const requestMethod =
    typeof request?.method === "string" ? request.method : undefined;
  const allowBatch = options.inspectAllMessages && options.protocolVersion === "2025-03-26";
  const messagesIn = (event: RawSseEvent): readonly unknown[] =>
    allowBatch && Array.isArray(event.json) ? event.json : [event.json];
  if (
    requestMethod === undefined ||
    requestId === undefined ||
    requestId === null ||
    result.status < 200 ||
    result.status >= 300 ||
    !result.sse ||
    result.sse.some((event) => messagesIn(event).some(isJsonRpcResponse))
  ) {
    return result;
  }
  let lastEventId = lastEventIdOf(result.sse);
  if (lastEventId === undefined) return result;
  let retryMs = sseRetryMs(result.bodyText);
  const isAnswer = (event: RawSseEvent) =>
    messagesIn(event).some((message) => answersRequest(message, requestId));

  const deadline = Date.now() + ctx.config.checkTimeout;
  const attempts: Array<number | string> = [];
  const resumedEvents: RawSseEvent[] = [];
  let failures = 0;
  let answer: CallBack | undefined;
  while (attempts.length < RESUME_MAX_ATTEMPTS) {
    const delay =
      retryMs ??
      Math.min(
        RESUME_INITIAL_DELAY_MS * RESUME_DELAY_GROW_FACTOR ** failures,
        RESUME_MAX_DELAY_MS
      );
    // Calling back sooner than the server asked would break the MUST, so a
    // wait that does not fit in the time left means no call-back at all.
    if (Date.now() + delay >= deadline) {
      if (attempts.length === 0) {
        return {
          ...result,
          resumed: {
            attempts,
            lastEventId,
            gotResponse: false,
            waitTooLong: { waitMs: delay },
          },
        };
      }
      break;
    }
    await waitMs(delay, ctx.config.signal);

    let headers: Headers;
    try {
      headers = new Headers(baseHeaders(ctx));
      headers.set("Accept", "text/event-stream");
      headers.set("Last-Event-ID", lastEventId);
      if (options.sessionId) headers.set("mcp-session-id", options.sessionId);
      if (options.protocolVersion) {
        headers.set("mcp-protocol-version", options.protocolVersion);
      }
    } catch (error) {
      // An event id that is not a legal header value cannot be sent back.
      attempts.push(`not sent: ${errorText(error)}`);
      break;
    }

    const callBack = await readCallBack(ctx, headers, deadline, isAnswer);
    attempts.push(callBack.status);
    resumedEvents.push(...callBack.events);
    if (callBack.events.some(isAnswer)) {
      answer = callBack;
      break;
    }
    // What a call-back delivered before it ended counts even when it then
    // broke: the next one resumes after it, at the pace it asked for.
    const newer = lastEventIdOf(callBack.events);
    const movedOn = newer !== undefined && newer !== lastEventId;
    if (movedOn) lastEventId = newer;
    retryMs = sseRetryMs(callBack.text) ?? retryMs;
    // A GET the server does not offer; the normal client stops here too.
    if (callBack.status === 405) break;
    if (
      typeof callBack.status === "number" &&
      callBack.status >= 200 &&
      callBack.status < 300
    ) {
      // The resumed stream ended without the answer. Call back again only if
      // it moved the stream on, like the normal client does.
      if (!movedOn) break;
      failures = 0;
      continue;
    }
    failures += 1;
    if (failures >= RESUME_MAX_FAILED_ATTEMPTS) break;
  }

  const messages = resumedEvents
    .map((event) => event.json)
    .filter((json): json is unknown => json !== undefined);
  if (messages.length > 0) {
    ctx.recorder?.recordStreamMessages(messages, {
      origin: `GET (resumed ${requestMethod})`,
      requestMethod,
      requestId: requestId as string | number,
    });
  }
  // Every message enters the wire record, but a response to another request
  // must not be graded as this one's answer.
  const answerEvents = options.inspectAllMessages
    ? resumedEvents
    : resumedEvents.filter(
        (event) =>
          !isJsonRpcResponse(event.json) || answersRequest(event.json, requestId)
      );
  return {
    ...result,
    sse: [...result.sse, ...answerEvents],
    resumed: {
      attempts,
      lastEventId,
      gotResponse: answer !== undefined,
      ...(answer?.sessionId ? { sessionId: answer.sessionId } : {}),
    },
  };
}
