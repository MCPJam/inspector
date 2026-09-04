/**
 * Localhost Check Utility
 *
 * Validates Host header to ensure tokens are only served to localhost requests.
 * Protects against DNS rebinding attacks where a malicious domain resolves to
 * 127.0.0.1 - the browser sends the malicious domain as the Host header, which
 * this check rejects.
 *
 * Security model:
 * - Native: Server binds to 127.0.0.1 (network attacks impossible)
 * - Docker: Server binds to 0.0.0.0, but users MUST use -p 127.0.0.1:6274:6274
 * - Host header check blocks DNS rebinding in both cases
 */

/**
 * Check if the request is from localhost based on Host header.
 *
 * Supports:
 * - localhost (with/without port)
 * - 127.0.0.1 (IPv4 loopback, with/without port)
 * - [::1] (IPv6 loopback, with/without port)
 *
 * @param hostHeader - The Host header value from the request
 * @returns true if the request is from localhost, false otherwise
 */
/**
 * Whether a configured base URL is reachable from a CLOUD sandbox (i.e. truly
 * public). Rejects every non-routable host, not just loopback — a private
 * `BASE_URL` like `http://192.168.x.x` must NOT be treated as direct-reachable.
 * Used by the hosted harness URL strategy to choose direct vs relay.
 */
