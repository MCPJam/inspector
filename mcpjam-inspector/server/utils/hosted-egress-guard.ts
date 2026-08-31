/**
 * The one place that decides whether the hosted inspector is allowed to dial a
 * URL a caller handed it.
 *
 * Hosted, the inspector's backend sits on a shared cloud network, so any route
 * that takes a target URL from a request is an SSRF primitive: point it at
 * `http://169.254.169.254/` and the response is IAM credentials. Locally
 * (CLI/desktop) the exact opposite is true — dialing `http://localhost:3000/mcp`
 * IS the product — so every check here is gated on `HOSTED_MODE` and the
 * host-tier distinction `isBlockedEgressHost` already draws:
 *
 *   - Always blocked: cloud-metadata addresses and their DNS aliases,
 *     link-local, and the unspecified address. Never a legitimate target
 *     anywhere, in any mode.
 *   - Blocked only when hosted: loopback, `.localhost`, RFC-1918, CGNAT, and
 *     IPv6 ULA.
 *
 * Validating the URL a caller NAMED is not enough on its own, because a caller
 * does not have to name the address they want reached — they can name a host
 * they control and have it answer `302 Location: http://169.254.169.254/`. So
 * `createGuardedFetch` re-checks every hop; a guard that only inspects the first
 * URL is a guard against typos, not against an attacker.
 *
 * Two things this guard deliberately does NOT do:
 *
 *   - It judges the TARGET URL, never an outgoing `Host` header. The protocol
 *     conformance suite sends rebinding-style Host headers on purpose (the
 *     `localhost-host-rebinding-rejected` checks are how it grades a server's
 *     own defenses); treating those as egress would break the suite it is
 *     meant to protect.
 *   - It does not close the check-vs-connect (TOCTOU) rebinding window: the
 *     DNS answer is validated, then the HTTP client resolves again. Narrowing
 *     that requires pinning the connection to the vetted IP, which belongs to
 *     infra-level egress policy — the same punt documented on the harness
 *     guard.
 */

import { promises as dns } from "node:dns";
import { HOSTED_MODE } from "../config.js";

/** Parse a dotted-quad IPv4 literal into octets, or null if not well-formed. */
function parseIpv4Octets(
  host: string
): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return [o[0], o[1], o[2], o[3]];
}

/**
 * Is this hostname one the hosted inspector must refuse?
 *
 *   - ALWAYS blocked: cloud-metadata names, IPv4/IPv6 link-local (169.254/16,
 *     fe80::/10), and the unspecified address (0.0.0.0/8, ::) — never a
 *     legitimate target in any deployment.
 *   - Blocked only when `blockPrivate` (hosted mode): loopback, RFC-1918
 *     private, CGNAT (100.64/10), and IPv6 ULA (fc00::/7). Left reachable for
 *     local dev, where the inspector legitimately talks to a localhost MCP
 *     server and a widget legitimately renders against one.
 *
 * Matches on a literal hostname only; `assertAllowedHostedTargetUrl` is what
 * adds the DNS-resolution pass on top.
 *
 * Two callers share this: the browser harness's egress route (a widget's
 * declared CSP origins must not reach infrastructure only the harness HOST can
 * see — most dangerously 169.254.169.254, whose IAM credentials would be a
 * full account compromise) and the hosted conformance routes.
 */
