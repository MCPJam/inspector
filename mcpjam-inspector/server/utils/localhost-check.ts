/**
 * Localhost Check Utility
 *
 * Provides Host header validation to ensure tokens are only served to localhost requests.
 * This is CRITICAL for security when binding to 0.0.0.0 (Docker mode).
 *
 * How it works:
 * - Docker port mapping preserves the original Host header from the browser
 * - User accessing http://localhost:6274 -> Host: localhost:6274 -> Token served
 * - Attacker accessing http://192.168.1.100:6274 -> Host: 192.168.1.100:6274 -> No token
 *
 * This prevents token leakage to network attackers even when the server is bound to 0.0.0.0.
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
