// Imported from the SDK rather than `../../utils/oauth-proxy.js`: suites mock
// that module and load this helper from inside the mock factory, so importing
// it here would be a cycle. The server util is a bare re-export either way.
import { validateUrl } from "@mcpjam/sdk";
import type {
  OAuthProxyRequest,
  OAuthProxyResponse,
} from "../../utils/oauth-proxy.js";

/**
 * In-memory transport seam for server route/service suites.
 *
 * `executeOAuthProxy` and `fetchOAuthMetadata` connect through raw
 * `node:http(s).request` so they can pin a validated DNS address to the socket.
 * That is deliberately un-stubbable via `global.fetch`, so suites which model
 * the network with a `fetch` mock route these two calls back through it here.
 * Production pinning/redirect behavior is covered by
 * `server/utils/__tests__/oauth-proxy.test.ts` and the SDK's `oauth-proxy`
 * suite; these adapters exist so route and service tests can stay focused on
 * their own logic.
 */

function encodeBody(
  req: OAuthProxyRequest,
  method: string,
): string | undefined {
  if (method !== "POST" || req.body === undefined || req.body === null) {
    return undefined;
  }

  const headers = req.headers ?? {};
  const contentType = headers["Content-Type"] ?? headers["content-type"] ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") &&
    typeof req.body === "object"
  ) {
    return new URLSearchParams(
      Object.entries(req.body as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)],
      ),
    ).toString();
  }
  return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
}

export async function executeOAuthProxyViaFetch(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  // Keep the real SSRF gate: callers assert that a private/reserved target is
  // refused before any outbound request is attempted.
  await validateUrl(req.url, req.httpsOnly);
  const method = (req.method ?? "GET").toUpperCase();
  const response = await global.fetch(req.url, {
    method,
    headers: req.headers,
    body: encodeBody(req, method),
    redirect: req.httpsOnly ? "manual" : (req.redirect ?? "follow"),
    signal:
      req.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(req.timeoutMs),
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    finalUrl: response.url || req.url,
  };
}

/** Mirrors the real `fetchOAuthMetadata` result contract, including its
 * non-JSON and invalid-body 502s, so callers see the same shapes. */
export async function fetchOAuthMetadataViaFetch(
  url: string,
  httpsOnly = false,
  timeoutMs?: number,
): Promise<
  | { metadata: Record<string, unknown>; finalUrl: string; status?: undefined }
  | { status: number; statusText: string }
> {
  // Keep the real SSRF gate: callers assert that a private/reserved target is
  // refused before any outbound request is attempted.
  await validateUrl(url, httpsOnly);
  const response = await global.fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal:
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    return { status: response.status, statusText: response.statusText };
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return {
      status: 502,
      statusText: `Upstream returned non-JSON content-type: ${
        contentType ?? "(none)"
      }`,
    };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.json()) as Record<string, unknown>;
  } catch {
    return { status: 502, statusText: "Upstream returned invalid JSON body" };
  }

  return { metadata, finalUrl: response.url || url };
}
