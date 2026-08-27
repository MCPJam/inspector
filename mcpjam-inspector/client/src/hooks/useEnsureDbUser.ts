import { useEffect, useRef, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { setSentryActor } from "@/lib/sentry-identity";
import {
  getExistingGuestId,
  getGuestPromotionProof,
  isGuestActivated,
  revokeGuestSessionAndCookie,
} from "@/lib/guest-session";
import { useActorKey } from "@/hooks/use-actor-key";

// Fallback substring used when Convex doesn't surface a structured error
// code for write-conflicts. Update if Convex changes the wording — without
// it, retries silently stop firing and conflicts re-surface in Sentry.
const CONVEX_WRITE_CONFLICT_MESSAGE =
  "changed while this mutation was being run";
const ENSURE_USER_RETRY_DELAYS_MS = [50, 150];

// Spaced retries for a run that failed outright (anything the fast
// write-conflict retries above don't cover: a backend throw, an auth edge, a
// conflict that outlived them). Without these a single failure is terminal for
// the session — nothing re-runs the effect, so `isUserReady` stays false while
// Convex stays authenticated, and every readiness-gated query behind it stays
// skipped until the user reloads the tab. Bounded: a backend that is genuinely
// down should not collect one mutation per tab forever.
const ENSURE_USER_RECOVERY_DELAYS_MS = [1_000, 5_000, 15_000];

type EnsureUserArgs = {
  guestProofJwt?: string;
  /**
   * The browser's pre-signup anonymous PostHog id ($device_id — stable even
   * if usePostHogIdentify already identified the browser as a guest,
   * unlike get_distinct_id() which changes on identify). Lets the backend
   * merge the anonymous click funnel into the signed-in actor via
   * identifyProductActor server-side, independent of whether the client's
   * own posthog.identify() call ever fires (it doesn't on every path —
   * Electron system-browser OAuth, closed tabs, old builds).
   */
  posthogAnonDistinctId?: string;
};

type EnsureUserMutation = (args: EnsureUserArgs) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * "First Last" when AuthKit has both halves, otherwise whichever half it has.
 * Undefined rather than an empty string when it has neither — a blank `name`
 * would render as an empty line in Sentry's user block instead of falling back
 * to the email.
 */
function displayName(
  user: {
    firstName?: string | null;
    lastName?: string | null;
  } | null
): string | undefined {
  const parts = [user?.firstName, user?.lastName].filter(
    (part): part is string => typeof part === "string" && part.trim() !== ""
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function isConvexWriteConflictError(err: unknown): boolean {
  if (isRecord(err)) {
    const data = err.data;
    if (isRecord(data)) {
      const code = data.code ?? data.errorCode ?? data.kind ?? data.type;
      if (
        typeof code === "string" &&
        /optimistic|concurr|conflict/i.test(code)
      ) {
        return true;
      }
    }
  }

  return err instanceof Error
    ? err.message.includes(CONVEX_WRITE_CONFLICT_MESSAGE)
    : String(err).includes(CONVEX_WRITE_CONFLICT_MESSAGE);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function retryDelayMs(retryIndex: number) {
  return (
    ENSURE_USER_RETRY_DELAYS_MS[retryIndex] + Math.floor(Math.random() * 25)
  );
}

async function ensureUserWithRetry(
  ensureUser: EnsureUserMutation,
  args: EnsureUserArgs,
  shouldContinue: () => boolean
) {
  for (let attempt = 0; ; attempt++) {
    if (!shouldContinue()) return;

    try {
      await ensureUser(args);
      return;
    } catch (err) {
      if (
        !shouldContinue() ||
        !isConvexWriteConflictError(err) ||
        attempt >= ENSURE_USER_RETRY_DELAYS_MS.length
      ) {
        throw err;
      }

      await delay(retryDelayMs(attempt));
      if (!shouldContinue()) return;
    }
  }
}

/**
 * Ensure the current Convex-authenticated identity has a row in `users`.
 * Works for both signed-in WorkOS users and guest sessions — the backend
 * `users:ensureUser` mutation dispatches on the JWT issuer and creates the
 * appropriate row shape. Runs once per identity, idempotent.
 *
 * On the guest → WorkOS transition, forwards the guest bearer JWT as
 * `guestProofJwt` so the backend can verify guest ownership and promote
 * the guest's existing `users` row in place (preserving _id so projects
 * and history remain linked). After a successful promotion, revokes the
 * guest session so the HttpOnly cookie cannot resurrect the guest
 * identity if the user later signs out.
 */
export function useEnsureDbUser() {
  const { user } = useAuth();
  const workosUserId = user?.id ?? null;
  const posthog = usePostHog();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const actorKey = useActorKey();
  const ensureUser = useMutation(
    "users:ensureUser" as any
  ) as EnsureUserMutation;
  // Three refs coordinate dedup, cancellation, and shared in-flight calls.
  // They are deliberately distinct — collapsing any two reintroduces a race:
  //
  // - lastEnsuredIdentityRef: identity we've already *successfully* ensured.
  //   Short-circuits the effect so we don't re-call ensureUser for the same
  //   identity across re-renders. Guest rows are keyed by the cookie-backed
  //   guest id so in-tab guest rotation re-runs ensureUser.
  //
  // - activeEnsureIdentityRef: identity the *currently running* async work
  //   belongs to. The run and its retry loop bail out the moment this stops
  //   matching, so a late identity change (e.g. guest → WorkOS mid-flight)
  //   cancels stale work instead of overwriting the new identity's state.
  //
  // - inFlightEnsureRef: identity-tagged shared promise. If a second caller
  //   (another hook instance, or a re-render that survived cancellation)
  //   hits the same identity while a request is in flight, it awaits the
  //   existing promise instead of opening a duplicate call. Cleared only if
  //   it still points at the same promise — a later identity may have
  //   replaced it, and we must not null out the new entry.
  const lastEnsuredIdentityRef = useRef<string | null>(null);
  const activeEnsureIdentityRef = useRef<string | null>(null);
  const inFlightEnsureRef = useRef<{
    identityKey: string;
    promise: Promise<void>;
  } | null>(null);
  const [isEnsuringUser, setIsEnsuringUser] = useState(false);
  const [ensuredIdentityKey, setEnsuredIdentityKey] = useState<string | null>(
    null
  );
  // Bumping this token re-runs the effect below after a failed attempt.
  // `recoveryStateRef` counts attempts per identity so a new identity starts
  // with a fresh budget rather than inheriting an exhausted one.
  const [ensureRecoveryToken, setEnsureRecoveryToken] = useState(0);
  const recoveryStateRef = useRef<{
    identityKey: string;
    attempts: number;
  } | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const identityKey =
    !isLoading && isAuthenticated
      ? workosUserId
        ? `workos:${workosUserId}`
        : actorKey
        ? `guest:${actorKey}`
        : null
      : null;
  const isUserReady =
    identityKey !== null && ensuredIdentityKey === identityKey;

  // Reset cache on Convex logout so we re-run for the next login in the same session.
  useEffect(() => {
    if (!isAuthenticated) {
      lastEnsuredIdentityRef.current = null;
      activeEnsureIdentityRef.current = null;
      setEnsuredIdentityKey(null);
      setIsEnsuringUser(false);
    }
  }, [isAuthenticated]);

  // Identity boundary for Sentry.
  //
  // Keyed on the actor, NOT on the ensureUser round-trip below. The previous
  // placement set the user only after `await ensurePromise` resolved, so a
  // crash during boot — or any crash on a session whose ensureUser was still
  // in flight or had failed outright — arrived anonymous. Those are precisely
  // the events worth attributing.
  //
  // WorkOS signout falls back to Convex guest auth, so Convex can stay
  // authenticated while the actor changes underneath it. `setSentryActor`
  // replaces the user object wholesale, so the previous account's email cannot
  // survive that switch.
  // Signed-in is checked FIRST, and on `workosUserId` rather than on
  // `actorKey`. `useActorKey` happens to return the WorkOS id ahead of the
  // guest id, so the two can never disagree for a signed-in render — but
  // ordering the branches the other way would silently make this identity
  // depend on that precedence, and a change over there would go quiet here.
  // Only the guest branch needs the key.
  useEffect(() => {
    if (workosUserId) {
      setSentryActor({
        kind: "signedIn",
        id: workosUserId,
        email: user?.email ?? undefined,
        name: displayName(user),
      });
      return;
    }
    if (!actorKey) {
      setSentryActor(null);
      return;
    }
    setSentryActor({ kind: "guest", id: actorKey });
  }, [actorKey, workosUserId, user?.email, user?.firstName, user?.lastName]);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!isAuthenticated) {
      activeEnsureIdentityRef.current = null;
      setEnsuredIdentityKey(null);
      setIsEnsuringUser(false);
      return;
    }

    if (!identityKey) {
      activeEnsureIdentityRef.current = null;
      setEnsuredIdentityKey(null);
      setIsEnsuringUser(false);
      return;
    }

    if (lastEnsuredIdentityRef.current === identityKey) {
      setEnsuredIdentityKey(identityKey);
      setIsEnsuringUser(false);
      return;
    }

    activeEnsureIdentityRef.current = identityKey;
    setIsEnsuringUser(true);
    let cancelled = false;

    // Re-arm the effect after a failed run, spacing attempts out and stopping
    // once the budget for this identity is spent. Nothing else re-triggers it:
    // the deps are all stable once auth settles. Returns whether a retry is
    // now queued, which is what keeps `isEnsuringUser` honest below.
    const scheduleRecovery = () => {
      const attempts =
        recoveryStateRef.current?.identityKey === identityKey
          ? recoveryStateRef.current.attempts
          : 0;
      const delayMs = ENSURE_USER_RECOVERY_DELAYS_MS[attempts];
      if (delayMs === undefined) return false;
      recoveryStateRef.current = { identityKey, attempts: attempts + 1 };
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        setEnsureRecoveryToken((token) => token + 1);
      }, delayMs);
      return true;
    };

    const run = async () => {
      // Only the WorkOS branch can promote a guest. Skip the proof mint
      // when the identity is itself a guest — there's nothing to promote
      // and the lookup would just round-trip needlessly. The proof is a
      // short-lived (5-min) JWT distinct from the session bearer so a
      // stolen bearer cannot be used to absorb a victim's projects.
      const isWorkOsAuth = !!workosUserId;
      let guestProofJwt: string | null = null;
      // Device id survives even when usePostHogIdentify already identified
      // this browser (e.g. as a guest) — get_distinct_id() would return the
      // post-identify id instead of the original anonymous one. Best-effort:
      // an absent/throwing posthog instance must never block ensureUser.
      let posthogAnonDistinctId: string | undefined;
      if (isWorkOsAuth) {
        // Each getter is tried independently — a throw from $device_id
        // (e.g. an unusual posthog-js build) must not skip the
        // get_distinct_id() fallback, only the getter that actually failed.
        try {
          posthogAnonDistinctId = posthog?.get_property?.("$device_id");
        } catch {
          posthogAnonDistinctId = undefined;
        }
        if (!posthogAnonDistinctId) {
          try {
            posthogAnonDistinctId = posthog?.get_distinct_id?.();
          } catch {
            posthogAnonDistinctId = undefined;
          }
        }

        // Gate promotion on *activation*, not mere cookie presence. The
        // server-rendered guest bootstrap (Pillar 1) can leave an incidental
        // guest cookie on a browser whose user then signs in; that guest was
        // never used as a guest and must not be absorbed into the account.
        // Only mint a promotion proof when the cookie-backed guest carries an
        // activation marker; otherwise revoke the incidental cookie and
        // proceed without a proof.
        let guestId: string | null = null;
        try {
          guestId = await getExistingGuestId();
        } catch {
          guestId = null;
        }

        if (guestId && isGuestActivated(guestId)) {
          try {
            guestProofJwt = await getGuestPromotionProof();
          } catch {
            // Network/transient failure minting the promotion proof is not
            // fatal — the user can still create a fresh org-owned account.
            guestProofJwt = null;
          }
        } else if (guestId) {
          // Incidental, unactivated guest cookie: clean it up so it can't
          // later be replayed, and do NOT promote it.
          try {
            await revokeGuestSessionAndCookie();
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              "[auth] incidental guest cookie revoke failed",
              err
            );
          }
        }
      }

      if (cancelled || activeEnsureIdentityRef.current !== identityKey) {
        return;
      }

      const ensureArgs: EnsureUserArgs = {
        ...(guestProofJwt ? { guestProofJwt } : {}),
        ...(posthogAnonDistinctId ? { posthogAnonDistinctId } : {}),
      };
      let ensurePromise = inFlightEnsureRef.current?.promise;
      if (inFlightEnsureRef.current?.identityKey !== identityKey) {
        ensurePromise = ensureUserWithRetry(ensureUser, ensureArgs, () => {
          return activeEnsureIdentityRef.current === identityKey;
        });
        inFlightEnsureRef.current = {
          identityKey,
          promise: ensurePromise,
        };
        const clearInFlight = () => {
          if (inFlightEnsureRef.current?.promise === ensurePromise) {
            inFlightEnsureRef.current = null;
          }
        };
        ensurePromise.then(clearInFlight, clearInFlight);
      }

      try {
        await ensurePromise;
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error("[auth] ensureUser failed", err);
          lastEnsuredIdentityRef.current = null;
          setEnsuredIdentityKey(null);
          // Setup is only FINISHED once no retry is left. A user with no row
          // yet is shown `UserSetupError` the moment `isEnsuringUser` clears,
          // so dropping it here flashes "Could not finish setup" in the gap
          // between attempts, for a session that goes on to recover.
          if (!scheduleRecovery()) {
            setIsEnsuringUser(false);
          }
        }
        return;
      }

      if (cancelled || activeEnsureIdentityRef.current !== identityKey) return;

      lastEnsuredIdentityRef.current = identityKey;
      setEnsuredIdentityKey(identityKey);
      recoveryStateRef.current = null;

      // If we just authenticated as a WorkOS user and a guest cookie was
      // in play, retire it. Safe to call unconditionally — if no cookie
      // is set the server treats it as a no-op.
      if (isWorkOsAuth && guestProofJwt) {
        try {
          await revokeGuestSessionAndCookie();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[auth] guest session revoke failed", err);
        }
      }

      setIsEnsuringUser(false);
    };

    void run();

    return () => {
      cancelled = true;
      if (activeEnsureIdentityRef.current === identityKey) {
        activeEnsureIdentityRef.current = null;
      }
      // A pending retry is redundant once the effect re-runs for any other
      // reason — that re-run already retries — and must not outlive unmount.
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [
    identityKey,
    isAuthenticated,
    isLoading,
    workosUserId,
    ensureUser,
    posthog,
    ensureRecoveryToken,
  ]);

  return { isEnsuringUser, isUserReady };
}
