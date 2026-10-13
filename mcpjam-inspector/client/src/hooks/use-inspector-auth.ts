import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { startWorkosAuth } from "@/lib/auth/workos-auth-start";

export function useInspectorAuth() {
  const auth = useAuth();
  const signIn = useCallback(
    (options?: Parameters<typeof auth.signIn>[0]) =>
      startWorkosAuth(() =>
        options === undefined ? auth.signIn() : auth.signIn(options),
      ),
    [auth.signIn],
  );
  const signUp = useCallback(
    (options?: Parameters<typeof auth.signUp>[0]) =>
      startWorkosAuth(() =>
        options === undefined ? auth.signUp() : auth.signUp(options),
      ),
    [auth.signUp],
  );
  return { ...auth, signIn, signUp };
}
