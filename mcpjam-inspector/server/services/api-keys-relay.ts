import { HOSTED_MODE } from "../config.js";
import { hasServiceCredential } from "./service-credential.js";

/**
 * Local builds (npx, Docker, Electron) cannot mint API keys themselves: doing
 * so takes `WORKOS_API_KEY` (MCPJam's WorkOS admin key) and
 * `INSPECTOR_SERVICE_TOKEN` (the secret for MCPJam's Convex internal routes),
 * and neither can ever ship to a self-hoster. They sign in against MCPJam's
 * production WorkOS client though, so the same session token is valid at the
 * hosted app. Rather than fail with a missing-config error, the local server
 * relays key management there and lets the hosted server do the work.
 *
 * The relay holds no credential of its own. It forwards the caller's
 * `Authorization` header and nothing else, to one fixed origin.
 */

export const DEFAULT_HOSTED_API_URL = "https://app.mcpjam.com";

/** Matches the hosted router's own ceiling on a mint (WorkOS + Convex hops). */
export const API_KEYS_RELAY_TIMEOUT_MS = 30_000;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Request headers the relay forwards. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = ["authorization", "content-type", "accept"];

/** Response headers handed back to the caller. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"];

/**
 * True when this server cannot administer keys itself and should hand the
 * request to the hosted app instead. A hosted deployment never relays (it
 * would loop onto itself); a local one relays unless an operator has supplied
 * BOTH secrets, in which case it behaves exactly as before.
 */
export function shouldRelayApiKeys(
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = HOSTED_MODE,
): boolean {
  if (hosted) return false;
  return !env.WORKOS_API_KEY?.trim() || !hasServiceCredential(env);
}

/**
 * The hosted origin, `MCPJAM_HOSTED_API_URL` or `https://app.mcpjam.com`.
 * The caller's bearer token goes to this host, so a value that is neither
 * https nor loopback, or that carries a path, is refused rather than used.
 */
export function resolveHostedApiOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.MCPJAM_HOSTED_API_URL?.trim();
  if (!raw) return DEFAULT_HOSTED_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCPJAM_HOSTED_API_URL is not a valid URL");
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("MCPJAM_HOSTED_API_URL must be https (or loopback http)");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new Error("MCPJAM_HOSTED_API_URL must be an origin with no path");
  }
  return url.origin;
}

export class ApiKeysRelayError extends Error {
  readonly reason: "unreachable" | "timeout" | "redirect" | "misconfigured";
  constructor(reason: ApiKeysRelayError["reason"], message: string) {
    super(message);
    this.name = "ApiKeysRelayError";
    this.reason = reason;
  }
}

/**
 * Replay `request` against the hosted app and return its response. The
 * response body is streamed through untouched — for a mint it carries the
 * plaintext key once, so it is never read, logged or kept here.
 */
export async function relayApiKeysRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  let origin: string;
  try {
    origin = resolveHostedApiOrigin(env);
  } catch (error) {
    throw new ApiKeysRelayError(
      "misconfigured",
      error instanceof Error ? error.message : String(error),
    );
  }

  const incoming = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${incoming.pathname}${incoming.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      // A redirect would carry the bearer to wherever it points.
      redirect: "manual",
      signal: AbortSignal.timeout(API_KEYS_RELAY_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ApiKeysRelayError(
      timedOut ? "timeout" : "unreachable",
      `Could not reach ${origin} to manage API keys`,
    );
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    throw new ApiKeysRelayError(
      "redirect",
      `${origin} answered the API key request with a redirect`,
    );
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
