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

/** The transport caps itself at five; this loop replaces that cap with its own. */
const MAX_REDIRECT_HOPS = 5;

/** Credentials, in the sense Fetch means: dropped when the origin changes. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
];

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The host alone — never the path or query, which can carry a token. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unparseable URL";
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function withoutCredentials(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase())
    )
  );
}

/**
 * Every hop must be https, unless loopback was opted into AND this hop is
 * actually loopback.
 *
 * The opt-in is for reaching `http://127.0.0.1:3000/mcp` in local development.
 * It is not a blanket permission to speak plaintext, so a dev-mode probe that
 * redirects off to a public http host is refused exactly like a hosted one.
 */
function assertSchemeAllowed(url: string, allowLoopback: boolean): void {
  if (isHttps(url)) return;
  if (allowLoopback && isLoopbackOAuthUrl(url)) return;
  throw new BlockedEgressTargetError(
    `Refusing a plaintext connection to "${safeHost(url)}".`
  );
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

    // LOOPBACK IS GATED HERE, BECAUSE THE TRANSPORT CANNOT BE TOLD.
    // `OAuthProxyRequest` has no loopback field — the SDK derives permission
    // from the URL itself (`allowLoopbackFlow = !httpsOnly &&
    // isLoopbackOAuthUrl(url)`). We must pass `httpsOnly: false`, since a
    // loopback dev target is plaintext by nature, and that alone made
    // `http://127.0.0.1:…` reachable in production: the `allowLoopback` option
    // below was declared, documented, and enforced by nobody.
    //
    // Only the INITIAL url needs this particular check. `allowLoopbackFlow` is
    // computed by the transport once per call, from the url it was given, and
    // the loop below gives it every hop separately — so a public target that
    // redirects to loopback is refused by the transport's own classifier on the
    // hop that names it.
    if (options.allowLoopback !== true && isLoopbackOAuthUrl(url)) {
      throw new BlockedEgressTargetError(
        `Refusing a connection to loopback address "${new URL(url).hostname}".`
      );
    }

    try {
      // REDIRECTS ARE FOLLOWED HERE, ONE HOP AT A TIME, so every hop's scheme
      // is checked before its socket opens.
      //
      // Handing `redirect: "follow"` to the transport and inspecting only
      // `result.finalUrl` afterwards is not equivalent: a chain of
      // https → http → https ends on https and passes that check, while the
      // middle hop happened in plaintext. Nothing is leaked there — credentials
      // are stripped across origins and the scheme is part of an origin — but
      // anyone on the path can rewrite that hop's `Location` and choose where
      // the probe ends up, which decides the auth method we record and the
      // authorization server we would later send a person to.
      //
      // Each hop is a fresh `executeOAuthProxy` call, so each one gets the full
      // treatment: resolve once, refuse private answers, pin the address.
      let currentUrl = url;
      let currentHeaders = headers;
      let result: Awaited<ReturnType<typeof executeOAuthProxy>> | undefined;

      for (let hop = 0; ; hop += 1) {
        if (hop > MAX_REDIRECT_HOPS) {
          throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS}).`);
        }

        assertSchemeAllowed(currentUrl, options.allowLoopback === true);

        result = await executeOAuthProxy({
          url: currentUrl,
          method: init?.method ?? "GET",
          headers: currentHeaders,
          body: init?.body ?? undefined,
          // HTTPS for PUBLIC hosts is enforced by `assertSchemeAllowed` above
          // rather than by the transport, so a loopback dev target stays
          // reachable when it opted in. Passing `httpsOnly: true` instead would
          // ALSO force `redirect: "manual"` inside the transport, which is what
          // this loop is doing deliberately and per-hop.
          httpsOnly: false,
          redirect: "manual",
          timeoutMs: options.timeoutMs,
        });

        const location = result.headers["location"] ?? result.headers["Location"];
        if (!isRedirectStatus(result.status) || !location) break;

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error("The server returned an invalid redirect location.");
        }

        // Match Fetch's credential boundary, which the transport applies within
        // a single call and cannot apply across these separate ones.
        currentHeaders = sameOrigin(currentUrl, nextUrl.toString())
          ? currentHeaders
          : withoutCredentials(currentHeaders);
        currentUrl = nextUrl.toString();
      }

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
          // NOT the transport's message. It names the address the hostname
          // RESOLVED to — "example.com resolves to a private/reserved IP
          // address (169.254.169.254)" — and this error's message is reported
          // back to whoever submitted the hostname. That would make a refusal
          // into a resolution oracle: submit a name, read back what our
          // resolver saw, and map the internal network one answer at a time.
          // The requested host is fine to repeat (they typed it); what it
          // resolved to is not. The original stays on `cause` for logs.
          throw new BlockedEgressTargetError(
            `Refusing to connect to "${safeHost(url)}": it is not a publicly routable address.`,
            { cause: error }
          );
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
