/**
 * The ONE rule for turning a backend id into a path segment.
 *
 * Three places compose filesystem paths out of the same ids — the verified
 * bundle cache (`bundle-cache.ts`), the writable data directory
 * (`plugin-data.ts`), and the in-box layout for hosted execution
 * (`computer-stdio.ts`) — and all three are refusing the same thing: a segment
 * that could steer a path somewhere its caller did not intend. A
 * security-relevant predicate copied per call site is one that drifts per call
 * site, and the local and remote paths disagreeing about what "safe" means is
 * exactly the bug worth designing out.
 *
 * The accepted set is `[A-Za-z0-9_-]`, which is what Convex ids and hex bundle
 * hashes actually are. It deliberately does NOT accept `.`: the two dot-allowing
 * copies this replaced had to special-case `"."` and `".."` to stay safe, and a
 * rule with no exceptions is easier to keep true than a rule with two. Nothing
 * real regresses — `bundle-cache.ts` already documented its accepted set as
 * `[A-Za-z0-9_-]`, so the dot was slack no caller relied on.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isSafePathSegment(value: string): boolean {
  return SAFE_PATH_SEGMENT.test(value);
}

/**
 * Throw unless every segment is safe. `label` names the id in the message, so a
 * failure says which one was rejected instead of only what it contained.
 *
 * `makeError` lets each caller keep its own error type (the cache raises a
 * `PluginBundleCacheError` its callers already branch on) without duplicating
 * the rule itself.
 */
export function assertSafePathSegments(
  segments: Record<string, string>,
  makeError: (message: string) => Error = (message) => new Error(message)
): void {
  for (const [label, value] of Object.entries(segments)) {
    if (!isSafePathSegment(value)) {
      throw makeError(`Refusing to build a path from an unsafe ${label}: "${value}"`);
    }
  }
}
