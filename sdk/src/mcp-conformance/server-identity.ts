/**
 * Where a 2026-07-28 server says who it is, and what the spec asks about it.
 *
 * "Servers SHOULD include the following `io.modelcontextprotocol/*` field in
 * every result's `_meta`, unless specifically configured not to do so, to
 * identify themselves" (2026-07-28 basic/index.mdx:397-403). The table under
 * that sentence marks `io.modelcontextprotocol/serverInfo` as not required,
 * and the schema types it optional (`schema.ts:157`).
 *
 * So a server that leaves it out breaks no MUST. It can be advised, not
 * failed. One that sends it malformed is a different matter: `Implementation`
 * requires `name` and `version`, and Server Discover grades that.
 */

/** The `_meta` key a 2026-07-28 result carries the server's identity under. */
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/**
 * The identity a result carries, or `undefined` when it carries none.
 *
 * `DiscoverResult` has no `serverInfo` member: the identity is stamped into
 * `_meta` on every result (spec PR #3002). The top-level read is kept as a
 * lenient fallback: a server that also mirrors it there is not wrong.
 */
export function readServerIdentity(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const meta = payload._meta as Record<string, unknown> | undefined;
  const stamped = meta?.[SERVER_INFO_META_KEY];
  if (stamped !== null && typeof stamped === "object") {
    return stamped as Record<string, unknown>;
  }
  const topLevel = payload.serverInfo;
  return topLevel !== null && typeof topLevel === "object"
    ? (topLevel as Record<string, unknown>)
    : undefined;
}

/** Whether an identity has the two members `Implementation` requires. */
export function isWellFormedIdentity(
  identity: Record<string, unknown>
): boolean {
  return (
    typeof identity.name === "string" && typeof identity.version === "string"
  );
}
