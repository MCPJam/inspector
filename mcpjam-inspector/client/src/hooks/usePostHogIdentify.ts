import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { detectPlatform } from "@/lib/PosthogUtils";
import { refreshServerFeatureFlagsForActor } from "@/lib/server-feature-flags";
import { HOSTED_MODE } from "@/lib/config";
import { useActorKey } from "@/hooks/use-actor-key";

/**
 * The person properties that name a human. Withheld from members of an
 * organization with enterprise privacy.
 */
const IDENTIFYING_PERSON_PROPERTIES = [
  "email",
  "name",
  "first_name",
  "last_name",
  "occupation",
];

/**
 * Identify the active actor in PostHog using the same id the backend uses:
 * the WorkOS user id for signed-in users, the cookie-backed guestId for
 * guests. Reset only on a true identity switch away from an authed user, so
 * the same browser revisiting as a guest keeps a stable distinct_id.
 *
 * `enterprisePrivacyMember` is `resolveEnterprisePrivacyMember` over the
 * user's organizations. Name, email and occupation are sent only when it is
 * exactly `false`: while the list is still loading (`undefined`) the actor is
 * identified by id alone, and the rest follows once it is known — so a member
 * of an organization with enterprise privacy never has them sent, not even
 * on the first load. This is independent of the session's replay level: a
 * desktop session is replayed `masked` but identifies as before.
 */
export function usePostHogIdentify({
  enterprisePrivacyMember,
}: {
  enterprisePrivacyMember: boolean | undefined;
}) {
  const posthog = usePostHog();
  const { user, getAccessToken } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const convexUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? ({} as any) : "skip",
  );
  const actorKey = useActorKey();
  const previousActorRef = useRef<{ key: string; wasAuthed: boolean } | null>(
    null,
  );
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const identityUnsetForActorRef = useRef<string | null>(null);

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
        ...(!HOSTED_MODE ? { local_browser_security_version: "1" } : {}),
        deployment: HOSTED_MODE ? "hosted" : "self_hosted",
        platform: detectPlatform(),
      });
    }

    if (isActorChange && previous && !previous.wasAuthed) {
      // reset() above only covers a departing authed actor. A departing
      // guest's server-evaluated flags must not survive into the new actor
      // either — the refresh below can fail without replacing them.
      posthog.updateFlags?.({});
    }

    // `deployment` is a PERSON property here, not just a super property: the
    // super prop rides events, while `/flags` targeting reads person
    // properties. Set for every actor (guest included) so a cohort rule like
    // "self_hosted signed-in users" evaluates correctly.
    let personProperties: Record<string, string | null | undefined> = {
      deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    };
    if (isAuthedActor && user && enterprisePrivacyMember === false) {
      // Identity is about to be re-sent, so the clearing below must be able
      // to run again if this person later joins (or their organization later
      // turns on) enterprise privacy within this page load. Without re-arming,
      // a member → non-member → member sequence would leave the name and email
      // sent in the middle step on their PostHog person.
      if (identityUnsetForActorRef.current === actorKey) {
        identityUnsetForActorRef.current = null;
      }
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
    if (
      isAuthedActor &&
      enterprisePrivacyMember === true &&
      identityUnsetForActorRef.current !== actorKey
    ) {
      // Person properties outlive the page: someone identified before their
      // organization turned on enterprise privacy still carries a name and
      // email on their PostHog person. Clear them once per actor per load —
      // after identify, so a first-time merge has landed on the real person.
      identityUnsetForActorRef.current = actorKey;
      posthog.unsetPersonProperties?.(IDENTIFYING_PERSON_PROPERTIES);
    }
    if (isActorChange) {
      posthog.register({ user_id: actorKey });
      previousActorRef.current = { key: actorKey, wasAuthed: isAuthedActor };
      // Flags are evaluated by our server, not by posthog-js on identify
      // (MJ-015), so fetch the new actor's values here.
      void refreshServerFeatureFlagsForActor(posthog, {
        actorKey,
        isAuthedActor,
        getAccessToken: getAccessTokenRef.current,
      });
    }
  }, [posthog, actorKey, user, convexUser, enterprisePrivacyMember]);
}
