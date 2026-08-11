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
  const isRequestFailure = Boolean(meta && !meta.ok);

  const synthetic = new Error(syntheticMessage(meta));
  // Keep the real stack; only the message is replaced.
  synthetic.stack = error.stack;

  reportCaught(synthetic, {
    source: isRequestFailure ? "chat_request_failed" : "chat_stream_error",
    extra: {
      rawMessage: error.message.slice(0, MAX_EXTRA_CHARS),
      slug: normalized.slug,
      origin: originOf(normalized),
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
