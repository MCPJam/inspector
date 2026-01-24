import { useAuth } from "@workos-inc/authkit-react";
import { useQuery } from "convex/react";

/**
 * Centralized hook for getting the current user's profile picture URL.
 * Uses custom uploaded picture from Convex if available, otherwise falls back to WorkOS.
 */
export function useProfilePicture() {
  const { user } = useAuth();
  const convexUser = useQuery("users:getCurrentUser" as any);

  // Priority: Custom uploaded picture > WorkOS picture > undefined
  const profilePictureUrl =
    convexUser?.profilePictureUrl || user?.profilePictureUrl || undefined;

  return {
    profilePictureUrl,
    isLoading: convexUser === undefined,
  };
}
