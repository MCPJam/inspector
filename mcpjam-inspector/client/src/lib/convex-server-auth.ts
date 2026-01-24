/**
 * Convex Server Auth Adapter
 *
 * Provides the useAuth interface required by ConvexProviderWithAuth,
 * fetching access tokens from the server-side auth endpoint.
 */

import { useCallback } from "react";
import { useAuth } from "@/contexts/ServerAuthContext";
import { authFetch } from "@/lib/session-token";

/**
 * Return type for the Convex auth adapter
 * Matches the interface expected by ConvexProviderWithAuth
 */
export interface ConvexAuthReturn {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
}

/**
 * Hook providing Convex-compatible auth interface
 *
 * This adapter bridges the server-side auth with Convex by:
 * 1. Providing isLoading and isAuthenticated from server auth
 * 2. Fetching access tokens from /api/auth/token for Convex auth
 */
export function useConvexServerAuth(): ConvexAuthReturn {
  const { isAuthenticated, isLoading } = useAuth();

  /**
   * Fetch access token from server for Convex authentication
   *
   * Called by Convex when it needs to authenticate requests.
   * The server extracts the token from the session cookie.
   */
  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken: _forceRefreshToken,
    }: {
      forceRefreshToken: boolean;
    }): Promise<string | null> => {
      try {
        const response = await authFetch("/api/auth/token");

        if (!response.ok) {
          // Not authenticated or error
          return null;
        }

        const data = await response.json();
        return data.accessToken ?? null;
      } catch (error) {
        console.error("[ConvexServerAuth] Error fetching token:", error);
        return null;
      }
    },
    [],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
