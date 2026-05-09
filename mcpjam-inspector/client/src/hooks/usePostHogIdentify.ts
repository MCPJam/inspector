import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { detectPlatform } from "@/lib/PosthogUtils";
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
      });
    }

    let personProperties: Record<string, string | null | undefined> = {};
    if (isAuthedActor && user) {
      personProperties = {
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
