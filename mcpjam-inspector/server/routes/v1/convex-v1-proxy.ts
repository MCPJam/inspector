/**
 * Shared plumbing for the v1 routes that proxy reads to the Convex `/v1/*`
 * surface (`catalog.ts`, `registry.ts`).
 *
 * These handlers only translate path-param style to Convex's query-param
 * style and swap in a Convex-acceptable bearer; status and body pass through
 * verbatim because the Convex surface emits the same v1 envelope
 * (resource-direct / `{items, nextCursor?}` / `{code, message, details?}`),
 * enforced by the shared contract fixtures.
 *
 * Extracted from `catalog.ts` when `registry.ts` grew a verbatim copy — a
 * timeout/error classifier and a forwarded-header whitelist are exactly the
 * things that must not drift between two copies.
 */
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  hostedInternalErrorMessage,
  responseRequestId,
} from "../web/hosted-internal-error.js";
import { redactForLog } from "./redact-log-message.js";
import {
  API_VOCABULARY_HEADER,
  UNKNOWN_API_VOCABULARY_MESSAGE,
  apiVocabularyOf,
  hasUnknownApiVocabulary,
} from "./api-vocabulary.js";

export const PROXY_TIMEOUT_MS = 15_000;

/**
 * Convex's own failure prose, relayed inside an upstream error envelope. An
 * argument-validation rejection quotes the whole validator definition
 * (`Validator: v.union(v.literal("mcp-apps"), …)`) and Convex prefixes its
 * request id — text written for operators, not callers (MJ-020 retest #3:
 * "the raw Convex validator is still returned by the read-proxy family").
 * The verbatim-passthrough contract holds for envelopes the upstream AUTHORED;
 * these markers only ever appear when it relayed a Convex exception instead.
 */
const CONVEX_INTERNAL_DETAIL =
  /\bArgumentValidationError\b|\bValidator:\s|\[Request ID:/;

/**
 * Withhold relayed Convex exception text from a proxied error body (MJ-020).
 *
 * Hosted mode only, matching `backendFailureText`: a local inspector keeps the
 * verbatim passthrough, because the person reading it runs the server. The
 * status is preserved either way; only the leaking body is replaced, with the
 * detail logged under the request id the caller is given.
 */
function sanitizeProxiedFailure(
  c: Context,
  convexPath: string,
  status: number,
  body: unknown,
): unknown {
  if (status < 400) return body;
  // `body` came out of `response.json()`, so it is always serializable.
  const serialized = JSON.stringify(body) ?? "";
  if (!CONVEX_INTERNAL_DETAIL.test(serialized)) return body;
  if (!HOSTED_MODE) return body;
  const { requestId } = responseRequestId(c);
  logger.warn("[v1.read-proxy] upstream error text withheld from response", {
    convexPath,
    status,
    requestId,
    detail: redactForLog(serialized),
  });
  const upstreamCode = (body as { code?: unknown } | null)?.code;
  const code =
    typeof upstreamCode === "string" && !CONVEX_INTERNAL_DETAIL.test(upstreamCode)
      ? upstreamCode
      : status >= 500
        ? ErrorCode.INTERNAL_ERROR
        : ErrorCode.VALIDATION_ERROR;
  return {
    code,
    message:
      status >= 500
        ? hostedInternalErrorMessage(requestId)
        : `One or more request parameters were invalid. If it keeps happening, contact support with reference ${requestId}.`,
    details: { requestId },
  };
}

/** Copy whitelisted query params from the incoming request onto the target. */
export function forwardQueryParams(
  c: Context,
  target: URL,
  names: readonly string[],
): void {
  for (const name of names) {
    const value = c.req.query(name);
    if (typeof value === "string" && value.length > 0) {
      target.searchParams.set(name, value);
    }
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

export async function fetchConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void,
  options: { public?: boolean; negotiatesVocabulary?: boolean } = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  const bearer = options.public
    ? undefined
    : await getConvexBearerForRequest(c);
  const target = new URL(convexPath, convexUrl);
  configure?.(target);

  // The noun-value vocabulary is NEGOTIATED UPSTREAM for these reads: the
  // bodies are Convex's DTOs, passed through verbatim, so Convex is the only
  // layer that can project them. Refusing an unknown value here first means
  // the caller gets this surface's own error envelope rather than one relayed
  // from a service it never addressed.
  let vocabularyHeader: string | undefined;
  if (options.negotiatesVocabulary) {
    if (hasUnknownApiVocabulary(c)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        UNKNOWN_API_VOCABULARY_MESSAGE,
      );
    }
    // Reads the header AND appends `Vary` — on this response, not just the
    // upstream's, because this is the response a cache in front of us sees.
    vocabularyHeader = String(apiVocabularyOf(c));
  }

  // The abort deadline must cover the WHOLE exchange: `fetch` resolves on
  // headers, so clearing the timer there would leave a stalled response
  // body free to hang `response.json()` indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(vocabularyHeader
          ? { [API_VOCABULARY_HEADER]: vocabularyHeader }
          : {}),
      },
      signal: controller.signal,
    });
    try {
      body = await response.json();
    } catch (parseError) {
      // A body stalled past the deadline rejects with an abort, which is a
      // timeout, not a malformed payload — let the outer classifier map it.
      if (isAbortError(parseError)) throw parseError;
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Catalog service returned a non-JSON response (${response.status})`,
      );
    }
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    const isAbort = isAbortError(error);
    throw new WebRouteError(
      isAbort ? 504 : 502,
      isAbort ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Catalog read timed out after ${PROXY_TIMEOUT_MS}ms`
        : "Failed to reach the catalog service",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "x-next-cursor",
    "x-mcpjam-next-cursor",
    "x-mcpjam-export-complete",
    "access-control-expose-headers",
    "link",
    "vary",
  ] as const) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return {
    status: response.status,
    body: sanitizeProxiedFailure(c, convexPath, response.status, body),
    headers,
  };
}

export async function proxyConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void,
  options?: { public?: boolean; negotiatesVocabulary?: boolean },
): Promise<Response> {
  const { status, body, headers } = await fetchConvexV1Read(
    c,
    convexPath,
    configure,
    options,
  );
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  // Same envelope on both surfaces — pass status and body through verbatim.
  return c.json(body as Record<string, unknown>, status as 200);
}
