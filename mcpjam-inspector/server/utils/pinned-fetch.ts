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
  createPinnedStreamingFetch,
  executeOAuthProxy,
  isLoopbackOAuthUrl,
  OAuthProxyError,
} from "@mcpjam/sdk/oauth/node";
import { HOSTED_MODE } from "../config.js";
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
  /**
   * Permit private destinations for the whole chain: loopback, RFC 1918,
   * CGNAT, unique-local, and any hostname resolving to one.
   *
   * DEFAULTS TO `!HOSTED_MODE`, mirroring the `hosted ?? HOSTED_MODE` gate on
   * this module's streaming sibling. On a developer's machine reaching their
   * own network is the product; on our nodes it is the thing this guard
   * exists to stop. Callers that must never reach a private target whatever
   * the deployment (registry derive, benchmark scorecards) pass `false`
   * explicitly.
   *
   * Link-local and cloud-metadata addresses stay refused either way — the SDK
   * enforces that floor and no option here can lift it.
   */
  allowPrivateNetwork?: boolean;
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
  // The streaming transport reaches this one BEFORE any socket exists, and it
  // arrives here as `OAuthProxyError` rather than being thrown directly the way
  // `createPinnedFetch` throws its loopback refusal — so without it a refused
  // target was classified `retryable` and went back on a retry schedule, which
  // is the exact outcome this taxonomy prevents. Loopback belongs in THIS list
  // because in hosted mode "loopback" and "not publicly routable" are the same
  // statement; the refusals below are not.
  /refusing a connection to loopback/i,
  // The floor under the local-network allowance: link-local and cloud metadata
  // are refused in every mode, so their refusal must classify as a verdict
  // about the target rather than as a retryable outage.
  /link-local or cloud-metadata/i,
];

/**
 * Refusals that are just as terminal, and just as much the caller's to fix, but
 * are NOT about where the host resolves.
 *
 * These keep the transport's own wording instead of the canned address message.
 * A connector served over plaintext `http://` is refused for its SCHEME, and
 * telling its owner that their perfectly public host "is not a publicly
 * routable address" sends them to look at DNS and firewalls for a problem that
 * one character in the URL would fix. A redirect chain that runs past the
 * ceiling is the same kind of mismatch. Both are still 400s — the request
 * cannot be retried into success — they simply have to say what is actually
 * wrong.
 */
const TERMINAL_REQUEST_PATTERNS: readonly RegExp[] = [
  /refusing a plaintext connection/i,
  /too many redirects/i,
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

/** Headers that describe a body which no longer exists after a method rewrite. */
function withoutBodyHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !["content-type", "content-length", "content-encoding"].includes(
          name.toLowerCase()
        )
    )
  );
}

/**
 * What is left of the caller's budget.
 *
 * Never returns zero or a negative: `executeOAuthProxy` rejects a
 * non-positive `timeoutMs` outright, and a chain that has already run long
 * should fail as a timeout on the wire rather than as a bad argument.
 */
function remainingTimeout(
  timeoutMs: number | undefined,
  startedAt: number
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return Math.max(1, timeoutMs - (Date.now() - startedAt));
}

/**
 * Every hop must be https, unless loopback was opted into AND this hop is
 * actually loopback.
 *
 * The opt-in is for reaching `http://127.0.0.1:3000/mcp` in local development.
 * It is not a blanket permission to speak plaintext, so a dev-mode probe that
 * redirects off to a public http host is refused exactly like a hosted one.
 */
