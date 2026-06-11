/**
 * Registry of currently active tunnel domains and the serverId each is
 * bound to. Written by the tunnel manager on listen/close; read by the
 * HTTP adapter (per-server isolation guard, request logging) and the
 * session-token paths (tunnel-host leak invariant).
 *
 * Lives apart from tunnel-manager so consumers don't transitively load
 * the native @ngrok/ngrok module just to ask "did this request arrive
 * through a tunnel?".
 */

// domain (lowercase hostname) → bound serverId, or null for the legacy
// shared whole-app tunnel which has no per-server binding.
const activeDomains = new Map<string, string | null>();

function normalizeHost(host: string): string {
  return host.toLowerCase().split(":")[0];
}

export function registerTunnelDomain(
  domain: string,
  boundServerId: string | null
): void {
  activeDomains.set(normalizeHost(domain), boundServerId);
}

export function unregisterTunnelDomain(domain: string): void {
  activeDomains.delete(normalizeHost(domain));
}

/** Domains of all currently active listeners (for tunnel-host checks). */
export function getActiveTunnelDomains(): string[] {
  return [...activeDomains.keys()];
}

export function isActiveTunnelDomain(host: string | undefined): boolean {
  if (!host) return false;
  return activeDomains.has(normalizeHost(host));
}

/**
 * The serverId a per-server tunnel domain is bound to; null for unknown
 * domains and for the legacy shared tunnel.
 */
export function getServerIdForTunnelDomain(
  host: string | undefined
): string | null {
  if (!host) return null;
  return activeDomains.get(normalizeHost(host)) ?? null;
}
