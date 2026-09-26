/**
 * What a hosted `500 INTERNAL_ERROR` response says (MJ-020, MJ-021).
 *
 * A generic sentence and the request id, and nothing about the failure itself.
 * The id is the same one the response's `x-request-id` header carries and the
 * request log records, so a screenshot of the error is enough to find the row.
 * The original message is not lost: both serializers leave it on
 * `webErrorMeta`, which is what `requestLogContextMiddleware` writes to
 * `http.request.failed` — the detail lives server-side, joined by that id.
 *
 * Hosted only. A local inspector keeps the message it has always shown; the
 * person reading it is the one running the server.
 *
 * Shared by the `/api/web/*` serializer (`webError`) and the `/api/v1/*` one
 * (`v1Error`), so neither surface can answer a 500 some other way.
 */
import { randomUUID } from "node:crypto";
import type { NormalizedError } from "@mcpjam/sdk";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { redactForLog } from "../v1/redact-log-message.js";

export function hostedInternalErrorMessage(requestId: string): string {
  return `An unexpected error occurred. If it keeps happening, contact support with reference ${requestId}.`;
}

/** The caller-visible parts of an error envelope. */
export interface ErrorResponseView {
  message: string;
  details?: Record<string, unknown>;
  normalized?: NormalizedError;
}

/**
 * The view to serialize for this status/code: unchanged, except for a hosted
 * `500 INTERNAL_ERROR`, which gets the generic sentence, `details.requestId`,
 * and a describe block reduced to its catalog fields.
 *
 * `details` keep what the route put there on purpose (the v1 agent turn hands
 * back the resources a failed turn still created); only the message and the
 * describer's copies of it are replaced.
 */
export function internalErrorResponseView(
  c: unknown,
  status: number,
  code: string,
  view: ErrorResponseView,
  options: { hosted?: boolean } = {},
): ErrorResponseView {
  const hosted = options.hosted ?? HOSTED_MODE;
  if (!hosted || status !== 500 || code !== "INTERNAL_ERROR") return view;

  const { requestId, minted } = responseRequestId(c);
  if (minted) {
    // No request log wraps this response, so this line is the only record of
    // the message the body no longer carries.
    logger.warn("[http] internal error response", {
      requestId,
      detail: redactForLog(view.message),
    });
  }
  const message = hostedInternalErrorMessage(requestId);
  return {
    message,
    details: { ...(view.details ?? {}), requestId },
    ...(view.normalized
      ? { normalized: catalogOnly(view.normalized, message, requestId) }
      : {}),
  };
}

/**
 * The describe block without anything read off the failure: `rawMessage`,
 * `cause`, `rawCode`, and a `oneLine` the describer may have promoted from the
 * raw message all go. Picked field by field, so a field added later stays out
 * until someone decides it belongs.
 */
function catalogOnly(
  normalized: NormalizedError,
  message: string,
  requestId: string,
): NormalizedError {
  return {
    slug: normalized.slug,
    title: normalized.title,
    oneLine: message,
    likelyCauses: normalized.likelyCauses,
    nextSteps: normalized.nextSteps,
    docsAnchor: normalized.docsAnchor,
    severity: normalized.severity,
    ...(normalized.origin ? { origin: normalized.origin } : {}),
    rawMessage: message,
    requestId,
  };
}

/**
 * The id `requestLogContextMiddleware` minted for this request, or a fresh one
 * (also set as `x-request-id`) when the middleware did not run, so the body and
 * the header always agree.
 */
function responseRequestId(c: unknown): { requestId: string; minted: boolean } {
  const existing = requestLogContextId(c);
  if (existing) return { requestId: existing, minted: false };
  const requestId = randomUUID();
  try {
    (
      c as { header?: (name: string, value: string) => void } | undefined
    )?.header?.("x-request-id", requestId);
  } catch {
    // A context double without headers; the body still carries the id.
  }
  return { requestId, minted: true };
}

function requestLogContextId(c: unknown): string | undefined {
  try {
    const get = (c as { get?: unknown } | undefined)?.get;
    if (typeof get !== "function") return undefined;
    const context = (c as { get: (key: string) => unknown }).get(
      "requestLogContext",
    ) as { requestId?: unknown } | undefined;
    return typeof context?.requestId === "string" && context.requestId
      ? context.requestId
      : undefined;
  } catch {
    return undefined;
  }
}
