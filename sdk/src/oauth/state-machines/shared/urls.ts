export function buildResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.pathname !== "/" && url.pathname !== "") {
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return new URL(
      `/.well-known/oauth-protected-resource${pathname}`,
      url.origin,
    ).toString();
  }
  return new URL(
    "/.well-known/oauth-protected-resource",
    url.origin,
  ).toString();
}

// Mirrors the strict validation used by the non-debug OAuth paths
// (checkResourceAllowed in browser-auth.ts, and the official MCP SDK): the
// PRM-advertised resource must share the server URL's origin and be a path
// prefix of it. The debug flows honor the advertised value either way and
// only warn on mismatch, so users can still step through the real behavior
// while learning that spec-strict clients will refuse to connect.
export function resourceMatchesServerUrl(
  resource: string,
  serverUrl: string,
): boolean {
  try {
    const advertised = new URL(resource);
    const server = new URL(serverUrl);

    if (advertised.origin !== server.origin) {
      return false;
    }

    const serverPath = server.pathname.endsWith("/")
      ? server.pathname
      : `${server.pathname}/`;
    const advertisedPath = advertised.pathname.endsWith("/")
      ? advertised.pathname
      : `${advertised.pathname}/`;

    return serverPath.startsWith(advertisedPath);
  } catch {
    return false;
  }
}

export function canonicalizeResourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return url;
  }
}
