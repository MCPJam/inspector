import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { detectPlatform } from "@/lib/PosthogUtils";
import { HOSTED_MODE } from "@/lib/config";
import { useActorKey } from "@/hooks/use-actor-key";

/**
 * Identify the active actor in PostHog using the same id the backend uses:
 * the WorkOS user id for signed-in users, the cookie-backed guestId for
 * guests. Reset only on a true identity switch away from an authed user, so
 * the same browser revisiting as a guest keeps a stable distinct_id.
 */
export function usePostHogIdentify() {
  const posthog = usePostHog();
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const convexUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? ({} as any) : "skip"
  );
  const actorKey = useActorKey();
  const previousActorRef = useRef<{ key: string; wasAuthed: boolean } | null>(
    null
  );

  useEffect(() => {
    if (!posthog) return;
    if (!actorKey) return;

    const previous = previousActorRef.current;
    const isActorChange = !previous || previous.key !== actorKey;
    const isAuthedActor = Boolean(user) && user?.id === actorKey;

    if (isActorChange && previous?.wasAuthed) {
      posthog.reset();
      posthog.register({
        environment: import.meta.env.MODE,
        platform: detectPlatform(),
        version: __APP_VERSION__,
        deployment: HOSTED_MODE ? "hosted" : "self_hosted",
        source: "client",
      });
      // `reset()` clears flag person properties too — restore them, or every
      // flag evaluated between the reset and the next page load would target
      // an unknown deployment.
      posthog.setPersonPropertiesForFlags?.({
        deployment: HOSTED_MODE ? "hosted" : "self_hosted",
        platform: detectPlatform(),
      });
    }

    // `deployment` is a PERSON property here, not just a super property: the
    // super prop rides events, while `/flags` targeting reads person
    // properties. Set for every actor (guest included) so a cohort rule like
    // "self_hosted signed-in users" evaluates correctly.
    let personProperties: Record<string, string | null | undefined> = {
      deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    };
    if (isAuthedActor && user) {
      personProperties = {
        ...personProperties,
        email: user.email,
        name:
          user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.email,
        first_name: user.firstName,
        last_name: user.lastName,
      };
      const trimmedOccupation =
        typeof convexUser?.occupation === "string"
          ? convexUser.occupation.trim()
          : "";
      if (trimmedOccupation) {
        personProperties.occupation = trimmedOccupation;
      }
    }

    posthog.identify(actorKey, personProperties);
    if (isActorChange) {
      posthog.register({ user_id: actorKey });
      previousActorRef.current = { key: actorKey, wasAuthed: isAuthedActor };
    }
  }, [posthog, actorKey, user, convexUser]);
}
