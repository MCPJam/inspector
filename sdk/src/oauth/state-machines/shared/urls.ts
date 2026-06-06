export function buildResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.pathname !== "/" && url.pathname !== "") {
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return new URL(
      `/.well-known/oauth-protected-resource${pathname}`,
      url.origin
    ).toString();
  }
  return new URL(
    "/.well-known/oauth-protected-resource",
    url.origin
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

function stripFragment(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function normalizePathForPrefix(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isOAuthResourceIndicatorAllowed(input: {
  serverUrl: string;
  resource: string;
}): boolean {
  try {
    const requested = new URL(input.serverUrl);
    const configured = new URL(input.resource);

    if (requested.origin !== configured.origin) {
      return false;
    }

    if (configured.search && configured.search !== requested.search) {
      return false;
    }

    const requestedPath = normalizePathForPrefix(requested.pathname);
    const configuredPath = normalizePathForPrefix(configured.pathname);

    if (configuredPath === "/") {
      return true;
    }

    return (
      requestedPath === configuredPath ||
      requestedPath.startsWith(`${configuredPath}/`)
    );
  } catch {
    return false;
  }
}

export function resolveOAuthResourceIndicator(
  serverUrl: string | undefined,
  resourceMetadata?: { resource?: string }
): string | undefined {
  if (!serverUrl) {
    return undefined;
  }

  const fallback = canonicalizeResourceUrl(serverUrl);
  const advertisedResource = resourceMetadata?.resource?.trim();
  if (!advertisedResource) {
    return fallback;
  }

  const resource = stripFragment(advertisedResource);
  if (
    !resource ||
    !isOAuthResourceIndicatorAllowed({
      serverUrl,
      resource,
    })
  ) {
    return fallback;
  }

  return resource;
}
