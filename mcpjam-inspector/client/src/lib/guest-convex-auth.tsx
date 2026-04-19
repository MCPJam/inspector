import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { getGuestBearerToken } from "@/lib/guest-session";

type GuestCapableConvexClient = {
  setAuth: (
    fetchToken: (args: {
      forceRefreshToken: boolean;
    }) => Promise<string | null | undefined>
  ) => void;
};

/**
 * Keeps Convex queries/mutations guest-authenticated when there is no WorkOS
 * session. This lets direct guests use normal Convex-backed flows without
 * pretending they are signed-in users.
 */
export function GuestConvexAuthBridge({
  client,
}: {
  client: GuestCapableConvexClient;
}) {
  const { isLoading, user } = useAuth();

  useEffect(() => {
    if (isLoading || user) {
      return;
    }

    client.setAuth(async () => await getGuestBearerToken());
  }, [client, isLoading, user]);

  return null;
}
