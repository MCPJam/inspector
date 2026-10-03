import {
  describeError,
  originOf,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import { isAbortError } from "@/shared/abort-errors";
import {
  AGENT_SURFACE,
  agentFingerprint,
  agentPageClass,
  type FailureFacts,
} from "@/shared/agent-failure-class";
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
  /**
   * `x-mcpjam-failure-captured`: whether the server already sent a failure on
   * this request to Sentry (`1`) or not (`0`). Ask MCPJam routes set it on
   * every response; absent elsewhere. A stream's own later failures say so on
   * their error trace events instead, since its headers left first.
   */
  failureCaptured?: boolean;
};

/**
 * What a chat `fetch` saw, read off the Response before the AI SDK consumes
 * it. Shared by the Playground's `chatFetch` and Ask MCPJam's fetch wrapper so
 * the two cannot read the same headers differently.
 */
export function readChatResponseMeta(response: Response): ChatResponseMeta {
  // `headers?.`: a wrapper in front of the SDK must never be what throws, and
  // not every fetch shim hands back a full Response.
  const header = (name: string) => response.headers?.get(name) ?? undefined;
  const captured = header("x-mcpjam-failure-captured");
  return {
    ok: response.ok,
    status: response.status,
    contentType: header("content-type"),
    requestId: header("x-request-id"),
    // The route's own verdict on whose fault this was, when it had the
    // error object in hand. Read from a header because the body is
    // consumed by the AI SDK before the reporter ever runs.
    origin: header("x-mcpjam-error-origin"),
    ...(captured === "1" || captured === "0"
      ? { failureCaptured: captured === "1" }
      : {}),
  };
}

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
 * Ask MCPJam's reporting mode. See {@link reportChatFailure}.
 */
export type AgentChatFailureOptions = {
  agent: Omit<FailureFacts, "source"> & {
    /** What went wrong, from the browser's side; part of the fingerprint. */
    source: string;
  };
};

/**
 * Report a chat-turn failure, if this surface reports at all.
 *
 * Returns whether anything was sent, so callers and tests can assert the
 * gating rather than infer it.
 *
 * AGENT MODE (`options.agent`): Ask MCPJam reports every failure the server
 * did not, from every install, classified with the same `page_class` rules
 * the server uses. It skips the hosted/desktop surface gate and the origin
 * gate below — the agent is ours end to end, and those gates are what kept a
 * week of self-hosted failures out of Sentry. It keeps the abort drop and the
 * synthetic messages, and skips a browser that knows it is offline.
 */
export function reportChatFailure(
  error: Error,
  meta: ChatResponseMeta | null,
  options?: AgentChatFailureOptions,
): boolean {
  // Aborts are the user pressing Stop. They are filtered from Sentry by
  // message today, and the synthetic message above would smuggle them past
  // that filter — so drop them here, explicitly, rather than relying on a
  // string match that this function is specifically designed to defeat.
  if (isAbortError(error)) return false;

  if (options?.agent) return reportAgentChatFailure(error, meta, options.agent);

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

function reportAgentChatFailure(
  error: Error,
  meta: ChatResponseMeta | null,
  facts: AgentChatFailureOptions["agent"],
): boolean {
  // A browser that knows it is offline: the user's network, not a signal.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }
  const normalized = describeError(error);
  // One status for both the class and the fingerprint: the caller's, else the
  // failed response's.
  const resolvedFacts = {
    ...facts,
    ...(meta && !meta.ok && facts.httpStatus === undefined
      ? { httpStatus: meta.status }
      : {}),
  };
  const pageClass = agentPageClass(resolvedFacts);
  const synthetic = new Error(syntheticMessage(meta));
  reportCaught(synthetic, {
    source: `mcpjam_agent:${facts.source}`,
    level: facts.level ?? (pageClass === "routine" ? "warning" : "error"),
    tags: {
      surface: AGENT_SURFACE,
      page_class: pageClass,
      agent_failure_source: facts.source,
      ...(facts.code ? { agent_failure_code: facts.code } : {}),
    },
    fingerprint: agentFingerprint(resolvedFacts),
    extra: {
      // Redacted by the describer; see the Playground branch above.
      rawMessage: normalized.rawMessage.slice(0, MAX_EXTRA_CHARS),
      slug: normalized.slug,
      ...(facts.code ? { code: facts.code } : {}),
      ...(facts.reason ? { reason: facts.reason } : {}),
      ...(facts.gatedBy ? { gatedBy: facts.gatedBy } : {}),
      ...(facts.scope ? { scope: facts.scope } : {}),
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
