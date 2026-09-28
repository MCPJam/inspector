import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth as useWorkOSAuth } from "@workos-inc/authkit-react";
import { isLoginRequiredError } from "@/lib/auth/login-required-error";
import { reportCaught } from "@/lib/error-reporting";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import {
  forceRefreshGuestSessionOrThrow,
  getCachedGuestSession,
  getOrCreateGuestSessionOrThrow,
  markGuestActivated,
  getGuestSessionRefusal,
} from "@/lib/guest-session";
import { shouldSkipGuestSession } from "@/lib/vanity-landing-hosts";
import { sanitizeGuestSessionFailureDetails } from "@/shared/guest-session-failure";

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
const AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS =
  GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convex clears socket auth before notifying React when its fetcher returns
// null. Commit the readiness gate first so protected subscriptions are removed
// while the socket still has its old identity. This runs after async token I/O.
function pauseQueriesBeforeAuthClear(): null {
  flushSync(() => useSessionRefreshStore.getState().pauseQueries());
  return null;
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
    /**
     * A null token that will stay null for the rest of the window (the
     * server refused to create a guest). Stops the retry ladder without
     * reporting and without the "session expired" banner — the refusal has
     * its own banner.
     */
    isTerminalNull?: () => boolean;
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
      if (token) {
        // Whatever went wrong before is over — take any banner down.
        useSessionRefreshStore.getState().clear();
        return token;
      }
      if (opts.isTerminalNull?.()) return pauseQueriesBeforeAuthClear();
      lastError = undefined;
    } catch (error) {
      if (opts.isTerminalError?.(error)) {
        useSessionRefreshStore.getState().notifyFailure("signed_out");
        return pauseQueriesBeforeAuthClear();
      }
      lastError = error;
    }

    if (attempt === AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS.length) break;
    await delay(AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS[attempt]);
  }

  // Failures throw their real cause, so the generic message fires only when
  // every attempt returned no token without an error — for a guest, the
  // server answering a create request with a 204 "no guest".
  reportCaught(lastError ?? new Error(`${opts.source} returned no token`), {
    source: opts.source,
    level: "warning",
    extra: {
      attempts: AUTH_TOKEN_REFRESH_RETRY_DELAYS_MS.length + 1,
      ...guestFailureExtra(lastError),
    },
  });
  // Convex is about to clearAuth() on this null. Surface a banner offering an
  // in-place retry, rather than letting the page crash into an error boundary
  // whose "Try again" cannot work while Convex sits in `noAuth`.
  useSessionRefreshStore.getState().notifyFailure("transient");
  return pauseQueriesBeforeAuthClear();
}

