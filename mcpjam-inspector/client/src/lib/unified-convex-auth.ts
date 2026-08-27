import { useEffect, useMemo, useState } from "react";
import { useAuth as useWorkOSAuth } from "@workos-inc/authkit-react";
import { NON_PROD_LOCKDOWN } from "@/lib/config";
import { reportCaught } from "@/lib/error-reporting";
import {
  forceRefreshGuestSession,
  getCachedGuestSession,
  getOrCreateGuestSession,
  markGuestActivated,
} from "@/lib/guest-session";

/**
 * Stable hook fed to `<ConvexProviderWithAuthKit useAuth={...}>`.
 *
 * Returns the same shape as `@workos-inc/authkit-react`'s `useAuth`, but
 * substitutes a guest token + placeholder user when there is no signed-in
 * WorkOS user. This makes Convex authenticate guests through the same
 * provider chain as authed users — no separate `<GuestConvexAuthBridge>`,
 * no `client.setAuth` race, no guest-specific code paths in feature
 * surfaces.
 *
 * The Convex/workos adapter (`@convex-dev/workos`) only inspects `!!user`
 * to decide `isAuthenticated` and calls `getAccessToken()` to fetch the
 * bearer. `GUEST_USER_PLACEHOLDER` exists solely to satisfy that check
 * for guests; nothing reads its fields.
 */

const GUEST_USER_PLACEHOLDER = {
  __guest: true as const,
  id: "__guest__",
};

const GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS = [500, 1500, 3000] as const;

// Same ladder for token refresh. ~5s worst case, which fits inside the 60s
// `authRefreshTokenLeewaySeconds` configured in main.tsx — so a retried
// success still lands while the old token is valid.
const AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS = GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch an auth token, retrying transient failures on the same ladder the
 * guest bootstrap uses.
 *
 * Convex treats a single `null` from its token fetcher as terminal: it calls
 * `clearAuth()` and `setAndReportAuthFailed()`, dropping to the `noAuth`
 * state with NO retry and NO rescheduled refetch (see
 * `convex/browser/sync/authentication_manager.js`). Every live query then
 * re-runs identity-less and throws "Authentication required" in a burst,
 * and the tab stays de-authed until reload while the UI still looks signed
 * in. So one wifi blip or laptop wake during a scheduled refresh used to
 * kill the session permanently — the retry has to live HERE, because there
 * is no layer above us that will try again.
 *
 * `isTerminalError` marks failures where retrying is provably useless (a
 * WorkOS session that is genuinely dead); those return `null` immediately
 * and are not reported, since they are an expected sign-out rather than a
 * fault. Exhaustion IS reported — refresh failures were previously invisible
 * (console.error only), which is why the root cause went unmeasured.
 */
async function fetchTokenWithRetry(
  fetchOnce: () => Promise<string | null>,
  opts: {
    source: string;
    isTerminalError?: (error: unknown) => boolean;
  },
): Promise<string | null> {
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt <= AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      const token = await fetchOnce();
      if (token) return token;
      lastError = undefined;
    } catch (error) {
      if (opts.isTerminalError?.(error)) return null;
      lastError = error;
    }

    if (attempt === AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS.length) break;
    await delay(AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS[attempt]);
  }

  reportCaught(lastError ?? new Error(`${opts.source} returned no token`), {
    source: opts.source,
    level: "warning",
    extra: { attempts: AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS.length + 1 },
  });
  return null;
}

// Persist the "this browser used Convex as a guest" marker for the currently
// cached guest. No-op when no guestId is resolved (e.g. a bootstrap seed that
// carried no guestId — those are never seeded; see seedFromBootstrap).
function markActiveGuest(): void {
  const guestId = getCachedGuestSession()?.guestId;
  if (guestId) markGuestActivated(guestId);
}

