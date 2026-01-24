/**
 * Server Auth Context Provider
 *
 * Provides server-side authentication state to the React component tree.
 * This replaces AuthKitProvider from @workos-inc/authkit-react with
 * server-managed sessions using HTTP-only cookies.
 */

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  useServerAuth,
  type UseServerAuthReturn,
  type ServerAuthUser,
} from "@/hooks/useServerAuth";

/**
 * Auth context type - same as UseServerAuthReturn
 */
type ServerAuthContextType = UseServerAuthReturn;

/**
 * Auth context with default values
 */
const ServerAuthContext = createContext<ServerAuthContextType | null>(null);

/**
 * Props for ServerAuthProvider
 */
interface ServerAuthProviderProps {
  children: ReactNode;
}

/**
 * Server Auth Provider Component
 *
 * Wraps the application to provide authentication state via context.
 * Uses the useServerAuth hook internally to manage state.
 */
export function ServerAuthProvider({ children }: ServerAuthProviderProps) {
  const auth = useServerAuth();

  return (
    <ServerAuthContext.Provider value={auth}>
      {children}
    </ServerAuthContext.Provider>
  );
}

/**
 * Hook to access server auth context
 *
 * Must be used within a ServerAuthProvider.
 * This provides a drop-in replacement for useAuth from @workos-inc/authkit-react.
 */
export function useAuth(): UseServerAuthReturn {
  const context = useContext(ServerAuthContext);

  if (!context) {
    throw new Error("useAuth must be used within a ServerAuthProvider");
  }

  return context;
}

// Re-export types for convenience
export type { ServerAuthUser, UseServerAuthReturn };
