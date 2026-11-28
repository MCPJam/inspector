import { MODERN_REVISION } from "./revision.js";

/** The `_meta` key 2026-07-28 uses for the responding server's name and version. */
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** Result fields only 2026-07-28 defines (`resultType`, and the caching utility's pair). */
const MODERN_ONLY_FIELDS = ["resultType", "ttlMs", "cacheScope"] as const;

/**
 * A result the real server sent, as a caller on `revision` should see it. The
 * mock reaches the real server on the newest revision both speak, so a result
 * it forwards can carry fields only 2026-07-28 defines; a real server a 2025
 * caller talks to directly sends none of them, so they are left off. 2026-07-28
 * results are returned as they are.
 */
export function forRevision<T>(result: T, revision: string): T {
  if (revision === MODERN_REVISION) return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const next: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of MODERN_ONLY_FIELDS) delete next[field];
  const meta = next._meta;
  if (typeof meta === "object" && meta !== null && SERVER_INFO_META_KEY in meta) {
    const rest: Record<string, unknown> = { ...meta };
    delete rest[SERVER_INFO_META_KEY];
    if (Object.keys(rest).length > 0) next._meta = rest;
    else delete next._meta;
  }
  return next as T;
}