function assertSchemeAllowed(
  url: string,
  allowLoopback: boolean,
  allowPrivateNetwork: boolean
): void {
  if (isHttps(url)) return;
  if (allowLoopback && isLoopbackOAuthUrl(url)) return;
  // A hop the caller is allowed to reach privately may be plaintext, for the
  // same reason a loopback hop may: the developer's own LAN server is
  // routinely http, and on their machine this request is one their shell could
  // make anyway.
  //
  // Note what this does NOT test: whether the host is private. It cannot —
  // `auth.local` reads as public and answers 127.0.0.1, which is exactly the
  // case being served, so classifying the string here would refuse it. The
  // address decision belongs to the resolver, which makes it once and pins it;
  // this check is only about the scheme. The cost is that a LOCAL caller may
  // also speak plaintext to a genuinely public host on the first hop. Callers
  // that must not (the discovery preflight) refuse that by URL shape before
  // reaching the transport, and after the first hop the chain rule has the
  // resolver's answer and applies it.
  if (allowPrivateNetwork) return;
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
 *
 * `null` for the null-body statuses, and that is load-bearing: `new
 * Response("", { status: 204 })` THROWS — empty string is still a body — so
 * without the carve-out a 204 from a non-MCP endpoint became a transport
 * error, which discovery then classified as retryable and churned on, instead
 * of the terminal "not an MCP server" the actual answer warrants.
 */
function toBodyInit(status: number, body: unknown): string | null {
  if (status === 204 || status === 205 || status === 304) return null;
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
 * actually uses — a URL, a method, headers, a body, and an `AbortSignal`,
 * which is composed with the timeout and aborts the socket itself. It does NOT
 * support streaming or credentials, and a caller who needs those is a caller
 * who should not be using this.
 */
export function createPinnedFetch(
  options: PinnedFetchOptions = {}
): typeof fetch {
  const allowPrivateNetwork = options.allowPrivateNetwork ?? !HOSTED_MODE;
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

    // The caller's signal, threaded into every hop. Without this the
    // `withDeadline` machinery in `server-connection-authorize.ts` — whose
    // comment says aborting the transport "is what actually ends it" — was
    // racing a promise while the request it meant to kill ran to completion,
    // able to finish a client registration at the provider after the caller
    // had already reported failure.
    const signal = init?.signal ?? (input as Request)?.signal ?? undefined;
    signal?.throwIfAborted();

    // LOOPBACK IS GATED HERE, BECAUSE THE TRANSPORT CANNOT BE TOLD.
    // `OAuthProxyRequest` has no loopback field — the SDK derives permission
    // from the URL itself (`allowLoopbackFlow = !httpsOnly &&
    // isLoopbackOAuthUrl(url)`). We must pass `httpsOnly: false`, since a
    // loopback dev target is plaintext by nature, and that alone made
    // `http://127.0.0.1:…` reachable in production: the `allowLoopback` option
    // below was declared, documented, and enforced by nobody.
    if (
      !allowPrivateNetwork &&
      options.allowLoopback !== true &&
      isLoopbackOAuthUrl(url)
    ) {
      throw new BlockedEgressTargetError(
        `Refusing a connection to loopback address "${new URL(url).hostname}".`
      );
    }

    // The allowance belongs to the CHAIN, decided by where it started — the
    // SDK's own contract on `isLoopbackOAuthUrl` ("a public/remote server must
    // never be allowed to steer one at the user's own loopback"). Deriving it
    // per hop from the flag alone meant that with the opt-in set, a PUBLIC
    // target could answer `302 Location: http://127.0.0.1:11434/…` and have
    // the hop dialled: attacker-chosen path, plaintext, on the user's own
    // machine. A chain that STARTED at loopback may keep redirecting within
    // loopback (a local AS bouncing between ports is normal); a chain that
    // started public may not arrive there.
    const chainAllowsLoopback =
      options.allowLoopback === true && isLoopbackOAuthUrl(url);
    // Same chain rule for the wider allowance, with one difference that
    // matters: it CANNOT be decided from the hostname. `auth.local` and
    // `auth.localtest.me` look public and answer 127.0.0.1 — the case this
    // allowance exists to serve — so a name-based test refuses the very thing
    // it is meant to permit. The first hop therefore carries the caller's
    // permission, and the transport reports back where it actually landed;
    // `chainAllowsPrivate` is fixed from that answer for every hop after it.
    let chainAllowsPrivate = allowPrivateNetwork;
    let chainCharacterKnown = false;

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
      let currentMethod = (init?.method ?? "GET").toUpperCase();
      let currentBody = init?.body ?? undefined;
      let result: Awaited<ReturnType<typeof executeOAuthProxy>> | undefined;

      // ONE deadline for the whole chain, not one per hop. `timeoutMs` is the
      // caller's budget for this fetch; handing each hop the full value would
      // let a six-hop chain spend six of them and outlive whatever the caller
      // was bounding.
      const startedAt = Date.now();

      for (let hop = 0; ; hop += 1) {
        if (hop > MAX_REDIRECT_HOPS) {
          throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS}).`);
        }

        signal?.throwIfAborted();
        const hopAllowsLoopback =
          chainAllowsLoopback && isLoopbackOAuthUrl(currentUrl);
        // Before the chain's character is known (hop 0) the caller's
        // permission stands, so a plaintext hostname that resolves privately
        // is dialled rather than refused on the strength of how it reads.
        const hopAllowsPrivate = chainAllowsPrivate;
        assertSchemeAllowed(currentUrl, chainAllowsLoopback, hopAllowsPrivate);

        result = await executeOAuthProxy({
          url: currentUrl,
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          // PER HOP. The transport derives `allowLoopbackFlow = !httpsOnly &&
          // isLoopbackOAuthUrl(url)` from whatever url it is handed — so
          // passing `false` unconditionally would refuse a loopback dev
          // chain's later hops, and passing "the flag said so" would let a
          // public https target redirect to `https://127.0.0.1` and have the
          // transport permit it because that HOP is loopback. The permission
          // is the CHAIN's (see `chainAllowsLoopback` above) re-checked
          // against the hop being dialled.
          httpsOnly: !hopAllowsLoopback && !hopAllowsPrivate,
          allowPrivateNetwork: hopAllowsPrivate,
          redirect: "manual",
          timeoutMs: remainingTimeout(options.timeoutMs, startedAt),
          signal,
        });

        // Fix the chain's character from the hop that actually dialled. After
        // this, a chain that landed public may not redirect onto the caller's
        // private network, and one that landed private may keep going there.
        if (!chainCharacterKnown) {
          chainAllowsPrivate = chainAllowsPrivate && result.targetIsPrivate;
          chainCharacterKnown = true;
        }

        const location = result.headers["location"] ?? result.headers["Location"];
        if (!isRedirectStatus(result.status) || !location) break;

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error("The server returned an invalid redirect location.");
        }

        // Fetch's method rewrite, and it has to be Fetch's EXACTLY — the same
        // condition the transport applies at `updateRequestForRedirect`
        // (`sdk/src/oauth-proxy.ts`), because these hops and the transport's own
        // are meant to be the same walk split across a package boundary.
        //
        // 301/302 rewrite POST and nothing else: a PUT, PATCH or DELETE keeps
        // its method, which is what the spec says and what `undici` does. 303
        // rewrites every method EXCEPT GET and HEAD, so a HEAD probe stays a
        // HEAD rather than quietly acquiring a response body. Widening either
        // arm sends a different request than a direct `fetch` would have.
        // 307/308 rewrite nothing.
        //
        // Only a POST carries a body through here at all — the transport's
        // `encodeRequestBody` returns undefined for every other method — so the
        // body clearing below is reached exactly when there is a body to clear.
        if (
          ((result.status === 301 || result.status === 302) &&
            currentMethod === "POST") ||
          (result.status === 303 &&
            currentMethod !== "GET" &&
            currentMethod !== "HEAD")
        ) {
          currentMethod = "GET";
          currentBody = undefined;
          currentHeaders = withoutBodyHeaders(currentHeaders);
        }

        // Match Fetch's credential boundary, which the transport applies within
        // a single call and cannot apply across these separate ones.
        currentHeaders = sameOrigin(currentUrl, nextUrl.toString())
          ? currentHeaders
          : withoutCredentials(currentHeaders);
        currentUrl = nextUrl.toString();
      }

      return new Response(toBodyInit(result.status, result.body), {
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
      // `classifyPinnedTransportError` is shared with the streaming transport
      // below so the two cannot disagree about what a refusal is. It never
      // repeats the address a hostname RESOLVED to — that would make a refusal
      // into a resolution oracle — and it leaves a genuine transport failure
      // (timeout, byte cap, redirect ceiling) a plain retryable `Error`.
      throw classifyPinnedTransportError(error, url);
    }
  };

  return pinnedFetch as typeof fetch;
}

