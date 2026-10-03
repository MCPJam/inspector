import { isAbortError } from "@/shared/abort-errors";
import {
  readChatResponseMeta,
  reportChatFailure,
  type ChatResponseMeta,
} from "@/lib/chat-error-reporting";

/**
 * Ask MCPJam's browser-side failure reporting: ONE capture decision per
 * request, made in the Chat's `onFinish`.
 *
 * The server reports what it can see — a failed route, a failed step — and
 * says so: `x-mcpjam-failure-captured` on the response, `captured` on each
 * error trace event in the stream. What it cannot see is everything between
 * it and the user's browser: a fetch that never reached it, a body an edge
 * replaced, a stream that ended without finishing. Those are reported from
 * here, and only those, so a failure is captured once.
 *
 * Why `onFinish` and not `onError`: `onFinish` runs on EVERY exit from a
 * request — abort, error, and a stream that simply ended — while `onError`
 * misses the last of those. `onError` stays the limit dialog's, and only
 * lends this tracker the error it saw.
 */

/** What one request showed us, on the way past. */
type AgentRequestState = {
  /** The request's own signal: Stop before the headers rejects the fetch. */
  signal?: AbortSignal;
  meta: ChatResponseMeta | null;
  sawFinish: boolean;
  sawErrorChunk: boolean;
  /** An error trace event said the server already captured it. */
  serverCapturedError: boolean;
  /** The last error the SDK handed `onError` for this request. */
  error?: Error;
  /** Claimed by the one capture decision. */
  reported: boolean;
};

export type AgentFinishFlags = {
  isAbort: boolean;
  isDisconnect: boolean;
  isError: boolean;
};

type Report = typeof reportChatFailure;

/** The refusal fields a JSON error body names, when the SDK quoted one. */
function parseRefusal(text: string | undefined): {
  code?: string;
  reason?: string;
  scope?: string;
  gatedBy?: string;
} {
  if (!text) return {};
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string) =>
      typeof body?.[key] === "string" ? (body[key] as string) : undefined;
    const code = pick("code");
    const reason = pick("reason") ?? pick("refusalReason");
    const scope = pick("scope");
    const gatedBy = pick("gatedBy");
    return {
      ...(code ? { code } : {}),
      ...(reason ? { reason } : {}),
      ...(scope ? { scope } : {}),
      ...(gatedBy ? { gatedBy } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Pass the stream through untouched while noting `finish`, `error`, and the
 * `captured` flag on error trace events. Never throws and never alters a byte:
 * a chunk this cannot parse is the SDK's to reject, and it does.
 */
function observeStream(response: Response, state: AgentRequestState): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let buffer = "";
  const inspectLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: {
      type?: unknown;
      data?: { type?: unknown; captured?: unknown };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk?.type === "finish") state.sawFinish = true;
    else if (chunk?.type === "error") state.sawErrorChunk = true;
    else if (
      chunk?.type === "data-trace-event" &&
      chunk.data?.type === "error" &&
      chunk.data.captured === true
    ) {
      state.serverCapturedError = true;
    }
  };
  const observed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(piece, controller) {
        controller.enqueue(piece);
        try {
          buffer += decoder.decode(piece, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            inspectLine(buffer.slice(0, newline).trim());
            buffer = buffer.slice(newline + 1);
          }
        } catch {
          // Observation only; the bytes already went through.
        }
      },
      flush() {
        try {
          if (buffer.trim()) inspectLine(buffer.trim());
        } catch {
          // As above.
        }
      },
    }),
  );
  return new Response(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * One tracker per agent Chat instance. Requests on a Chat are sequential (a
 * resume starts only after the previous request's `onFinish`), so it holds the
 * one request in flight.
 */
export function createAgentFailureTracker(report: Report = reportChatFailure) {
  let current: AgentRequestState | null = null;

  return {
    /** Wrap the transport's `fetch`. */
    async fetch(
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      doFetch: (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>,
    ): Promise<Response> {
      const state: AgentRequestState = {
        ...(init?.signal ? { signal: init.signal } : {}),
        meta: null,
        sawFinish: false,
        sawErrorChunk: false,
        serverCapturedError: false,
        reported: false,
      };
      current = state;
      const response = await doFetch(input, init);
      state.meta = readChatResponseMeta(response);
      return response.ok ? observeStream(response, state) : response;
    },

    /** The Chat's `onError`: lend the error to the decision. */
    noteError(error: Error): void {
      if (current) current.error = error;
    },

    /**
     * The Chat's `onFinish`: capture at most once, and only when all hold —
     * the request was not aborted; the server did not report it; and
     * something went wrong.
     */
    onFinish(flags: AgentFinishFlags): boolean {
      const state = current;
      current = null;
      if (!state || state.reported) return false;
      state.reported = true;

      // The user pressing Stop — before the headers too, which arrives as a
      // rejected fetch rather than an abort flag.
      if (
        flags.isAbort ||
        state.signal?.aborted === true ||
        (state.error !== undefined && isAbortError(state.error))
      ) {
        return false;
      }
      // The server already reported it.
      if (state.meta?.failureCaptured === true || state.serverCapturedError) {
        return false;
      }
      const wentWrong = flags.isError || flags.isDisconnect || !state.sawFinish;
      if (!wentWrong) return false;

      const error =
        state.error ??
        new Error(
          state.sawErrorChunk
            ? "Ask MCPJam stream reported an error"
            : "Ask MCPJam stream ended without finishing",
        );
      // No response at all, or the connection dropped under one: the
      // browser's transport, which is routine unless it spikes. The SDK only
      // flags a disconnect for a TypeError that says "fetch"/"network", so a
      // body read that dies with WebKit's "Load failed" is caught here too: a
      // TypeError under a 2xx with no error chunk is the connection, not us.
      const droppedMidStream =
        state.meta?.ok === true &&
        state.error instanceof TypeError &&
        !state.sawErrorChunk;
      const transport =
        state.meta === null || flags.isDisconnect || droppedMidStream;
      const requestFailed = state.meta !== null && !state.meta.ok;
      const refusal = requestFailed ? parseRefusal(state.error?.message) : {};
      const source = transport
        ? state.meta === null
          ? "fetch_rejected"
          : "disconnect"
        : requestFailed
          ? "request_failed"
          : flags.isError
            ? "stream_error"
            : "stream_incomplete";
      return report(error, state.meta, {
        agent: {
          source,
          ...refusal,
          ...(transport ? { pageClass: "routine" as const } : {}),
        },
      });
    },
  };
}
