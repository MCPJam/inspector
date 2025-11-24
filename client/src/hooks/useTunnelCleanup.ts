import { useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:6274';

/**
 * Cleanup orphaned tunnels when the user logs in
 * This ensures a clean state on app launch
 */
export function useTunnelCleanup() {
  const { user, getAccessToken } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const hasRunCleanupRef = useRef<string | null>(null);

  // Reset on logout
  useEffect(() => {
    if (!isAuthenticated) {
      hasRunCleanupRef.current = null;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) return;
    if (!user) return;

    // Only run cleanup once per user session
    if (hasRunCleanupRef.current === user.id) return;

    const cleanupTunnels = async () => {
      try {
        // Get the WorkOS access token
        const accessToken = await getAccessToken();

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Add authorization if available
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }

        // Call the local server endpoint which will call the backend
        const response = await fetch(`${API_BASE}/api/mcp/tunnels/cleanup-orphaned`, {
          method: 'POST',
          headers,
        });

        if (response.ok) {
          console.log('[tunnels] Orphaned tunnels cleanup completed');
          hasRunCleanupRef.current = user.id;
        } else {
          console.warn('[tunnels] Failed to cleanup orphaned tunnels:', await response.text());
        }
      } catch (error) {
        console.error('[tunnels] Error during tunnel cleanup:', error);
        // Don't throw - this is a best-effort cleanup
      }
    };

    // Run cleanup after a short delay to ensure auth is fully set up
    const timeoutId = setTimeout(cleanupTunnels, 1000);

    return () => clearTimeout(timeoutId);
  }, [isAuthenticated, isLoading, user, getAccessToken]);
}
