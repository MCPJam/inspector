/**
 * Turn a pasted MCP server URL into a stable, human-readable server name.
 *
 * The name is what `buildServerRequest` resolves against `serverIdsByName`, so
 * it has to be deterministic: pasting the same URL twice must find the same
 * row rather than pile up duplicates in the guest's project.
 */
/**
 * A short, collision-RESISTANT digest of the canonical URL.
 *
 * The readable slug is lossy on purpose (punctuation collapses, length is
 * bounded), and `createServerIfMissing` returns the EXISTING row for a name it
 * already has. So if two distinct URLs derive one name, the second scan
 * silently reuses the first row and the visitor gets a score for a server we
 * never dialed — labelled with the URL they pasted. That is the one failure
 * mode this page cannot have.
 *
 * SHA-256 rather than a cheap mixer: the input is user-supplied, and a short
 * non-cryptographic hash is craftable. Truncated to 96 bits — a birthday
 * search is ~2^48 work, which is out of reach for the payoff (mis-scoring a
 * server inside your own guest project). 48 bits would have left that search
 * at ~2^24, which is not a barrier at all.
 */
async function urlDigest(canonicalUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveScoreServerName(rawUrl: string): Promise<string> {
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

  const suffix = await urlDigest(canonical);
  // The slug is for humans; the suffix is what keeps two targets apart. The
  // readable part is budgeted so the whole name still fits 64 characters
  // (24 hex chars of digest + separator).
  return slug
    ? `${slug.slice(0, 39).replace(/-+$/, "")}-${suffix}`
    : `mcp-server-${suffix}`;
}
