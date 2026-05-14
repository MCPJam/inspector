/**
 * Chat-history prefetch + in-flight dedup.
 *
 * Switching sessions is two sequential network calls (detail REST + signed-URL
 * blob fetch). We warm both on hover so the click path hits cached promises:
 *   - `prefetchChatHistorySession` fires from the rail's onPointerEnter
 *   - `getCachedChatHistoryDetail` and `getCachedBlobJson` are the dedup'd
 *     wrappers consumed by the click path (`handleSelectThread` and
 *     `loadChatSession` respectively)
 *
 * Cache strategy: keep entries for 30 s. On error we evict immediately so the
 * next call retries. The post-stream reconcile path uses raw `getChatHistoryDetail`
 * (it must see the freshest version), so this cache won't serve stale data
 * back into that flow.
 */
import {
  getChatHistoryDetail,
  type ChatHistoryDetailResponse,
} from "@/lib/apis/web/chat-history-api";

const TTL_MS = 30_000;

interface CacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

const detailCache = new Map<string, CacheEntry<ChatHistoryDetailResponse>>();
const blobCache = new Map<string, CacheEntry<unknown>>();

function pruneExpired<T>(cache: Map<string, CacheEntry<T>>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
}

function detailKey(params: {
  sessionId?: string;
  chatSessionId: string;
  projectId?: string;
}): string {
  return [params.sessionId ?? "", params.chatSessionId, params.projectId ?? ""].join(
    "|",
  );
}

export function getCachedChatHistoryDetail(params: {
  sessionId?: string;
  chatSessionId: string;
  projectId?: string;
}): Promise<ChatHistoryDetailResponse> {
  pruneExpired(detailCache);
  const key = detailKey(params);
  const hit = detailCache.get(key);
  if (hit) return hit.promise;

  const promise = getChatHistoryDetail(params);
  detailCache.set(key, { promise, expiresAt: Date.now() + TTL_MS });
  promise.catch(() => detailCache.delete(key));
  return promise;
}

export function getCachedBlobJson(url: string): Promise<unknown> {
  pruneExpired(blobCache);
  const hit = blobCache.get(url);
  if (hit) return hit.promise;

  const promise = fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch chat transcript (${response.status})`);
    }
    return response.json();
  });
  blobCache.set(url, { promise, expiresAt: Date.now() + TTL_MS });
  promise.catch(() => blobCache.delete(url));
  return promise;
}

/**
 * Warm the detail + blob caches for an upcoming select. Safe to call repeatedly
 * (in-flight dedup); errors are swallowed because the click path will retry
 * and surface them.
 */
export function prefetchChatHistorySession(params: {
  sessionId?: string;
  chatSessionId: string;
  projectId?: string;
}): void {
  getCachedChatHistoryDetail(params)
    .then((detail) => {
      if (detail.session.messagesBlobUrl) {
        void getCachedBlobJson(detail.session.messagesBlobUrl).catch(() => {
          /* warmed cache will be evicted on error; click path will retry */
        });
      }
    })
    .catch(() => {
      /* swallow — click will surface the real error */
    });
}

/** Evict everything. Use sparingly (e.g., on auth flip). */
export function invalidateChatHistoryPrefetch(): void {
  detailCache.clear();
  blobCache.clear();
}
