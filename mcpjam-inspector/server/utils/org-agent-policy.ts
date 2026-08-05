/**
 * The org's agent capability policy, cached in-process.
 *
 * An org admin can switch individual agent operations OFF. That decision has
 * to be honoured at BOTH enforcement seams — tool assembly (so the model is
 * never offered a disabled tool) and the approved-action execute route (so a
 * button minted before the change cannot still spend) — which means the policy
 * is read on the hot path of every turn and every click. A round trip per turn
 * would put a Convex hop inside the Slack 3-second ack budget, so successful
 * reads are cached for 60 s. Sixty seconds is also the number the UI promises:
 * "changes take effect within a minute".
 *
 * FAILURE SEMANTICS DIFFER BY CALLER, deliberately, and this module gives the
 * callers what they need to choose:
 *
 *   - `getOrgAgentPolicyCached` FAILS OPEN — stale entry if we have one, empty
 *     set otherwise, plus a warning. Tool assembly runs on every turn, and a
 *     Convex blip that stripped every tool would turn a transient outage into
 *     an agent that cheerfully answers "I can't do that" for a minute. The
 *     policy is a tightening over an already-authorized surface, not the
 *     authorization itself: the project clamp, the delegated JWT and the
 *     proposal claim are what make a call safe, and none of them depend on
 *     this.
 *   - `getOrgAgentPolicyStrict` THROWS. The execute route uses it and fails
 *     closed, because there the alternative to "try again in a moment" is
 *     spending on a policy we could not read.
 *
 * A 404 is NOT a failure in either mode: it means the deployment predates the
 * `/slack/agent-policy/get` route, and "this backend has no policy" is a true
 * and complete answer. That is what lets this ship before the backend does.
 */
import {
  getOrgAgentPolicy,
  SlackBackendUnavailable,
} from "../services/slack-backend.js";
import { logger } from "./logger.js";

/** Matches `org-model-config.ts`: short enough that a change propagates fast. */
const CACHE_TTL_MS = 60_000;

/**
 * Hard bound on retained entries. One per org that has run a turn on this
 * process; a busy multi-tenant deployment must not accumulate them forever.
 */
const CACHE_MAX_ENTRIES = 1_000;

type CacheEntry = {
  disabled: ReadonlySet<string>;
  expiresAt: number;
};

/**
 * How long a FAILED read is remembered.
 *
 * Much shorter than the success TTL, because it is not an answer — it is a
 * decision to stop asking for a moment. Without it, an outage costs every turn
 * the backend client's full 10s timeout, which is the exact cost this cache
 * exists to avoid; with it, one turn pays and the next few are served the
 * fallback immediately.
 */
const FAILURE_BACKOFF_MS = 5_000;

/**
 * The longest tool assembly will WAIT for a policy before giving up on it.
 *
 * The backend client's own timeout is 10s, which is fine for a click but far
 * too long here: a Slack turn has a 3-second ack budget, so a cold cache during
 * an outage would blow it and earn a redelivery. Failing open at 2s keeps the
 * turn inside its budget — the fetch is left running so its result still warms
 * the cache for the next turn.
 *
 * The execute route does NOT use this: it is fail-closed and a person is
 * waiting on a click, so it can afford the full timeout.
 */
const FAIL_OPEN_DEADLINE_MS = 2_000;

const cache = new Map<string, CacheEntry>();

/**
 * Refreshes currently in flight, one per org.
 *
 * Two concurrent turns for the same org would otherwise each fetch, and the
 * SLOWER response would land last and win — so a policy that had just tightened
 * could be overwritten by an older read and stay loose for another minute.
 * Sharing one promise makes that race impossible and halves the round trips.
 */
const inflight = new Map<string, Promise<ReadonlySet<string>>>();

/** Nothing disabled. Shared so the common case allocates nothing. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Bumped by `clearOrgAgentPolicyCache`.
 *
 * Clearing the maps does not cancel a request already in flight, and that
 * request still holds a reference to `remember`. Without this counter, a case
 * that leaves a slow read outstanding writes ITS policy into the next case's
 * cache — the failure looks like a test that passes alone and fails in a suite.
 * Every write carries the generation it was issued under and is dropped if the
 * cache has been reset since.
 */
let cacheGeneration = 0;

/**
 * A timer that resolves to `fallback` after `ms`, so a slow fetch cannot hold
 * the turn. Cancellable: when the fetch wins the race, the timer is cleared so
 * `onExpire` never runs late.
 */
