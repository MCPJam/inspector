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

const cache = new Map<string, CacheEntry>();

/** Nothing disabled. Shared so the common case allocates nothing. */
const EMPTY: ReadonlySet<string> = new Set<string>();

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
}

async function fetchAndCache(
  organizationId: string
): Promise<ReadonlySet<string>> {
  const policy = await getOrgAgentPolicy(organizationId);
  const disabled: ReadonlySet<string> = new Set(policy.disabledOperations);
  cache.set(organizationId, {
    disabled,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  evictIfNeeded();
  return disabled;
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

  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.disabled;

  try {
    return await fetchAndCache(organizationId);
  } catch (error) {
    if (isRouteMissing(error)) {
      // Cache the empty answer too: an old backend will keep 404ing, and
      // re-asking on every turn buys nothing.
      const disabled = EMPTY;
      cache.set(organizationId, {
        disabled,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      evictIfNeeded();
      return disabled;
    }
    logger.warn("[org-agent-policy] could not read the org's agent policy", {
      error: error instanceof Error ? error.message : String(error),
      served_stale: Boolean(cached),
    });
    // STALE-THEN-EMPTY. A stale policy is the org's own most recent decision;
    // an empty one is the pre-feature behaviour. Neither can widen the surface
    // beyond what the registry already offers.
    return cached?.disabled ?? EMPTY;
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
    if (isRouteMissing(error)) return EMPTY;
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
