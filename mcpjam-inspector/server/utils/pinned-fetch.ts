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

import {
  executeOAuthProxy,
  isLoopbackOAuthUrl,
  OAuthProxyError,
} from "@mcpjam/sdk/oauth/node";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "./hosted-egress-guard.js";

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
 * The transport's REFUSALS, told apart from its failures.
 *
 * `OAuthProxyError` carries only a `status`, and it is 400 for both "resolves to
 * a private or reserved IP address" and "request timeout" — a verdict about the
 * target and an outage on our side, which deserve opposite answers. So the
 * discrimination has to come from the message, which is not where anyone wants
 * to be.
 *
 * What makes that safe is the regression test beside this file: it drives the
 * REAL transport at a real reserved address and asserts the class that comes
 * back, so a reworded SDK message fails a test here rather than silently
 * downgrading an SSRF refusal to `retryable` and putting a blocked target back
 * on a retry schedule.
 *
 * Everything not listed stays a plain transport failure — a timeout, a byte cap,
 * a redirect ceiling — because the conservative direction is retryable.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /private\/reserved/i, // "<label> is a private/reserved host (…)"
  /private or reserved address/i, // client-metadata host classifier
  /resolved outside loopback/i, // loopback name that answered publicly
  /invalid protocol/i,
  /invalid url format/i,
  /must not contain credentials/i,
  /only https targets are allowed/i,
];

/** DNS could not answer. Ours to retry, not the caller's to fix. */
const RESOLUTION_FAILURE_PATTERN = /could not resolve/i;

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

    // LOOPBACK IS GATED HERE, BECAUSE THE TRANSPORT CANNOT BE TOLD.
    // `OAuthProxyRequest` has no loopback field — the SDK derives permission
    // from the URL itself (`allowLoopbackFlow = !httpsOnly &&
    // isLoopbackOAuthUrl(url)`). We must pass `httpsOnly: false`, since a
    // loopback dev target is plaintext by nature, and that alone made
    // `http://127.0.0.1:…` reachable in production: the `allowLoopback` option
    // below was declared, documented, and enforced by nobody.
    //
    // Only the INITIAL url needs this check. `allowLoopbackFlow` is computed
    // once, from that url, so a public target that redirects to loopback is
    // already refused by the transport's per-hop classifier. And `httpsOnly:
    // true` is not the fix it looks like: it also forces `redirect: "manual"`,
    // which would turn an ordinary trailing-slash redirect into "this is not an
    // MCP server".
    if (options.allowLoopback !== true && isLoopbackOAuthUrl(url)) {
      throw new BlockedEgressTargetError(
        `Refusing a connection to loopback address "${new URL(url).hostname}".`
      );
    }

    try {
      const result = await executeOAuthProxy({
        url,
        method: init?.method ?? "GET",
        headers,
        body: init?.body ?? undefined,
        // HTTPS for PUBLIC hosts is enforced by the caller's own guard rather
        // than here, so a loopback dev target stays reachable when it opted in
        // (see the gate above, which is what makes that opt-in real).
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
      // PRESERVE THE VERDICT. An earlier revision rethrew every
      // `OAuthProxyError` as a plain `Error`, on the theory that callers should
      // classify on their own rules. They cannot: `server-connection-discovery`
      // decides `terminal` vs `retryable` by `instanceof BlockedEgressTargetError`,
      // so flattening the class made an SSRF refusal indistinguishable from a
      // timeout — the refused target went back on a retry schedule, which is the
      // exact outcome that module's bookkeeping exists to prevent.
      if (error instanceof OAuthProxyError) {
        if (REFUSAL_PATTERNS.some((pattern) => pattern.test(error.message))) {
          throw new BlockedEgressTargetError(error.message);
        }
        if (RESOLUTION_FAILURE_PATTERN.test(error.message)) {
          throw new EgressResolutionError(error.message);
        }
        // A genuine transport failure — timeout, byte cap, redirect ceiling.
        // Still worth retrying, so it stays a plain error.
        throw new Error(error.message);
      }
      throw error;
    }
  };

  return pinnedFetch as typeof fetch;
}
