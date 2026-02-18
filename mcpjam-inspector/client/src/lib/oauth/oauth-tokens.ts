/**
 * Builds a map of server IDs to OAuth access tokens.
 *
 * @param serverNames  - Names of the servers to include
 * @param resolveServerId - Resolves a server name to its hosted server ID (or undefined)
 * @param getAccessToken  - Returns the OAuth access token for a server name (or undefined)
 * @returns A record mapping server IDs to access tokens, or undefined if no tokens exist
 */
export function buildOAuthTokensByServerId(
  serverNames: Iterable<string>,
  resolveServerId: (name: string) => string | undefined,
  getAccessToken: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const name of serverNames) {
    const serverId = resolveServerId(name);
    const token = getAccessToken(name);
    if (serverId && token) {
      map[serverId] = token;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}
