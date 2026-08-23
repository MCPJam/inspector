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
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

export const PROXY_TIMEOUT_MS = 15_000;

/** Copy whitelisted query params from the incoming request onto the target. */
export function forwardQueryParams(
  c: Context,
  target: URL,
  names: readonly string[]
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
  options: { public?: boolean } = {}
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const bearer = options.public
    ? undefined
    : await getConvexBearerForRequest(c);
  const target = new URL(convexPath, convexUrl);
  configure?.(target);

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
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
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
        `Catalog service returned a non-JSON response (${response.status})`
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
        : "Failed to reach the catalog service"
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
  ] as const) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { status: response.status, body, headers };
}

export async function proxyConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void,
  options?: { public?: boolean }
): Promise<Response> {
  const { status, body, headers } = await fetchConvexV1Read(
    c,
    convexPath,
    configure,
    options
  );
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  // Same envelope on both surfaces — pass status and body through verbatim.
  return c.json(body as Record<string, unknown>, status as 200);
}
