import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { startWorkosAuth } from "@/lib/auth/workos-auth-start";
import type { SignInLocation } from "@/lib/auth/signin-tracking";

export function useInspectorAuth(location: SignInLocation = "app") {
  const auth = useAuth();
  const signIn = useCallback(
    (options?: Parameters<typeof auth.signIn>[0]) =>
      startWorkosAuth(
        () => (options === undefined ? auth.signIn() : auth.signIn(options)),
        { intent: "sign_in", location },
      ),
    [auth.signIn, location],
  );
  const signUp = useCallback(
    (options?: Parameters<typeof auth.signUp>[0]) =>
      startWorkosAuth(
        () => (options === undefined ? auth.signUp() : auth.signUp(options)),
        { intent: "sign_up", location },
      ),
    [auth.signUp, location],
  );
  return { ...auth, signIn, signUp };
}
