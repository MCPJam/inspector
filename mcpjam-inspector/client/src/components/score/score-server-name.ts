/**
 * Turn a pasted MCP server URL into a stable, human-readable server name.
 *
 * The name is what `buildServerRequest` resolves against `serverIdsByName`, so
 * it has to be deterministic: pasting the same URL twice must find the same
 * row rather than pile up duplicates in the guest's project.
 */
/**
 * A short, stable digest of the canonical URL.
 *
 * The readable slug is lossy on purpose (punctuation collapses, length is
 * bounded), and `createServerIfMissing` returns the EXISTING row for a name it
 * already has. Without a digest, `https://mcp.example.com:8443/mcp` and
 * `https://mcp.example.com/mcp` derive the same name, the second scan silently
 * reuses the first row, and the visitor gets a score for a server we never
 * dialed — labelled with the URL they pasted. That is the one failure mode
 * this whole page cannot have.
 */
function urlDigest(canonicalUrl: string): string {
  let hash = 0;
  for (const char of canonicalUrl) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function deriveScoreServerName(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let host = "";
  let path = "";
  let canonical = trimmed;
  try {
    const parsed = new URL(trimmed);
    host = parsed.hostname.replace(/^www\./, "");
    // The port is part of a server's identity even though it never reads like
    // part of its name.
    if (parsed.port) host = `${host}-${parsed.port}`;
    path = parsed.pathname.replace(/\/+$/, "");
    // Scheme and search included: two endpoints differing only there are two
    // servers, and only the digest can still tell them apart.
    canonical = `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    host = trimmed;
  }

  // `/mcp` and `/sse` are near-universal endpoint suffixes and say nothing
  // about WHICH server this is, so they earn no room in the label. Any other
  // path does distinguish two servers on one host, and is kept.
  const meaningfulPath =
    path && !/^\/(mcp|sse)$/i.test(path) ? path.replace(/\//g, "-") : "";

  // Alphanumeric + hyphen only, matching the `slugifyName` convention the
  // product already uses when it creates server rows.
  const slug = `${host}${meaningfulPath}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = urlDigest(canonical);
  // The slug is for humans; the suffix is what keeps two targets apart.
  return slug
    ? `${slug.slice(0, 56).replace(/-+$/, "")}-${suffix}`
    : `mcp-server-${suffix}`;
}