// What a failed guest-session request knows about its failure: the HTTP status
// if the server answered, and why the server's own upstream hop failed if it
// said. Read by shape so this module does not depend on the error class. Each
// key is absent, not undefined, when unknown.
function guestFailureExtra(error: unknown): Record<string, string | number> {
  const { status, upstreamFailure } = (error ?? {}) as {
    status?: unknown;
    upstreamFailure?: unknown;
  };
  const extra: Record<string, string | number> = {};
  if (typeof status === "number") extra.httpStatus = status;
  const failure = sanitizeGuestSessionFailureDetails(upstreamFailure);
  if (failure) {
    extra.upstreamReason = failure.reason;
    if (failure.upstreamStatus !== undefined) {
      extra.upstreamStatus = failure.upstreamStatus;
    }
    if (failure.networkCode !== undefined) {
      extra.networkCode = failure.networkCode;
    }
  }
  return extra;
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
  // caniuse.dev renders from the public host catalog and needs no identity,
  // so it must not spend from the per-IP daily guest budget. Read per render
  // rather than at module load: it is a Set lookup, and a module-level
  // constant would freeze the hostname before a test could stub it.
  const skipGuest = shouldSkipGuestSession();
  // Bumped when the user presses Retry on the session-refresh banner. It feeds
  // both the memo below (new `getAccessToken` identity → Convex re-runs
  // `setAuth`) and the guest bootstrap effect (a fully-lapsed guest has
  // `user: null`, and the adapter only installs auth once `user` is truthy, so
  // the guest must be re-minted before a re-auth can happen at all).
  const retryNonce = useSessionRefreshStore((s) => s.retryNonce);
  const [guestToken, setGuestToken] = useState<string | null>(
    () => getCachedGuestSession()?.token ?? null,
  );
  // `false` under `skipGuest`: the lazy initializer is what makes a cold
  // visit start in a loading state, and with no bootstrap to clear it the
  // surface would sit on a spinner forever.
  const [guestLoading, setGuestLoading] = useState(
    () => !skipGuest && getCachedGuestSession()?.token == null,
  );

  // Fetch a guest token whenever there is no signed-in WorkOS user. Reset
  // when a user does sign in so subsequent renders favor the WorkOS path.
  useEffect(() => {
    if (workos.isLoading) {
      return;
    }
    if (skipGuest) {
      setGuestToken(null);
      setGuestLoading(false);
      return;
    }
    if (workos.user) {
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
      let lastError: unknown;
      for (
        let attempt = 0;
        attempt <= GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        let session: Awaited<
          ReturnType<typeof getOrCreateGuestSessionOrThrow>
        > = null;
        try {
          session = await getOrCreateGuestSessionOrThrow();
          lastError = undefined;
        } catch (error) {
          session = null;
          lastError = error;
        }

        if (cancelled) return;
        if (session) {
          setGuestToken(session?.token ?? null);
          setGuestLoading(false);
          return;
        }

        // A refused creation (per-IP daily cap) is deterministic for the rest
        // of its window: retrying cannot succeed and is not an error worth
        // paging on. The banner offers sign-in instead.
        if (getGuestSessionRefusal()) {
          setGuestToken(null);
          setGuestLoading(false);
          return;
        }

        if (attempt === GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length) {
          reportCaught(
            lastError ??
              new Error("Guest session bootstrap exhausted without a token"),
            {
              source: "guest_session_bootstrap",
              level: "error",
              extra: {
                attempts: GUEST_SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length + 1,
                ...guestFailureExtra(lastError),
              },
            },
          );
          setGuestToken(null);
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
  }, [skipGuest, workos.isLoading, workos.user, retryNonce]);

  // The WorkOS adapter keys its Convex token fetcher on these callbacks.
  // Changing one clears socket auth, even when the refreshed token is valid.
  // Keep them stable across guest-token and WorkOS profile updates.
  const getWorkosAccessToken = useCallback(
    () =>
      fetchTokenWithRetry(() => workos.getAccessToken(), {
        source: "workos_token_refresh",
        isTerminalError: isLoginRequiredError,
      }),
    [workos.getAccessToken, workos.user?.id, retryNonce],
  );

  const getGuestAccessToken = useCallback(
    async (opts?: { forceRefreshToken?: boolean }): Promise<string | null> => {
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
          () => forceRefreshGuestSessionOrThrow(),
          {
            source: "guest_token_refresh",
            isTerminalNull: () => getGuestSessionRefusal() !== null,
          },
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
        () => getOrCreateGuestSessionOrThrow().then((s) => s?.token ?? null),
        {
          source: "guest_token_refresh",
          isTerminalNull: () => getGuestSessionRefusal() !== null,
        },
      );
      setGuestToken(minted);
      return activate(minted);
    },
    [retryNonce],
  );

  return useMemo(() => {
    if (workos.user) {
      return {
        isLoading: workos.isLoading,
        user: workos.user,
        // authkit-js distinguishes two refresh failures: a network error is
        // rethrown with its state restored to AUTHENTICATED (retryable), while
        // a rejected refresh grant wipes the session, latches state to ERROR,
        // and throws `LoginRequiredError` forever after (retrying can only
        // re-throw). See `isLoginRequiredError` for why that error can only be
        // recognized by its message — matching on `name` silently classified
        // every dead session as transient.
        getAccessToken: getWorkosAccessToken,
      };
    }

    return {
      isLoading: workos.isLoading || guestLoading,
      user: guestToken ? GUEST_USER_PLACEHOLDER : null,
      // Deliberately NOT guarded by `skipGuest`, even though it can mint a
      // guest of its own below: the adapter only calls this once `user` is
      // truthy, and under `skipGuest` `guestToken` never becomes non-null, so
      // it is unreachable there.
      getAccessToken: getGuestAccessToken,
    };
  }, [
    workos.isLoading,
    workos.user,
    getWorkosAccessToken,
    getGuestAccessToken,
    guestToken,
    guestLoading,
    retryNonce,
  ]);
}