/**
 * The streaming sibling of {@link createPinnedFetch}.
 *
 * `createPinnedFetch` is built on `executeOAuthProxy`, which BUFFERS the whole
 * response — fine for an OAuth metadata document, impossible for
 * `text/event-stream`. So it could never be the fetch an MCP transport dials
 * through, and the conformance suites were left guarding their raw probes with
 * `createGuardedFetch` (which resolves twice, leaving a TOCTOU window) while
 * the one real MCP connection each run opens followed redirects with no guard
 * at all.
 *
 * `createPinnedStreamingFetch` closes both halves: same resolve-once,
 * classify, pin-into-the-socket walk, re-run on every redirect hop, with the
 * body handed back as a live stream. This wrapper adds the one thing the SDK
 * cannot know about — the inspector's error taxonomy, which decides `terminal`
 * vs `retryable` and must not let an SSRF refusal be mistaken for a timeout.
 *
 * OUTSIDE HOSTED MODE THIS IS A NO-OP by default. Locally, reaching
 * `http://127.0.0.1:3000/mcp` is the entire product; the guard is an egress
 * decision that only exists on our nodes.
 */
export function createStreamingPinnedFetch(
  options: PinnedFetchOptions & {
    /** Defaults to `HOSTED_MODE`; pass explicitly in tests. */
    hosted?: boolean;
    /** Bounds DNS, connect and headers across the whole redirect chain. */
    chainTimeoutMs?: number;
    /** Kills a body stream that has stalled. SSE-safe; a total deadline is not. */
    bodyIdleTimeoutMs?: number;
    /** Cumulative decompressed body cap for one request. */
    maxResponseBytes?: number;
    /** Redirect hops allowed before the chain is refused. Defaults to fetch parity. */
    maxRedirects?: number;
    /** Names the target in refusal messages, e.g. `"MCP server"`. */
    targetLabel?: string;
  } = {}
): typeof fetch {
  const hosted = options.hosted ?? HOSTED_MODE;
  if (!hosted) {
    return ((...args: Parameters<typeof fetch>) =>
      fetch(...args)) as typeof fetch;
  }

  const streamingFetch = createPinnedStreamingFetch({
    allowLoopback: options.allowLoopback,
    chainTimeoutMs: options.chainTimeoutMs ?? options.timeoutMs,
    bodyIdleTimeoutMs: options.bodyIdleTimeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    maxRedirects: options.maxRedirects,
    targetLabel: options.targetLabel,
  });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    try {
      return await streamingFetch(input as never, init as never);
    } catch (error) {
      throw classifyPinnedTransportError(error, url);
    }
  }) as typeof fetch;
}

