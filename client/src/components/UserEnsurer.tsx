import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * Component that ensures a user record exists in Convex when authenticated.
 * This component automatically creates or updates the user profile when they sign in.
 */
export function UserEnsurer() {
  const { isAuthenticated } = useConvexAuth();
  const ensureUser = useMutation(api.users.ensureUser);

  // Ensure a user record exists in Convex when authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    ensureUser().catch((error) => {
      console.error("Failed to ensure user:", error);
    });
  }, [isAuthenticated, ensureUser]);

  // This is a utility component that doesn't render anything
  return null;
}
