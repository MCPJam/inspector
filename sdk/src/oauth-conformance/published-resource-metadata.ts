import {
  type NormalizedOAuthConformanceConfig,
  type TrackedRequestFn,
} from "./types.js";

/**
 * Whether the server publishes Protected Resource Metadata at a well-known
 * path, and where.
 *
 * Asked only after an unauthenticated `initialize` SUCCEEDED, and only on the
 * server's own origin: the path-suffixed form first, then the root, which is
 * the order a client discovering without a challenge pointer tries them.
 */
export async function findPublishedResourceMetadata(
  config: NormalizedOAuthConformanceConfig,
  trackedRequest: TrackedRequestFn,
): Promise<string | undefined> {
  let candidates: string[];
  try {
    const base = new URL(config.serverUrl);
    const path = base.pathname.replace(/\/$/, "");
    candidates = [
      `${base.origin}/.well-known/oauth-protected-resource${path}`,
      `${base.origin}/.well-known/oauth-protected-resource`,
    ];
  } catch {
    return undefined;
  }
  for (const url of [...new Set(candidates)]) {
    try {
      const response = await trackedRequest({
        method: "GET",
        url,
        headers: { Accept: "application/json" },
      });
      if (
        response.status >= 200 &&
        response.status < 300 &&
        typeof response.body === "object" &&
        response.body !== null &&
        !Array.isArray(response.body)
      ) {
        return url;
      }
    } catch {
      // A metadata path that cannot be read is the same, for this question,
      // as one that is not there.
    }
  }
  return undefined;
}
