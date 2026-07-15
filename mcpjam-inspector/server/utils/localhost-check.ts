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
  if (h === "::1" || h === "0.0.0.0" || h === "::") return false;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return false; // IPv6 link-local / unique-local
  }
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
 * @param hostHeader - The Host header value from the request (the original
 *   tunnel host survives forwarding via the X-Forwarded-Host header the
 *   relay edge injects; callers should check both).
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
  const host = hostHeader.toLowerCase().split(":")[0];
  if (TUNNEL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  return extraTunnelHosts.some((tunnel) => tunnel.toLowerCase() === host);
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
  hostedMode: boolean;
  activeTunnelDomains?: string[];
}): boolean {
  const tunnelDomains = options.activeTunnelDomains ?? [];
  if (
    isTunnelHost(options.host, tunnelDomains) ||
    isTunnelHost(options.forwardedHost, tunnelDomains)
  ) {
    return false;
  }
  return isAllowedHost(options.host, options.allowedHosts, options.hostedMode);
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
 * shares the `isAllowedHost` allowlist — in hosted mode that includes the
 * configured `MCPJAM_ALLOWED_HOSTS`, which the hosted deployment sets to its
 * canonical app host(s).
 */
export function mayServeGuestBootstrap(options: {
  host: string | undefined;
  forwardedHost?: string | undefined;
  allowedHosts: string[];
  hostedMode: boolean;
  activeTunnelDomains?: string[];
}): boolean {
  const tunnelDomains = options.activeTunnelDomains ?? [];
  if (
    isTunnelHost(options.host, tunnelDomains) ||
    isTunnelHost(options.forwardedHost, tunnelDomains)
  ) {
    return false;
  }
  return isAllowedHost(options.host, options.allowedHosts, options.hostedMode);
}

/**
 * Check if the request is from an allowed host.
 *
 * In hosted mode (cloud deployments), this allows both localhost and
 * configured allowed hosts (MCPJAM_ALLOWED_HOSTS) to receive tokens.
 * This enables deployment to platforms like Railway while maintaining
 * security by only allowing explicitly configured hosts.
 *
 * @param hostHeader - The Host header value from the request
 * @param allowedHosts - List of additional allowed hosts (from config)
 * @param hostedMode - Whether hosted mode is enabled
 * @returns true if the request is from an allowed host, false otherwise
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: string[],
  hostedMode: boolean
): boolean {
  // Always allow localhost
  if (isLocalhostRequest(hostHeader)) {
    return true;
  }

  // In hosted mode, check configured allowed hosts
  if (hostedMode && hostHeader && allowedHosts.length > 0) {
    const host = hostHeader.toLowerCase();
    // Extract hostname without port for comparison
    const hostWithoutPort = host.split(":")[0];

    return allowedHosts.some((allowed) => {
      // Support exact match or subdomain matching (e.g., "*.railway.app")
      if (allowed.startsWith("*.")) {
        const domain = allowed.slice(2);
        return (
          hostWithoutPort === domain || hostWithoutPort.endsWith(`.${domain}`)
        );
      }
      return hostWithoutPort === allowed;
    });
  }

  return false;
}