export function isPubliclyReachableUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local")) return false;
  // Unwrap IPv6 brackets.
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  if (h === "0.0.0.0") return false;
  if (h.includes(":")) {
    // IPv6 literal (a hostname like "fc.example.com" must NOT hit these).
    if (h === "::1" || h === "::") return false;
    // Unique-local fc00::/7 (fc/fd), link-local fe80::/10, and deprecated
    // site-local fec0::/10 — none are globally routable. Link-local + site-local
    // together are the whole fe80::/9 (first hextet 0xfe80–0xfeff, e.g. fe90::,
    // feaf::, fec0::), so match the full range, not just literal "fe80:".
    const firstHextet = parseInt(h.split(":")[0] || "", 16);
    if (
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      (firstHextet >= 0xfe80 && firstHextet <= 0xfeff)
    ) {
      return false; // unique-local / link-local / site-local
    }
    // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4. `new URL`
    // normalizes the dotted tail to hex (`::ffff:c0a8:101`), so decode both
    // forms; anything else under ::ffff: fails closed.
    if (h.startsWith("::ffff:")) {
      const tail = h.slice("::ffff:".length);
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) {
        return isRoutableIpv4(tail);
      }
      const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return isRoutableIpv4(
          `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
        );
      }
      return false;
    }
    return true;
  }
  return isRoutableIpv4(h);
}

/** Non-routable IPv4 literal filter; non-IPv4 hostnames pass through as routable. */
function isRoutableIpv4(h: string): boolean {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (a === 0 || a === 127) return false; // this-host / loopback
    if (a === 10) return false; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return false; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
    if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    // Documentation / protocol-assignment ranges (not routable on the internet).
    if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 TEST-NET-1
    if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 TEST-NET-3
  }
  return true;
}

export function isLocalhostRequest(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }

  // Normalize to lowercase for comparison
  const host = hostHeader.toLowerCase();

  // Check for localhost variants (with or without port)
  // IPv4: localhost, 127.0.0.1
  // IPv6: [::1] (brackets required in Host header for IPv6)
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("[::1]:")
  );
}

/**
 * Tunnel host suffixes. Matching is suffix-based so any tunnel subdomain
 * (e.g. "x7d9j2m1p9k3.tunnels.mcpjam.com") is covered. The retired ngrok
 * suffixes stay as defense-in-depth for stragglers with live ngrok
 * listeners from older versions.
 */
const TUNNEL_HOST_SUFFIXES = [
  ".tunnels.mcpjam.com",
  ".ngrok.app",
  ".ngrok.dev",
  ".ngrok-free.app",
  ".ngrok-free.dev",
  ".ngrok.io",
];

/**
 * Check whether the Host header belongs to a tunnel (relay) domain.
 *
 * SECURITY INVARIANT: the session token must NEVER be served or injected
 * for a tunnel host — tunnels expose the MCP adapter surface to the public
 * internet, and the bearer secret in the tunnel URL is the only credential
 * remote clients are meant to hold. This check is enforced independently of
 * `isAllowedHost` so a future config that allowlists a tunnel domain cannot
 * silently start leaking the session token through the tunnel.
 *
 * COMMA-SEPARATED VALUES. This is called on `X-Forwarded-Host` as well as
 * `Host`, and a forwarded header accumulates one entry per hop: an inner proxy
 * writes `abc123.tunnels.mcpjam.com`, a second appends its own, and the two
 * arrive as `localhost:6274, abc123.tunnels.mcpjam.com` (or as repeated headers
 * that the runtime joins the same way). Reading only up to the first colon
 * would take `localhost` from that and answer "not a tunnel" — which is the
 * leak this whole check exists to prevent. Every entry is tested, and ANY of
 * them being a tunnel vetoes: a request that touched a tunnel anywhere on its
 * path is a tunnel request.
 *
 * @param hostHeader - A `Host` or `X-Forwarded-Host` value. The original tunnel
 *   host survives forwarding via `X-Forwarded-Host`, which the relay edge
 *   injects; callers should check both headers.
 * @param extraTunnelHosts - Exact additional tunnel hostnames to treat as
 *   tunnels (e.g. the domains of currently active listeners).
 */
export function isTunnelHost(
  hostHeader: string | undefined,
  extraTunnelHosts: string[] = []
): boolean {
  if (!hostHeader) {
    return false;
  }
  const extras = extraTunnelHosts.map((tunnel) => tunnel.toLowerCase());
  return hostHeader
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim().split(":")[0])
    .filter((host) => host.length > 0)
    .some(
      (host) =>
        TUNNEL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
        extras.includes(host)
    );
}

/**
 * Single decision point for serving/injecting the session token.
 *
 * Tunnel hosts are denied BEFORE the allowlist is consulted, so even a
 * misconfiguration that adds a tunnel domain to MCPJAM_ALLOWED_HOSTS can
 * never leak the session token through a tunnel.
 */
export function mayServeSessionToken(options: {
  host: string | undefined;
  forwardedHost?: string | undefined;
  allowedHosts: string[];
  activeTunnelDomains?: string[];
}): boolean {
  const tunnelDomains = options.activeTunnelDomains ?? [];
  if (
    isTunnelHost(options.host, tunnelDomains) ||
    isTunnelHost(options.forwardedHost, tunnelDomains)
  ) {
    return false;
  }
  return isAllowedHost(options.host, options.allowedHosts);
}

/**
 * Decision point for injecting the guest bootstrap bearer into the SPA
 * document.
 *
 * Like `mayServeSessionToken`, the guest bearer is a credential and must
 * never be injected for a tunnel/relay `Host`/`X-Forwarded-Host` — tunnels
 * are denied BEFORE the allowlist is consulted so a misconfiguration that
 * adds a tunnel domain to MCPJAM_ALLOWED_HOSTS cannot leak the bearer.
 *
 * UNLIKE the session token (localhost-only), the guest bearer is meant to be
 * served to the hosted app host(s) (e.g. `app.mcpjam.com`). It therefore
 * shares the `isAllowedHost` allowlist, which honors `MCPJAM_ALLOWED_HOSTS`.
 *
 * NOTE: `isAllowedHost` no longer gates that allowlist on hosted mode (see its
 * doc), so this function alone would also return true for an allowlisted
 * self-hosted LAN host. Guest-bootstrap injection stays hosted-only because
 * every call site pre-checks `process.env.NODE_ENV === "production" &&
 * HOSTED_MODE` before calling this. That gate lives at the call sites, not
 * here — do not drop it on the assumption this function owns the hosted rule.
 */
export function mayServeGuestBootstrap(options: {
  host: string | undefined;
  forwardedHost?: string | undefined;
  allowedHosts: string[];
  activeTunnelDomains?: string[];
}): boolean {
  const tunnelDomains = options.activeTunnelDomains ?? [];
  if (
    isTunnelHost(options.host, tunnelDomains) ||
    isTunnelHost(options.forwardedHost, tunnelDomains)
  ) {
    return false;
  }
  return isAllowedHost(options.host, options.allowedHosts);
}

/**
 * Check if the request is from an allowed host.
 *
 * Localhost is always allowed. Beyond that, `MCPJAM_ALLOWED_HOSTS`
 * (`allowedHosts`) is an explicit, admin-controlled opt-in that names the
 * exact hosts permitted to receive the token — in BOTH hosted and self-hosted
 * deployments:
 * - Hosted (cloud, e.g. Railway): the deployment sets it to its canonical app
 *   host(s) so `app.mcpjam.com` can receive the token/guest bearer.
 * - Self-hosted (npx/Docker on a remote box, accessed over the LAN via a raw
 *   IP like `192.168.x.x:6274`): the operator sets it to their own host so the
 *   inspector is reachable off-localhost. Without this opt-in the token is
 *   localhost-only and network access dead-ends on an auth error.
 *
 * The allowlist is deliberately NOT gated on `hostedMode`: withholding it in
 * self-hosted mode gave those operators no supported way to reach the
 * inspector over the network, which is the whole point of self-hosting on a
 * remote box. This does not weaken DNS-rebinding protection — the match is
 * against the exact `Host` the operator configured, so a malicious domain that
 * resolves to the same IP still fails the check (its `Host` isn't allowlisted).
 * The tunnel veto in `mayServeSessionToken`/`mayServeGuestBootstrap` runs
 * BEFORE this, so a tunnel host can never be allowlisted into a token leak.
 *
 * @param hostHeader - The Host header value from the request
 * @param allowedHosts - List of additional allowed hosts (from config)
 * @returns true if the request is from an allowed host, false otherwise
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: string[]
): boolean {
  // Always allow localhost
  if (isLocalhostRequest(hostHeader)) {
    return true;
  }

  // Explicit admin opt-in via MCPJAM_ALLOWED_HOSTS (both hosted + self-hosted).
  if (hostHeader && allowedHosts.length > 0) {
    const host = hostHeader.toLowerCase();
    return hostnameMatchesAllowlist(stripPort(host), allowedHosts);
  }

  return false;
}

/**
 * Strip the port from a Host/authority value while keeping an IPv6 literal's
 * brackets intact: `192.168.1.50:6274` → `192.168.1.50`, and
 * `[fd00::50]:6274` → `[fd00::50]`. A naive `split(":")[0]` would turn the
 * IPv6 form into `[fd00`, so an allowlisted IPv6 host could never match.
 */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(0, close + 1);
  }
  return host.split(":")[0];
}

/**
 * Does a lowercased, port-stripped hostname match one of the admin-configured
 * `MCPJAM_ALLOWED_HOSTS` entries? Exact match, or a `*.domain` subdomain match.
 *
 * This is the ALLOWLIST half of `isAllowedHost` on its own — it deliberately
 * does NOT include the localhost auto-allow. The origin-validation gate reuses
 * it so both gates agree on the configured allowlist (a host allowlisted for
 * token delivery is also accepted as a request Origin), while origin validation
 * keeps its own exact-origin rule for localhost (specific scheme + port).
 */
export function hostnameMatchesAllowlist(
  hostnameWithoutPort: string,
  allowedHosts: string[]
): boolean {
  return allowedHosts.some((allowed) => {
    // Support exact match or subdomain matching (e.g., "*.railway.app")
    if (allowed.startsWith("*.")) {
      const domain = allowed.slice(2);
      return (
        hostnameWithoutPort === domain ||
        hostnameWithoutPort.endsWith(`.${domain}`)
      );
    }
    return hostnameWithoutPort === allowed;
  });
}
