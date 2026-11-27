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

/** The raw identity stamp, including malformed values. */
export function readServerIdentityStamp(
  payload: Record<string, unknown>
): unknown {
  const meta = payload._meta;
  if (
    meta === null ||
    typeof meta !== "object" ||
    !(SERVER_INFO_META_KEY in meta)
  ) {
    return undefined;
  }
  return meta[SERVER_INFO_META_KEY];
}

/**
 * The discovery identity, with a top-level object as a fallback when the
 * stamp is absent.
 */
export function readServerIdentity(
  payload: Record<string, unknown>
): unknown {
  const stamped = readServerIdentityStamp(payload);
  if (stamped !== undefined) {
    return stamped;
  }
  const topLevel = payload.serverInfo;
  return topLevel !== null && typeof topLevel === "object" ? topLevel : undefined;
}

/** Whether an identity has the two members `Implementation` requires. */
export function isWellFormedIdentity(identity: unknown): boolean {
  return (
    identity !== null &&
    typeof identity === "object" &&
    "name" in identity &&
    typeof identity.name === "string" &&
    "version" in identity &&
    typeof identity.version === "string"
  );
}
