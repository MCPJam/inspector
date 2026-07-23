/**
 * Browser-safe SSRF guard for outbound OAuth metadata fetches (P1, shared
 * hardening pass). The OAuth state machines hand a URL — `resource_metadata`
 * from a WWW-Authenticate challenge, an authorization-server metadata endpoint,
 * a CIMD document — to their request executor. Without a destination check, an
 * attacker-influenced value (a hostile MCP server's PRM pointer, a redirect)
 * can steer that fetch at a private/reserved address: cloud metadata
 * (169.254.169.254), link-local, or a LAN service.
 *
 * This module holds the pure RFC 6890 special-use IP classifier (moved here
 * from `oauth-proxy.ts`, which stays Node-only for DNS) so it can run in the
 * browser executor path too, plus `assertOutboundOAuthUrlAllowed` and a
 * request-executor wrapper the factory applies to every machine at once.
 *
 * Scope of the browser-safe check: URL scheme + IP-literal classification and
 * an explicit loopback opt-in. DNS-resolution (rebinding) validation needs a
 * resolver and remains in the Node proxy path (`resolveAndValidateDns`); a bare
 * public hostname passes here and is resolved+revalidated there.
 */

import { isLoopbackHost } from "./state-machines/shared/client-id-metadata.js";

function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((o) => parseInt(o, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // malformed → reject
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // 224/4 multicast
  if (a >= 240) return true; // 240/4 reserved (incl. 255.255.255.255)
  return false;
}

/** Expand any IPv6 text form to exactly 8 hextets, folding a trailing dotted
 * IPv4 tail into two hextets. Returns null for anything unparseable. */
function ipv6ToHextets(input: string): number[] | null {
  let s = input.trim().toLowerCase().split("%")[0];
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // Fold a trailing dotted IPv4 (…::a.b.c.d, incl. ::ffff:a.b.c.d) to hextets.
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map((x) =>
      parseInt(x, 10),
    );
    if (o.some((n) => n < 0 || n > 255)) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${(
      (o[2] << 8) |
      o[3]
    ).toString(16)}`;
  }
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const halves = s.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    return [...left, ...Array(missing).fill(0), ...right];
  }
  const only = parseGroups(s);
  return only && only.length === 8 ? only : null;
}

function isDisallowedEmbeddedIpv4(h6: number, h7: number): boolean {
  return isDisallowedIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
}

function isDisallowedIpv6(input: string): boolean {
  const h = ipv6ToHextets(input);
  if (!h) return true; // unparseable → reject
  const topZero = h.slice(0, 6).every((x) => x === 0);
  if (topZero && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: , ::1
  const b0 = h[0] >> 8;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (b0 === 0xff) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 docs
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64
  // NAT64 (RFC 6052 well-known 64:ff9b::/96, RFC 8215 local-use 64:ff9b:1::/48):
  // a translator can carry an embedded IPv4 into private space. Refuse the
  // local-use /48 outright, and refuse the well-known /96 when its embedded
  // IPv4 (low 32 bits) is disallowed (a public embedded IPv4 stays allowed).
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    if (h[2] === 0x0001) return true; // 64:ff9b:1::/48 local-use
    return isDisallowedEmbeddedIpv4(h[6], h[7]);
  }
  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96): the
  // embedded IPv4 decides — this closes the ::ffff:7f00:1 hex-literal bypass.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    if (h[5] === 0xffff || h[5] === 0)
      return isDisallowedEmbeddedIpv4(h[6], h[7]);
  }
  return false;
}

/**
 * RFC 6890 special-use / non-public-unicast check for a numeric IP (IPv4, IPv6,
 * or IPv4-mapped IPv6 in any text form). Returns true for addresses an outbound
 * SSRF-sensitive fetch must refuse. A bare hostname (not an IP literal) returns
 * false — the caller resolves it first.
 */
export function isDisallowedIpAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return isDisallowedIpv4(addr);
  if (addr.includes(":")) return isDisallowedIpv6(addr);
  return false;
}

/**
 * True for a hostname an SSRF-sensitive fetch must refuse: the loopback names
 * plus any special-use IP literal. A bare public hostname returns false (its
 * DNS resolution is validated separately in the Node proxy path).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isDisallowedIpAddress(host);
}

/**
 * True for an IPv4-mapped/compatible IPv6 literal whose embedded address is
 * loopback (127.0.0.0/8), e.g. `::ffff:127.0.0.1` or `::ffff:7f00:1`. Used so
 * the loopback opt-in treats a mapped-loopback host consistently with a plain
 * `127.0.0.1`/`::1`; mapped LAN/link-local addresses stay blocked via
 * `isPrivateHost`.
 */
function isMappedLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const dotted = h.match(/^::(?:ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  if (dotted) return parseInt(dotted[1], 10) === 127;
  const hex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (hex) return parseInt(hex[1], 16) >> 8 === 127;
  return false;
}

/** Thrown when an outbound OAuth metadata fetch targets a blocked host. */
export class OAuthOutboundUrlBlockedError extends Error {
  readonly url: string;
  readonly reason: "invalid-url" | "invalid-scheme" | "private-host";
  constructor(
    url: string,
    reason: "invalid-url" | "invalid-scheme" | "private-host",
    message: string,
  ) {
    super(message);
    this.name = "OAuthOutboundUrlBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Refuse an outbound OAuth metadata fetch to a private/reserved destination
 * before it runs. `allowLoopback` (local-dev opt-in) carves out loopback hosts
 * only — it never relaxes the guard for a LAN/link-local/reserved address.
 */
export function assertOutboundOAuthUrlAllowed(
  rawUrl: string,
  options: { allowLoopback?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OAuthOutboundUrlBlockedError(
      rawUrl,
      "invalid-url",
      "Outbound OAuth fetch URL is not a valid absolute URL",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OAuthOutboundUrlBlockedError(
      rawUrl,
      "invalid-scheme",
      `Outbound OAuth fetch must be http(s); got "${url.protocol}"`,
    );
  }

  const host = url.hostname;
  if (isLoopbackHost(host) || isMappedLoopbackHost(host)) {
    if (options.allowLoopback === true) {
      return url;
    }
    throw new OAuthOutboundUrlBlockedError(
      rawUrl,
      "private-host",
      `Refusing outbound OAuth fetch to loopback host "${host}" (no loopback opt-in)`,
    );
  }

  if (isPrivateHost(host)) {
    throw new OAuthOutboundUrlBlockedError(
      rawUrl,
      "private-host",
      `Refusing outbound OAuth fetch to private/reserved host "${host}"`,
    );
  }

  return url;
}
