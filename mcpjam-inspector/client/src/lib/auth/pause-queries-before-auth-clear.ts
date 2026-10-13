import { flushSync } from "react-dom";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

/**
 * Remove the readiness-gated subscriptions BEFORE Convex loses its identity.
 *
 * The server re-runs every live subscription the moment the socket's identity
 * goes away, with no identity, and each gated query then fails with the
 * backend's `unauthenticated` refusal. A render cannot skip them in time; the
 * gate has to be committed synchronously, while the socket still carries the
 * old identity. Two things clear it:
 *
 *   - Convex itself, when the token fetcher returns null (`unified-convex-auth`).
 *   - `ConvexProviderWithAuth`, on the render where the signed-in user goes
 *     away: every sign-out path, which is why each one calls this right after
 *     the sign-out latch.
 *
 * Call it from async code or an event handler. Inside a render or an effect
 * `flushSync` cannot flush and the pause would land after the clear.
 */
export function pauseQueriesBeforeAuthClear(): null {
  flushSync(() => useSessionRefreshStore.getState().pauseQueries());
  return null;
}