function deadlineFallback(
  ms: number,
  fallback: ReadonlySet<string>,
  onExpire: () => void
): { promise: Promise<ReadonlySet<string>>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<ReadonlySet<string>>((resolve) => {
    timer = setTimeout(() => {
      onExpire();
      resolve(fallback);
    }, ms);
    // Never keep the process alive for a fallback timer.
    timer.unref?.();
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function evictIfNeeded(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  // Insertion order — oldest write first.
  const excess = cache.size - CACHE_MAX_ENTRIES;
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= excess) break;
    cache.delete(key);
    dropped += 1;
  }
}

/** Test helper: drop everything so a case starts from a cold cache. */
export function clearOrgAgentPolicyCache(): void {
  cache.clear();
  inflight.clear();
  // Anything still in flight belongs to the generation being discarded and
  // must not land in the cache the next case reads.
  cacheGeneration += 1;
}

function remember(
  organizationId: string,
  disabled: ReadonlySet<string>,
  ttlMs: number,
  generation: number = cacheGeneration
): void {
  if (generation !== cacheGeneration) return;
  // Deleted first so the insertion order the eviction sweep walks reads as
  // recency: `Map.set` on an existing key keeps its original position, which
  // would evict a busy org ahead of one seen once and never again.
  cache.delete(organizationId);
  cache.set(organizationId, { disabled, expiresAt: Date.now() + ttlMs });
  evictIfNeeded();
}

/**
 * One fetch per org at a time. The shared promise is registered before the
 * await so a concurrent caller joins it rather than starting a second read.
 */
function fetchAndCache(organizationId: string): Promise<ReadonlySet<string>> {
  const existing = inflight.get(organizationId);
  if (existing) return existing;

  const generation = cacheGeneration;
  const pending = (async () => {
    const policy = await getOrgAgentPolicy(organizationId);
    const disabled: ReadonlySet<string> = new Set(policy.disabledOperations);
    remember(organizationId, disabled, CACHE_TTL_MS, generation);
    return disabled;
  })().finally(() => {
    inflight.delete(organizationId);
  });

  inflight.set(organizationId, pending);
  return pending;
}

/**
 * Was this an old deployment answering, rather than an outage?
 *
 * A 404 from the policy route means the backend does not serve it yet. 405 is
 * included because a router that knows the path but not the method is the same
 * class of version skew.
 */
function isRouteMissing(error: unknown): boolean {
  return (
    error instanceof SlackBackendUnavailable &&
    (error.status === 404 || error.status === 405)
  );
}

/**
 * The set of operation names this org has disabled — fail-open.
 *
 * Callers with no org (an `sk_` or JWT caller whose request never carried one)
 * get the empty set without a round trip: a policy is an ORG's decision, and
 * there is no org here to have made one.
 */
export async function getOrgAgentPolicyCached(
  organizationId: string | undefined | null
): Promise<ReadonlySet<string>> {
  if (!organizationId) return EMPTY;

  const generation = cacheGeneration;
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.disabled;

  // STALE-THEN-EMPTY, and it is the fallback for BOTH ways this can go wrong —
  // an error and a deadline. A policy we read a minute ago is the org's own
  // most recent decision; falling back to the empty set instead would RE-ENABLE
  // the operations they switched off, and at tool assembly that means the model
  // is handed a disabled DIRECT tool it can call without ever passing the
  // execute route's check. Empty is only for an org we have never read.
  const fallback = cached?.disabled ?? EMPTY;

  // The fetch is deliberately NOT awaited alone: whichever settles first wins,
  // and a slow backend loses to the deadline rather than to the turn's budget.
  // The fetch keeps running either way, so its answer still warms the cache.
  let settled = false;
  const fetch = fetchAndCache(organizationId)
    .catch((error: unknown) => {
      if (isRouteMissing(error)) {
        // An old backend will keep 404ing; remember it for the full TTL so this
        // stops costing a round trip per turn.
        remember(organizationId, EMPTY, CACHE_TTL_MS, generation);
        return EMPTY;
      }
      logger.warn("[org-agent-policy] could not read the org's agent policy", {
        error: error instanceof Error ? error.message : String(error),
        served_stale: Boolean(cached),
      });
      // Held only briefly, so a recovered backend is picked up within seconds.
      remember(organizationId, fallback, FAILURE_BACKOFF_MS, generation);
      return fallback;
    })
    .finally(() => {
      settled = true;
    });

  // A SLOW outage is not covered by the failure backoff above — that one is
  // only written when the request finally errors, and the backend client waits
  // 10s before it does. Five turns can arrive in that window, and each would
  // join the same in-flight promise and pay the 2s deadline again. Writing the
  // fallback the moment the deadline expires puts them on the cache path
  // instead; the real answer overwrites it whenever it lands.
  const deadline = deadlineFallback(FAIL_OPEN_DEADLINE_MS, fallback, () => {
    if (settled) return;
    logger.warn("[org-agent-policy] policy read exceeded its turn deadline", {
      served_stale: Boolean(cached),
    });
    remember(organizationId, fallback, FAILURE_BACKOFF_MS, generation);
  });

  try {
    return await Promise.race([fetch, deadline.promise]);
  } finally {
    // The fetch won; the timer must not fire later and write a stale entry
    // over the fresh one it just cached.
    deadline.cancel();
  }
}

/**
 * The same set, fail-closed.
 *
 * Throws when the policy could not be read at all, so the execute route can
 * answer "try again in a moment" instead of spending under a policy it does
 * not know. A cached entry — even an expired one — is still an answer the org
 * gave us, so the throw is reserved for the case where we have nothing.
 */
export async function getOrgAgentPolicyStrict(
  organizationId: string | undefined | null
): Promise<ReadonlySet<string>> {
  if (!organizationId) return EMPTY;

  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.disabled;

  try {
    return await fetchAndCache(organizationId);
  } catch (error) {
    if (isRouteMissing(error)) {
      // Cached for the same reason as the fail-open path: a backend that
      // predates the route will answer 404 for every click otherwise.
      remember(organizationId, EMPTY, CACHE_TTL_MS);
      return EMPTY;
    }
    if (cached) {
      logger.warn(
        "[org-agent-policy] serving a stale policy for an approved action",
        { error: error instanceof Error ? error.message : String(error) }
      );
      return cached.disabled;
    }
    throw error;
  }
}
