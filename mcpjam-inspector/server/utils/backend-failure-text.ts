/**
 * The sentence a caller sees when MCPJam's own backend answers with a failure
 * (MJ-020, MJ-021).
 *
 * The backend's `error` string on these paths is written for us — it can carry
 * Convex's framing, a function's argument validation output, internal names.
 * In hosted mode the caller gets the route's fixed copy instead, and the text
 * goes to the log. A local inspector keeps showing the text, as it always has:
 * the person reading it is the one running the server.
 */
import { HOSTED_MODE } from "../config.js";
import { logger } from "./logger.js";
import { redactForLog } from "../routes/v1/redact-log-message.js";

export interface BackendFailureText {
  /** Log label for the call site, e.g. `"chat-history"`. */
  source: string;
  /** The backend's HTTP status, recorded with the withheld text. */
  status: number;
  /** The backend's `error` field, whatever it was. */
  detail: unknown;
  /** The route's own copy for this failure. */
  fallback: string;
  /** Defaults to `HOSTED_MODE`; tests pass it explicitly. */
  hosted?: boolean;
}

export function backendFailureText(failure: BackendFailureText): string {
  const text =
    typeof failure.detail === "string" && failure.detail.trim()
      ? failure.detail
      : undefined;
  if (!text) return failure.fallback;
  if (!(failure.hosted ?? HOSTED_MODE)) return text;
  logger.warn(`[${failure.source}] backend error text withheld from response`, {
    status: failure.status,
    detail: redactForLog(text),
  });
  return failure.fallback;
}
