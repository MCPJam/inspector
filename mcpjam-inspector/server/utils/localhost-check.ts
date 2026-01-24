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
  hostedMode: boolean,
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
