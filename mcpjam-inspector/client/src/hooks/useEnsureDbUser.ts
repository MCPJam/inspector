import { useEffect, useRef, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import * as Sentry from "@sentry/react";
import {
  getGuestPromotionProof,
  revokeGuestSessionAndCookie,
} from "@/lib/guest-session";
import { useActorKey } from "@/hooks/use-actor-key";

// Fallback substring used when Convex doesn't surface a structured error
// code for write-conflicts. Update if Convex changes the wording — without
// it, retries silently stop firing and conflicts re-surface in Sentry.
const CONVEX_WRITE_CONFLICT_MESSAGE =
  "changed while this mutation was being run";
const ENSURE_USER_RETRY_DELAYS_MS = [50, 150];

type EnsureUserArgs = {
  guestProofJwt?: string;
};

type EnsureUserMutation = (args: EnsureUserArgs) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

  // WorkOS signout now falls back to Convex guest auth, so Convex can remain
  // authenticated while the Sentry user must be cleared.
  useEffect(() => {
    if (!workosUserId) {
      Sentry.setUser(null);
    }
  }, [workosUserId]);

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

    const run = async () => {
      // Only the WorkOS branch can promote a guest. Skip the proof mint
      // when the identity is itself a guest — there's nothing to promote
      // and the lookup would just round-trip needlessly. The proof is a
      // short-lived (5-min) JWT distinct from the session bearer so a
      // stolen bearer cannot be used to absorb a victim's projects.
      const isWorkOsAuth = !!workosUserId;
      let guestProofJwt: string | null = null;
      if (isWorkOsAuth) {
        try {
          guestProofJwt = await getGuestPromotionProof();
        } catch {
          // Network/transient failure minting the promotion proof is not
          // fatal — the user can still create a fresh org-owned account.
          guestProofJwt = null;
        }
      }

      if (cancelled || activeEnsureIdentityRef.current !== identityKey) {
        return;
      }

      const ensureArgs = guestProofJwt ? { guestProofJwt } : {};
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
          setIsEnsuringUser(false);
        }
        return;
      }

      if (cancelled || activeEnsureIdentityRef.current !== identityKey) return;

      lastEnsuredIdentityRef.current = identityKey;
      setEnsuredIdentityKey(identityKey);
      if (workosUserId) {
        Sentry.setUser({ id: workosUserId });
      }

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
    };
  }, [identityKey, isAuthenticated, isLoading, workosUserId, ensureUser]);

  return { isEnsuringUser, isUserReady };
}
