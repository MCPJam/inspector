import { describeError, originOf } from "@mcpjam/sdk/browser";
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
};

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
  const origin = originOf(normalized);
  // Same rule the server envelopes follow, for the same reason. A chat turn
  // dying because the user's own MCP server refused a connection, or because
  // their BYO key ran out of credit, is not an MCPJam incident — and this path
  // is high volume. Reporting it would rebuild on the client precisely the
  // noise the server-side policy removes, and the synthetic message below is
  // deliberately built to slip past the by-message filter that used to catch
  // some of it.
  if (origin === "user_server" || origin === "user_config") return false;

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