export function useUnifiedConvexAuth() {
  const workos = useWorkOSAuth();
  const [guestToken, setGuestToken] = useState<string | null>(
    () => getCachedGuestSession()?.token ?? null,
  );
  const [guestLoading, setGuestLoading] = useState(
    () => getCachedGuestSession()?.token == null,
  );

  // Fetch a guest token whenever there is no signed-in WorkOS user. Reset
  // when a user does sign in so subsequent renders favor the WorkOS path.
  useEffect(() => {
    if (workos.isLoading) {
      return;
    }
    if (workos.user) {
      setGuestToken(null);
      setGuestLoading(false);
      return;
    }
    // Non-prod lockdown blocks guest sessions: the gate will show "logged-out"
    // and any retry would just spam 403s. Settle as unauthenticated immediately.
    if (NON_PROD_LOCKDOWN) {
      setGuestToken(null);
      setGuestLoading(false);
      return;
    }

    let cancelled = false;
    // Only flip to loading if we have no cached token; if we do, the async
    // call will resolve immediately and setting true→false would cause the
    // very flicker the lazy initializer was designed to prevent.
    if (!getCachedGuestSession()?.token) {
      setGuestLoading(true);
    }

    const resolveGuestSession = async () => {
      for (
        let attempt = 0;
        attempt <= GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        let session: Awaited<ReturnType<typeof getOrCreateGuestSession>> =
          null;
        try {
          session = await getOrCreateGuestSession();
        } catch {
          session = null;
        }

        if (cancelled) return;
        if (
          session ||
          attempt === GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length
        ) {
          setGuestToken(session?.token ?? null);
          setGuestLoading(false);
          return;
        }

        await delay(GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS[attempt]);
        if (cancelled) return;
      }
    };

    void resolveGuestSession();

    return () => {
      cancelled = true;
    };
  }, [workos.isLoading, workos.user]);

  return useMemo(() => {
    if (workos.user) {
      return {
        isLoading: workos.isLoading,
        user: workos.user,
        // authkit-js distinguishes two refresh failures: a network error is
        // rethrown with its state restored to AUTHENTICATED (retryable), while
        // a rejected refresh grant wipes the session, latches state to ERROR,
        // and throws `LoginRequiredError` forever after (retrying can only
        // re-throw). Matching on `name` rather than `instanceof` because
        // authkit-react bundles its own copy of the error class.
        getAccessToken: () =>
          fetchTokenWithRetry(() => workos.getAccessToken(), {
            source: "workos_token_refresh",
            isTerminalError: (error) =>
              error instanceof Error && error.name === "LoginRequiredError",
          }),
      };
    }

    return {
      isLoading: workos.isLoading || guestLoading,
      user: guestToken ? GUEST_USER_PLACEHOLDER : null,
      getAccessToken: async (
        opts?: { forceRefreshToken?: boolean },
      ): Promise<string | null> => {
        // Lockdown blocks guest sessions server-side; a ladder would just
        // spend 5s collecting 403s.
        if (NON_PROD_LOCKDOWN) return null;

        // Convex asks for a token, gets one, and authenticates the guest —
        // the true "activated as a guest" signal. Marking HERE (rather than
        // in the resolve effect) is immune to the effect-cancel race when a
        // guest signs in mid-resolve, and never fires for an authed user
        // (whose memo branch returns the WorkOS getAccessToken above).
        // Keyed by guestId; idempotent.
        const activate = (token: string | null): string | null => {
          if (token) markActiveGuest();
          return token;
        };

        if (opts?.forceRefreshToken) {
          const refreshed = await fetchTokenWithRetry(
            () => forceRefreshGuestSession(),
            { source: "guest_token_refresh" },
          );
          setGuestToken(refreshed);
          return activate(refreshed);
        }

        // Prefer the latest in-memory cache so a fresh token is used even
        // if React hasn't yet re-rendered with the new state.
        const cached = getCachedGuestSession()?.token;
        if (cached) return activate(cached);

        // No usable cache. Mint one rather than falling back to the
        // `guestToken` state copy: once the cache lapses into its expiry
        // buffer that copy is the SAME expired token, and handing it back is
        // indistinguishable from having no token at all. This path is the one
        // that actually runs on Convex's scheduled refetch, because the
        // `@convex-dev/workos` adapter calls `getAccessToken()` with no
        // arguments and so never sets `forceRefreshToken`.
        const minted = await fetchTokenWithRetry(
          () => getOrCreateGuestSession().then((s) => s?.token ?? null),
          { source: "guest_token_refresh" },
        );
        setGuestToken(minted);
        return activate(minted);
      },
    };
  }, [
    workos.isLoading,
    workos.user,
    workos.getAccessToken,
    guestToken,
    guestLoading,
  ]);
}
