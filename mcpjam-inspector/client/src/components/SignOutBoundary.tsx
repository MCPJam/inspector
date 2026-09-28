import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { setSessionRevokedHandler } from "@/lib/auth/session-revoked";
import { signOutRevokedSession } from "@/lib/auth/sign-out-revoked-session";
import { useSignOutStore } from "@/stores/sign-out-store";
import LoadingScreen from "./LoadingScreen";

export function SignOutBoundary({ children }: { children: ReactNode }) {
  const isSigningOut = useSignOutStore((state) => state.isSigningOut);
  const message = useSignOutStore((state) => state.message);
  useSessionRevokedSignOut();
  return isSigningOut ? <LoadingScreen message={message} /> : children;
}

/**
 * Signs this tab out, once, when the gateway reports its session revoked
 * (MJ-011). See `session-revoked.ts`.
 */
function useSessionRevokedSignOut(): void {
  const { signOut } = useAuth();
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  useEffect(
    () =>
      setSessionRevokedHandler(() => {
        void signOutRevokedSession((options) =>
          signOutRef.current(options),
        );
      }),
    [],
  );
}
