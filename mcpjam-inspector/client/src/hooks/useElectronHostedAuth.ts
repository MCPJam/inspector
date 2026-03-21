import { useCallback } from "react";
import { createClient } from "@workos-inc/authkit-js";
import { useAuth } from "@workos-inc/authkit-react";
import {
  getWorkosClientId,
  getWorkosClientOptions,
  getWorkosDevMode,
  getWorkosRedirectUri,
} from "@/lib/workos-config";

export function useElectronHostedAuth() {
  const auth = useAuth();
  const defaultSignIn = auth.signIn;
  const defaultSignUp = auth.signUp;

  const openHostedAuth = useCallback(
    async (
      mode: "signIn" | "signUp",
      opts?: Parameters<typeof auth.signIn>[0],
    ): Promise<void> => {
      if (!window.isElectron) {
        if (mode === "signIn") {
          return defaultSignIn(opts);
        }
        return defaultSignUp(opts);
      }

      const clientId = getWorkosClientId();
      if (!clientId) {
        console.warn(
          "[auth] Missing WorkOS client ID in Electron; falling back to default AuthKit navigation.",
        );
        if (mode === "signIn") {
          return defaultSignIn(opts);
        }
        return defaultSignUp(opts);
      }

      const client = await createClient(clientId, {
        redirectUri: getWorkosRedirectUri(),
        devMode: getWorkosDevMode(),
        ...getWorkosClientOptions(),
      });

      try {
        const url =
          mode === "signIn"
            ? await client.getSignInUrl(opts)
            : await client.getSignUpUrl(opts);

        if (window.electronAPI?.app?.openExternal) {
          await window.electronAPI.app.openExternal(url);
          return;
        }

        console.warn(
          "[auth] Electron openExternal bridge unavailable; falling back to in-app navigation guard.",
        );
        window.location.assign(url);
      } finally {
        client.dispose();
      }
    },
    [defaultSignIn, defaultSignUp],
  );

  const signIn = useCallback(
    (opts?: Parameters<typeof auth.signIn>[0]) => openHostedAuth("signIn", opts),
    [openHostedAuth],
  );

  const signUp = useCallback(
    (opts?: Parameters<typeof auth.signUp>[0]) => openHostedAuth("signUp", opts),
    [openHostedAuth],
  );

  return {
    ...auth,
    signIn,
    signUp,
  };
}
