import {
  describeError,
  originOf,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import { isAbortError } from "@/shared/abort-errors";
import { reportCaught } from "./error-reporting";
import { isErrorCaptureSurface } from "./PosthogUtils";

/**
 * What the chat `fetch` saw, captured before the AI SDK consumes the Response.
 *
 * By the time an error surfaces in `onError`, the Response object is gone: the
 * SDK throws `new Error(await response.text())`, so the only survivor is a
 * string. A 502 from the edge and a mid-stream provider failure arrive as
 * indistinguishable `Error`s — which is why a hosted 502 on a chat turn
 * produced ZERO client telemetry and no way to attribute the failure.
 */
export type ChatResponseMeta = {
  ok: boolean;
  status: number;
  contentType?: string;
  /** Server-issued `x-request-id`, the join key to the Axiom row. */
  requestId?: string;
  /**
   * `x-mcpjam-error-origin`, when our own route already made the call.
   *
   * The server's chat route reports the failure through `reportRouteFailure`
   * and knows, for instance, that the 500 came from the user's MCP server
   * failing to list tools. That verdict has to travel on a HEADER: the body is
   * unreachable here because the AI SDK consumes the Response before this code
   * ever sees the failure.
   */
  origin?: string;
};

/** Origins the server may assert, kept in sync with the SDK's `ErrorOrigin`. */
const SERVER_ASSERTED_ORIGINS = new Set([
  "user_server",
  "user_config",
  "mcpjam",
  "ambiguous",
]);

/** Keep a quoted upstream body from bloating the event. */
const MAX_EXTRA_CHARS = 1000;

/**
 * Synthetic, STABLE message for the reported error.
 *
 * Not cosmetic. `BROWSER_IGNORE_ERRORS` drops `"Failed to fetch"`,
 * `"Load failed"`, and `/^AbortError/` BY MESSAGE, and those are exactly the
 * strings a failed chat request arrives with — reporting the raw message would
 * mean reporting nothing. The real message is preserved in `extra.rawMessage`.
 *
 * It is also what makes Sentry grouping useful: every 502 on this path becomes
 * one issue instead of one issue per upstream body.
 */
function syntheticMessage(meta: ChatResponseMeta | null): string {
  if (meta && !meta.ok) return `chat_request_failed:${meta.status}`;
  return "chat_stream_error";
}

/**
 * Whose fault a chat turn dying was.
 *
 * The describer alone cannot answer this. The AI SDK throws
 * `new Error(await response.text())`, so a hosted 502 arrives as an Error whose
 * message is an HTML page — `internal/unknown`, i.e. `ambiguous`, which under a
 * strict `mcpjam`-only policy would report nothing for the exact failure this
 * reporting was built to see.
 *
 * The status closes that gap, the same way the server's
 * `describeBackendStreamFailure` does: a 5xx here came from MCPJam's OWN chat
 * route, and our own route answering 5xx is ours. Everything else keeps the
 * catalog's verdict — a 4xx is a request problem, and a fetch that never
 * produced a response at all is most often the user's network, which is not an
 * MCPJam incident.
 *
 * A slug that positively identifies the user is never overruled: an
 * ECONNREFUSED to their own MCP server stays theirs even if it somehow arrived
 * alongside a 5xx.
 *
 * Neither is a verdict the SERVER already reached. The status fallback is a
 * guess made from the only evidence that normally survives the AI SDK; when
 * `x-mcpjam-error-origin` is present the route classified the actual throw,
 * with the error object in hand, and that answer wins. Without this the chat
 * route's own "this 500 was the user's MCP server failing to list tools" would
 * be relabelled `mcpjam` one hop later and page us anyway.
 */
function attributeChatFailure(
  normalized: NormalizedError,
  meta: ChatResponseMeta | null,
): ReturnType<typeof originOf> {
  const declared = originOf(normalized);
  if (declared === "user_server" || declared === "user_config") return declared;
  if (meta?.origin && SERVER_ASSERTED_ORIGINS.has(meta.origin)) {
    return meta.origin as ReturnType<typeof originOf>;
  }
  if (meta && !meta.ok && meta.status >= 500) return "mcpjam";
  return declared;
}

/**
 * Report a chat-turn failure, if this surface reports at all.
 *
 * Returns whether anything was sent, so callers and tests can assert the
 * gating rather than infer it.
 */
export function reportChatFailure(
  error: Error,
  meta: ChatResponseMeta | null,
): boolean {
  // Aborts are the user pressing Stop. They are filtered from Sentry by
  // message today, and the synthetic message above would smuggle them past
  // that filter — so drop them here, explicitly, rather than relying on a
  // string match that this function is specifically designed to defeat.
  if (isAbortError(error)) return false;

  // `reportCaught`'s Sentry leg is UNGATED: it fires on self-hosted npx and
  // Docker installs too. Chat failures are high-volume and mostly other
  // people's infrastructure, so gate at the call site — the same boundary
  // PostHog capture already uses.
  if (!isErrorCaptureSurface()) return false;

  const normalized = describeError(error);
  const origin = attributeChatFailure(normalized, meta);
  // EXACTLY the server capture policy: `mcpjam` and nothing else. This path is
  // high volume and mostly other people's infrastructure, and the synthetic
  // message below is deliberately built to slip past the by-message filter
  // that used to catch some of it — so anything looser here would rebuild on
  // the client the noise the server-side policy removes.
  if (origin !== "mcpjam") return false;

  const isRequestFailure = Boolean(meta && !meta.ok);

  // NOT `synthetic.stack = error.stack`. V8 renders a stack as
  // "<name>: <message>\n at …", so copying the stack would smuggle the raw
  // message back in through the field below being careful about it.
  const synthetic = new Error(syntheticMessage(meta));

  reportCaught(synthetic, {
    source: isRequestFailure ? "chat_request_failed" : "chat_stream_error",
    extra: {
      // `normalized.rawMessage`, NOT `error.message`. The describer has
      // already redacted bearer tokens, OAuth secrets, and provider keys —
      // and the raw text here is an upstream RESPONSE BODY, which is exactly
      // the kind of thing that carries them.
      rawMessage: normalized.rawMessage.slice(0, MAX_EXTRA_CHARS),
      slug: normalized.slug,
      origin,
      ...(meta
        ? {
            httpStatus: meta.status,
            ...(meta.contentType ? { contentType: meta.contentType } : {}),
            ...(meta.requestId ? { requestId: meta.requestId } : {}),
          }
        : {}),
    },
  });
  return true;
}