export function isBlockedEgressHost(
  hostname: string,
  blockPrivate: boolean
): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // A terminal dot is the same NAME to a resolver ("localhost." resolves to
  // loopback), but it is a different STRING to every comparison below — so
  // strip it before judging, or `http://metadata.google.internal./` walks past
  // the alias check.
  host = host.replace(/\.+$/, "");
  if (!host) return true;

  // Cloud metadata DNS aliases (they resolve to link-local, but block the
  // names too in case resolution is bypassed).
  if (host === "metadata.google.internal" || host === "metadata.goog") {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return blockPrivate;

  const v4 = parseIpv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true; // "this network" / unspecified
    if (!blockPrivate) return false;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }

  if (host.includes(":")) {
    // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — judge the embedded v4.
    const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    if (mapped) return isBlockedEgressHost(mapped[1], blockPrivate);
    // The SAME address in hex. `new URL()` rewrites the dotted spelling into
    // this one (`[::ffff:169.254.169.254]` → `[::ffff:a9fe:a9fe]`), so a check
    // that only knew the dotted form let the metadata endpoint through the
    // moment the host came from a parsed URL rather than a raw string.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return isBlockedEgressHost(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
          low & 0xff
        }`,
        blockPrivate
      );
    }
    if (host === "::") return true; // unspecified
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (!blockPrivate) return false;
    if (host === "::1") return true; // loopback
    if (/^f[cd]/.test(host)) return true; // ULA fc00::/7
    return false;
  }

  return false;
}

/**
 * Raised when a target is refused. Distinct from a transport failure so
 * callers can map it to a 400 (you asked for something we won't dial) rather
 * than a 502 (we tried and it didn't work).
 */
export class BlockedEgressTargetError extends Error {
  /**
   * THE MESSAGE IS USER-VISIBLE. It is reported back to whoever submitted the
   * URL, so it may name the host they asked for and must never name what that
   * host resolved to — otherwise a refusal becomes a resolution oracle for
   * mapping the internal network. Diagnostic detail belongs on `cause`, which
   * reaches logs and nothing else.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlockedEgressTargetError";
  }
}

/**
 * We could not REACH a verdict — DNS itself failed. Distinct from
 * `BlockedEgressTargetError`, which is a verdict, because the two deserve
 * opposite answers: a blocked target is the caller's problem and permanent
 * (4xx), while a resolver outage is ours and worth retrying (5xx). Collapsing
 * them would tell a user their server is forbidden when our DNS hiccuped.
 */
export class EgressResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressResolutionError";
  }
}

/**
 * Resolve a hostname to IP strings. Injectable so tests can exercise the
 * rebinding path without a network, and so hosted-route tests that use
 * fabricated hostnames (`example.test`) can supply an answer instead of
 * tripping the unresolvable-host branch.
 */
export type EgressHostResolver = (hostname: string) => Promise<string[]>;

/** Codes that mean "this name has no such record" — a fact, not an outage. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function isNoRecordError(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && NO_RECORD_CODES.has(code);
}

export const defaultEgressHostResolver: EgressHostResolver = async (
  hostname
) => {
  const resolved: string[] = [];
  // Both families are asked independently: a host with an A record and no
  // AAAA (or vice versa) is ordinary, and one NXDOMAIN must not hide the
  // other family's answer.
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  if (v4.status === "fulfilled") resolved.push(...v4.value);
  if (v6.status === "fulfilled") resolved.push(...v6.value);
  if (resolved.length > 0) return resolved;

  // Nothing came back. Distinguish "no such name" (a verdict — fail closed as
  // unresolvable) from "the resolver broke" (an outage). Swallowing both would
  // make the EgressResolutionError path unreachable and turn every SERVFAIL
  // into a permanent 400 telling the user their server is forbidden.
  const failures = [v4, v6].filter(
    (settled): settled is PromiseRejectedResult => settled.status === "rejected"
  );
  const transient = failures.filter(
    (settled) => !isNoRecordError(settled.reason)
  );
  // ANY transient failure, not only an all-transient one. A mixed result —
  // v4 says ENODATA, v6 says SERVFAIL — means we never learned whether an
  // AAAA exists, so "unresolvable" would be a claim we cannot make. Only when
  // EVERY failure is a no-record answer do we actually know the name has
  // nothing, and can fail closed on that fact.
  if (transient.length > 0) {
    const reason = transient[0].reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
  return resolved;
};

function isIpLiteral(host: string): boolean {
  // The hex form REQUIRES a colon. Without that, a single-label hostname made
  // of hex characters — `deadbeef`, `cafe`, `f00d` — reads as an IPv6 literal,
  // is judged "not a blocked address", and then skips the DNS pass entirely.
  // That is exactly the rebinding case the DNS pass exists to catch, handed a
  // free pass by a regex. Every real IPv6 literal contains a colon; numeric
  // hosts are normalized to dotted-quad by `new URL()` and caught above.
  return (
    /^[\d.]+$/.test(host) || (host.includes(":") && /^[0-9a-f:]+$/i.test(host))
  );
}

/**
 * The resolver used when a caller passes none. Overridable so route-level
 * tests can exercise the real guard against fabricated hostnames (the hosted
 * conformance tests use `example.test`, which no real resolver will answer)
 * instead of stubbing the guard out and testing nothing.
 */
let activeResolver: EgressHostResolver = defaultEgressHostResolver;

export function setEgressHostResolverForTests(
  resolver: EgressHostResolver | null
): void {
  activeResolver = resolver ?? defaultEgressHostResolver;
}

/**
 * Throw unless the hosted inspector may dial `rawUrl`.
 *
 * No-op outside hosted mode. `label` names the field in the error so a user
 * who pasted a bad URL learns WHICH url was refused — a run failure that says
 * only "blocked" is indistinguishable from a bug in our runner.
 */
export async function assertAllowedHostedTargetUrl(
  rawUrl: string,
  label: string,
  options: { resolver?: EgressHostResolver; hosted?: boolean } = {}
): Promise<void> {
  const hosted = options.hosted ?? HOSTED_MODE;
  if (!hosted) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedEgressTargetError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedEgressTargetError(
      `${label} must be an http(s) URL (got "${parsed.protocol}")`
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedEgressHost(host, true)) {
    throw new BlockedEgressTargetError(
      `${label} points at a private or internal address ("${host}") that the hosted inspector will not dial. Run this server locally in the inspector instead.`
    );
  }
  // An IP literal has already been judged on its own terms; resolving it would
  // only ask DNS to repeat the number back.
  if (isIpLiteral(host)) return;

  const resolver = options.resolver ?? activeResolver;
  let resolvedIps: string[];
  try {
    resolvedIps = await resolver(host);
  } catch (error) {
    // A resolver that throws is infrastructure trouble, not a verdict about
    // the target — so it gets its own type, and the route answers 5xx rather
    // than telling the user their server is forbidden because our DNS blipped.
    throw new EgressResolutionError(
      `Could not check "${host}" for a safe address: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (resolvedIps.length === 0) {
    // Fail closed. Unresolvable means we cannot prove the target is external,
    // and "we couldn't look it up" is a more useful thing to tell a user than
    // a connection error thirty seconds later.
    throw new BlockedEgressTargetError(
      `${label} hostname "${host}" could not be resolved, so it cannot be checked for a safe address.`
    );
  }
  for (const ip of resolvedIps) {
    if (isBlockedEgressHost(ip, true)) {
      // The ADDRESS goes on `cause`, not in the message. The message is
      // reported back to whoever supplied the hostname, and naming what it
      // resolved to turns a refusal into a resolution oracle: submit a name,
      // read back what our resolver saw, repeat until the internal network is
      // mapped. The host they typed is theirs already; the answer is not.
      throw new BlockedEgressTargetError(
        `${label} hostname "${host}" resolves to a private or internal address that the hosted inspector will not dial.`,
        { cause: new Error(`resolved address: ${ip}`) }
      );
    }
  }
}