/**
 * Map a transport rejection onto the inspector's taxonomy.
 *
 * Shared with {@link createPinnedFetch} so the two transports cannot disagree
 * about what a refusal is — the discrimination is by message because
 * `OAuthProxyError` carries only a `status`, and that status is 400 for both
 * "resolves to a private or reserved IP address" (a verdict about the target)
 * and "request timeout" (an outage on our side).
 */
function classifyPinnedTransportError(error: unknown, url: string): unknown {
  if (!(error instanceof OAuthProxyError)) return error;
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(error.message))) {
    // The address it RESOLVED to never appears in the message: that would make
    // a refusal into a resolution oracle. The host they typed is theirs
    // already; the answer our resolver saw is not.
    return new BlockedEgressTargetError(
      `Refusing to connect to "${safeHost(url)}": it is not a publicly routable address.`,
      { cause: error }
    );
  }
  if (TERMINAL_REQUEST_PATTERNS.some((pattern) => pattern.test(error.message))) {
    // Terminal like the refusals above, but the transport already said what is
    // wrong and it is not the address, so its message is the honest one.
    return new BlockedEgressTargetError(error.message, { cause: error });
  }
  if (RESOLUTION_FAILURE_PATTERN.test(error.message)) {
    return new EgressResolutionError(error.message);
  }
  return new Error(error.message);
}
