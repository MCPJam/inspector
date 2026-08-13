/**
 * Summarize what metadata discovery probed, for the error thrown when none of
 * the candidates served usable metadata.
 */
export function describeMetadataProbes(probes: string[]): string {
  if (probes.length === 0) {
    return "No candidate metadata endpoints were derived from the authorization server URL.";
  }
  return `Probed ${probes.length} endpoint(s): ${probes.join("; ")}`;
}

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
