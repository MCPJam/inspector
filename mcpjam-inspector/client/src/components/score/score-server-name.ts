/**
 * Turn a pasted MCP server URL into a stable, human-readable server name.
 *
 * The name is what `buildServerRequest` resolves against `serverIdsByName`, so
 * it has to be deterministic: pasting the same URL twice must find the same
 * row rather than pile up duplicates in the guest's project.
 */
export function deriveScoreServerName(rawUrl: string): string {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(rawUrl.trim());
    host = parsed.hostname.replace(/^www\./, "");
    path = parsed.pathname.replace(/\/+$/, "");
  } catch {
    host = rawUrl.trim();
  }

  // `/mcp` and `/sse` are near-universal endpoint suffixes and say nothing
  // about WHICH server this is, so they earn no room in the label. Any other
  // path does distinguish two servers on one host, and is kept.
  const meaningfulPath =
    path && !/^\/(mcp|sse)$/i.test(path) ? path.replace(/\//g, "-") : "";

  const slug = `${host}${meaningfulPath}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return slug ? slug.slice(0, 64) : "mcp-server";
}
