/**
 * Server-Side Authentication Hook
 *
 * This hook provides authentication state by fetching from the server-side
 * auth endpoints. It replaces the client-side @workos-inc/authkit-react
 * approach with server-managed sessions using HTTP-only cookies.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { authFetch } from "@/lib/session-token";

/**
 * User type matching WorkOS user structure
 */
export interface ServerAuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  profilePictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Auth state returned from /api/auth/me
 */
interface AuthMeResponse {
  user: ServerAuthUser | null;
  sessionId: string | null;
  organizationId: string | null;
  role: string | null;
  permissions: string[];
}

/**
 * Hook return type
 */
export interface UseServerAuthReturn {
  /** Current authenticated user or null */
  user: ServerAuthUser | null;
  /** Whether auth state is still being loaded */
  isLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Session ID */
  sessionId: string | null;
  /** Organization ID */
  organizationId: string | null;
  /** User role */
  role: string | null;
  /** User permissions */
  permissions: string[];
  /** Redirect to sign in page */
  signIn: (options?: { returnTo?: string }) => void;
  /** Redirect to sign up page */
  signUp: (options?: { returnTo?: string }) => void;
  /** Sign out the current user */
  signOut: (options?: { returnTo?: string }) => Promise<void>;
  /** Refresh auth state from server */
  refresh: () => Promise<void>;
  /** Get access token for API calls (matches WorkOS useAuth interface) */
  getAccessToken: () => Promise<string | undefined>;
}

/**
 * Hook for server-side authentication
 *
 * Fetches authentication state from /api/auth/me on mount and provides
 * methods for sign in, sign up, and sign out.
 */
export function useServerAuth(): UseServerAuthReturn {
  const [user, setUser] = useState<ServerAuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const fetchingRef = useRef(false);

  const fetchAuthState = useCallback(async () => {
    // Prevent concurrent fetches
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      const response = await authFetch("/api/auth/me");

      if (!response.ok) {
        // Not authenticated - clear state
        setUser(null);
        setSessionId(null);
        setOrganizationId(null);
        setRole(null);
        setPermissions([]);
        return;
      }

      const data: AuthMeResponse = await response.json();

      setUser(data.user);
      setSessionId(data.sessionId);
      setOrganizationId(data.organizationId);
      setRole(data.role);
      setPermissions(data.permissions);
    } catch (error) {
      console.error("[useServerAuth] Error fetching auth state:", error);
      // On error, assume not authenticated
      setUser(null);
      setSessionId(null);
      setOrganizationId(null);
      setRole(null);
      setPermissions([]);
    } finally {
      setIsLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // Fetch auth state on mount
  useEffect(() => {
    fetchAuthState();
  }, [fetchAuthState]);

  /**
   * Redirect to sign in page
   */
  const signIn = useCallback((options?: { returnTo?: string }) => {
    const returnTo = options?.returnTo ?? window.location.pathname;
    const url = new URL("/api/auth/login", window.location.origin);
    url.searchParams.set("returnTo", returnTo);
    url.searchParams.set("screenHint", "sign-in");
    window.location.href = url.toString();
  }, []);

  /**
   * Redirect to sign up page
   */
  const signUp = useCallback((options?: { returnTo?: string }) => {
    const returnTo = options?.returnTo ?? window.location.pathname;
    const url = new URL("/api/auth/login", window.location.origin);
    url.searchParams.set("returnTo", returnTo);
    url.searchParams.set("screenHint", "sign-up");
    window.location.href = url.toString();
  }, []);

  /**
   * Sign out the current user
   */
  const signOut = useCallback(async (options?: { returnTo?: string }) => {
    try {
      const response = await authFetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: options?.returnTo ?? "/" }),
      });

      if (response.ok) {
        const data = await response.json();
        // Redirect to WorkOS logout URL
        window.location.href = data.logoutUrl;
      } else {
        console.error("[useServerAuth] Logout failed:", await response.text());
        // Still clear local state
        setUser(null);
        setSessionId(null);
        setOrganizationId(null);
        setRole(null);
        setPermissions([]);
      }
    } catch (error) {
      console.error("[useServerAuth] Logout error:", error);
      // Still clear local state
      setUser(null);
      setSessionId(null);
      setOrganizationId(null);
      setRole(null);
      setPermissions([]);
    }
  }, []);

  /**
   * Get access token for API calls
   * This matches the WorkOS useAuth interface for compatibility
   */
  const getAccessToken = useCallback(async (): Promise<string | undefined> => {
    try {
      const response = await authFetch("/api/auth/token");

      if (!response.ok) {
        return undefined;
      }

      const data = await response.json();
      return data.accessToken ?? undefined;
    } catch (error) {
      console.error("[useServerAuth] Error getting access token:", error);
      return undefined;
    }
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    sessionId,
    organizationId,
    role,
    permissions,
    signIn,
    signUp,
    signOut,
    refresh: fetchAuthState,
    getAccessToken,
  };
}