/**
 * The redirect ceiling. Matches what `fetch` itself allows, so a legitimate
 * chain that worked before this guard existed still works.
 */
const MAX_GUARDED_REDIRECTS = 20;

/**
 * A `fetch` that re-checks the target on every hop.
 *
 * Checking only the URL a caller named guards against a typo, not against an
 * attacker: naming `https://redirector.example/` and having it answer
 * `302 Location: http://169.254.169.254/latest/meta-data/iam/` reaches exactly
 * the address the check was written to refuse, and the caller never had to say
 * so. Following redirects by hand is what turns one check into a check per
 * address actually dialed.
 *
 * Redirect semantics follow the Fetch standard rather than being invented here:
 * 303 always becomes GET, 301 and 302 become GET from POST (what every real
 * client does), 307 and 308 preserve method and body. A caller that asked for
 * `redirect: "manual"` gets its 3xx back untouched — the OAuth suite inspects
 * redirects as evidence, and following one on its behalf would destroy the very
 * thing it is grading.
 *
 * Outside hosted mode this returns the underlying fetch unchanged: locally the
 * inspector is supposed to reach localhost, and a redirect chain on a
 * developer's laptop is not an egress decision.
 */
export function createGuardedFetch(
  options: { resolver?: EgressHostResolver; hosted?: boolean; baseFetch?: typeof fetch } = {}
): typeof fetch {
  const hosted = options.hosted ?? HOSTED_MODE;
  const baseFetch = options.baseFetch ?? fetch;
  if (!hosted) return baseFetch;

  const guardedFetch: typeof fetch = async (input, init) => {
    // A `Request` carries its own method, headers and body. Reading only its
    // `url` and dropping the rest would silently turn an authenticated POST
    // into an anonymous GET — a request the caller never made, whose response
    // we would then report as the target's behavior.
    const fromRequest =
      typeof input !== "string" && !(input instanceof URL) ? input : undefined;
    if (fromRequest?.body && init?.body === undefined) {
      // A `Request` body is a one-shot stream. Copying every other field and
      // leaving it behind would send an empty POST and report whatever the
      // server made of THAT as the target's behavior — a wrong answer dressed
      // as a real one. Refusing is the honest option; callers that need a body
      // can pass it through `init`, which is replayable.
      throw new BlockedEgressTargetError(
        "A Request with a body cannot be dialed through the egress guard; pass the body via the init argument so it can be replayed across a redirect."
      );
    }
    let currentUrl = fromRequest
      ? fromRequest.url
      : typeof input === "string"
        ? input
        : input.toString();
    let currentInit: RequestInit = fromRequest
      ? {
          method: fromRequest.method,
          headers: new Headers(fromRequest.headers),
          redirect: fromRequest.redirect,
          signal: fromRequest.signal,
          ...(init ?? {}),
        }
      : { ...(init ?? {}) };

    // A caller that wants the 3xx itself gets one request and one check.
    const wantsManual = currentInit.redirect === "manual";
    // `"error"` means "a redirect is a failure" — honoring it is not optional,
    // and treating it as "follow" would silently do the one thing the caller
    // ruled out.
    const rejectsRedirect = currentInit.redirect === "error";

    for (let hop = 0; hop <= MAX_GUARDED_REDIRECTS; hop++) {
      await assertAllowedHostedTargetUrl(currentUrl, "Request URL", {
        resolver: options.resolver,
        hosted: true,
      });

      const response = await baseFetch(currentUrl, {
        ...currentInit,
        // Always manual under the hood: the point is to see each Location
        // before anything is dialed. Auto-follow would hand the decision to the
        // HTTP client, which is where the hole was.
        redirect: "manual",
      });

      const isRedirect =
        response.status >= 300 &&
        response.status <= 399 &&
        response.headers.has("location");
      if (wantsManual || !isRedirect) {
        return response;
      }
      if (rejectsRedirect) {
        throw new BlockedEgressTargetError(
          `The request refused redirects (redirect: "error") but "${currentUrl}" answered ${response.status}.`
        );
      }

      const location = response.headers.get("location") as string;
      // Relative Locations are the common case and must resolve against the hop
      // that produced them, not the original request.
      const nextUrl = new URL(location, currentUrl).toString();

      // CREDENTIALS DO NOT FOLLOW A REDIRECT ACROSS ORIGINS.
      //
      // Replaying the original headers on every hop hands the target's own
      // `Authorization` — the access token a conformance run was given, or the
      // bearer a user configured — to whatever host the redirect names. A
      // server under test can therefore harvest its own caller's credentials by
      // answering `302 Location: https://attacker.example/`. `fetch` strips
      // these on a cross-origin redirect for exactly this reason, and following
      // redirects by hand means inheriting that duty rather than the default.
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        const headers = new Headers(
          (currentInit.headers as HeadersInit | undefined) ?? {}
        );
        for (const name of [
          "authorization",
          "proxy-authorization",
          "cookie",
          "www-authenticate",
        ]) {
          headers.delete(name);
        }
        currentInit = { ...currentInit, headers };
      }

      const method = (currentInit.method ?? "GET").toUpperCase();
      // Per the Fetch standard: 303 rewrites to GET, and 301/302 rewrite POST
      // to GET. HEAD is exempt from both — it stays HEAD, because a caller that
      // asked for headers only must not be handed a body.
      const rewritesToGet =
        method !== "HEAD" &&
        (response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            method === "POST"));
      if (rewritesToGet) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
        // A body-shaped content type on a bodiless GET confuses servers and is
        // no longer true of the request being sent.
        if (currentInit.headers) {
          const headers = new Headers(currentInit.headers as HeadersInit);
          headers.delete("content-type");
          headers.delete("content-length");
          currentInit.headers = headers;
        }
      } else if (
        currentInit.body !== undefined &&
        currentInit.body !== null &&
        typeof currentInit.body !== "string"
      ) {
        // 307/308 replay the body, and a stream cannot be replayed. Better to
        // say so than to silently send an empty body and report whatever the
        // server makes of it as the target's behavior.
        throw new BlockedEgressTargetError(
          `Redirect to "${nextUrl}" would need the request body replayed, which is not possible for a streamed body.`
        );
      }

      currentUrl = nextUrl;
    }

    throw new BlockedEgressTargetError(
      `Too many redirects (more than ${MAX_GUARDED_REDIRECTS}) starting from the request URL.`
    );
  };

  return guardedFetch;
}
