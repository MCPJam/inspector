/**
 * Module-level LRU for pinned-skill runtime artifacts (Project Environments —
 * B2). Pinned bodies are content-addressed by `(projectId, contentHash)`, so a
 * cached entry can be shared across targets AND runs within this process.
 *
 * Contract:
 *   - key `${projectId}:${contentHash}`; max {@link PINNED_SKILL_CACHE_MAX}
 *     entries (LRU eviction), {@link PINNED_SKILL_CACHE_TTL_MS} TTL.
 *   - in-flight fetches for the same key COALESCE onto one promise (two
 *     same-project targets pinning the same skill fetch once).
 *   - failures are NEVER cached: a rejected fetch clears the in-flight slot so
 *     the next caller retries fresh.
 *   - transient failures (network / 5xx) retry twice ({@link RETRY_DELAYS_MS});
 *     a 404 or an integrity (hash) mismatch is NEVER retried — the snapshot is
 *     immutable, so those can only recur.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import {
  PinnedSkillIntegrityError,
  SwarmAgentError,
} from "../swarm-agent.js";

export const PINNED_SKILL_CACHE_MAX = 256;
export const PINNED_SKILL_CACHE_TTL_MS = 15 * 60 * 1000;
const RETRY_DELAYS_MS = [250, 1000];

interface CacheEntry {
  artifact: PinnedSkillArtifact;
  expiresAt: number;
}

// Map iteration order is insertion order; re-inserting on read makes the first
// key the least-recently-used — the classic Map-as-LRU.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PinnedSkillArtifact>>();

/** Default retry policy: transient transport errors and 5xx retry; a 404, an
 * integrity mismatch, or an abort never do. */
export function isRetryablePinnedSkillError(err: unknown): boolean {
  if (err instanceof PinnedSkillIntegrityError) return false;
  if (err instanceof SwarmAgentError) return err.status >= 500;
  if (err instanceof Error && err.name === "AbortError") return false;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  // Undici/fetch transport failures (TypeError), timeouts, etc.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  fetcher: () => Promise<PinnedSkillArtifact>,
  retryDelaysMs: readonly number[]
): Promise<PinnedSkillArtifact> {
  let attempt = 0;
  // attempts = 1 initial + retryDelaysMs.length retries
  for (;;) {
    try {
      return await fetcher();
    } catch (err) {
      if (attempt >= retryDelaysMs.length || !isRetryablePinnedSkillError(err)) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]!);
      attempt++;
    }
  }
}

/**
 * Resolve one pinned skill body through the cache. `fetcher` performs the
 * actual authorized fetch (the runner binds `fetchPinnedSkill` with its run
 * context); it is invoked at most once per coalesced burst and retried per the
 * policy above. `retryDelaysMs` is injectable for tests only.
 */
export async function resolvePinnedSkillCached(args: {
  projectId: string;
  contentHash: string;
  fetcher: () => Promise<PinnedSkillArtifact>;
  retryDelaysMs?: readonly number[];
}): Promise<PinnedSkillArtifact> {
  const key = `${args.projectId}:${args.contentHash}`;

  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // LRU touch.
      cache.delete(key);
      cache.set(key, cached);
      return cached.artifact;
    }
    cache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetchWithRetry(
    args.fetcher,
    args.retryDelaysMs ?? RETRY_DELAYS_MS
  )
    .then((artifact) => {
      cache.set(key, {
        artifact,
        expiresAt: Date.now() + PINNED_SKILL_CACHE_TTL_MS,
      });
      while (cache.size > PINNED_SKILL_CACHE_MAX) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return artifact;
    })
    .finally(() => {
      // Success OR failure: clear the in-flight slot. Failures were not cached
      // above, so the next caller starts a fresh fetch.
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: reset module state between cases. */
export function __clearPinnedSkillCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}

/** Test-only: current cached-entry count. */
export function __pinnedSkillCacheSizeForTest(): number {
  return cache.size;
}
