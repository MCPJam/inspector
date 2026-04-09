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
