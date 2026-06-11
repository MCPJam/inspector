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
 * ngrok-controlled host suffixes. Matching is suffix-based so any reserved
 * subdomain (e.g. "x7d9j2m1p9k3.ngrok.app") is covered.
 */
const TUNNEL_HOST_SUFFIXES = [
  ".ngrok.app",
  ".ngrok.dev",
  ".ngrok-free.app",
  ".ngrok-free.dev",
  ".ngrok.io",
];

/**
 * Check whether the Host header belongs to a tunnel (ngrok) domain.
 *
 * SECURITY INVARIANT: the session token must NEVER be served or injected
 * for a tunnel host — tunnels expose the MCP adapter surface to the public
 * internet, and the bearer secret in the tunnel URL is the only credential
 * remote clients are meant to hold. This check is enforced independently of
 * `isAllowedHost` so a future config that allowlists an ngrok domain cannot
 * silently start leaking the session token through the tunnel.
 *
 * @param hostHeader - The Host header value from the request (the original
 *   ngrok host survives forwarding via the X-Forwarded-Host header the
 *   tunnel listener injects; callers should check both).
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
 * misconfiguration that adds an ngrok domain to MCPJAM_ALLOWED_HOSTS can
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
