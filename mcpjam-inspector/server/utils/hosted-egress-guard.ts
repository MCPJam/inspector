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
  if (!host) return false;

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
  constructor(message: string) {
    super(message);
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
      throw new BlockedEgressTargetError(
        `${label} hostname "${host}" resolves to a private or internal address (${ip}) that the hosted inspector will not dial.`
      );
    }
  }
}
