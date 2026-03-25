import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { detectPlatform } from "@/lib/PosthogUtils";

/**
 * Automatically identify users in PostHog when they log in/out
 * and set super properties that are sent with every event.
 */
export function usePostHogIdentify() {
  const posthog = usePostHog();
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (!posthog) return;

    // User is authenticated - identify them
    if (isAuthenticated && user) {
      // Identify the user with their WorkOS ID
      posthog.identify(user.id, {
        email: user.email,
        name:
          user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.email,
        first_name: user.firstName,
        last_name: user.lastName,
        // Add any other user properties you want to track
      });

      posthog.register({
        user_id: user.id,
      });
    } else {
      // User logged out - reset PostHog
      posthog.reset();
      // Re-register static props after reset so anonymous events still have them
      posthog.register({
        environment: import.meta.env.MODE,
        platform: detectPlatform(),
        version: __APP_VERSION__,
      });
    }
  }, [posthog, isAuthenticated, user]);
}
