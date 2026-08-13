/**
 * A `fetch`-shaped front door onto the SDK's DNS-pinned OAuth transport.
 *
 * WHY THIS EXISTS. `utils/hosted-egress-guard.ts` classifies a hostname's DNS
 * answer and then hands the URL to an HTTP client that resolves it a SECOND
 * time — its own docblock says so. Between those two resolutions the answer can
 * change, which is the whole DNS-rebinding attack: name a host you control,
 * pass the check with a public address, and serve 169.254.169.254 to the
 * connection that actually happens.
 *
 * `@mcpjam/sdk/oauth/node` closes that window. It resolves once, refuses the
 * disallowed answers, and PINS the surviving addresses into the socket, so the
 * address that was checked is the address that gets connected. It re-validates
 * every redirect hop under the same rules (capped at five) and strips
 * credentials across origins.
 *
 * The mismatch this adapter fixes: `server-connection-discovery.ts` already
 * imports the SDK's classifier while dialling through the local guard — the
 * safe half without the half that makes it safe. The SDK entry that closes the
 * gap shipped one day before that module, so this is a wiring gap rather than a
 * disagreement about what is correct.
 *
 * SCOPE. Deliberately narrow. This is for probing an attacker-supplied MCP
 * server URL — the connection flow's discovery and validation steps. It is not
 * a general-purpose fetch: the SDK transport buffers the whole response body
 * (bounded) and cannot stream, so it must never be pointed at SSE or a large
 * download.
 */

import { executeOAuthProxy, OAuthProxyError } from "@mcpjam/sdk/oauth/node";

export interface PinnedFetchOptions {
  /**
   * Local-dev opt-in for loopback targets. Carved out for loopback ONLY — it
   * never relaxes the guard for LAN, link-local, CGNAT, multicast,
   * documentation, NAT64-private, or IPv4-mapped-private addresses.
   */
  allowLoopback?: boolean;
  /** Bounds DNS, connection setup, redirects, and the body read together. */
  timeoutMs?: number;
}

/**
 * Serialize whatever the SDK transport handed back into a `Response` body.
 *
 * The transport parses JSON when it can, so a JSON response arrives as an
 * object and has to be re-serialized for a caller that expects to call
 * `.json()` itself. Anything else passes through as text.
 */
function toBodyInit(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Build a `fetch`-compatible function backed by the pinned transport.
 *
 * The returned function accepts the subset of `fetch`'s surface the MCP probe
 * actually uses — a URL, a method, headers, and a body. It does NOT support
 * streaming, `AbortSignal` composition beyond the timeout, or credentials, and
 * a caller who needs those is a caller who should not be using this.
 */
export function createPinnedFetch(
  options: PinnedFetchOptions = {}
): typeof fetch {
  const pinnedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers ?? (input as Request)?.headers;
    if (rawHeaders) {
      new Headers(rawHeaders).forEach((value, key) => {
        headers[key] = value;
      });
    }

    try {
      const result = await executeOAuthProxy({
        url,
        method: init?.method ?? "GET",
        headers,
        body: init?.body ?? undefined,
        // HTTPS is enforced by the caller's own guard rather than here, so a
        // loopback dev target stays reachable when it opted in.
        httpsOnly: false,
        redirect: "follow",
        timeoutMs: options.timeoutMs,
      });

      return new Response(toBodyInit(result.body), {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    } catch (error) {
      // The transport raises a typed error for a blocked or malformed target.
      // Rethrow as a plain Error so callers classify on their own rules rather
      // than importing this module's exception type — discovery already has a
      // three-way taxonomy and this is just one input to it.
      if (error instanceof OAuthProxyError) {
        throw new Error(error.message);
      }
      throw error;
    }
  };

  return pinnedFetch as typeof fetch;
}
