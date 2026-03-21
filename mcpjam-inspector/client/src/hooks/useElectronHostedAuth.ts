import { useCallback } from "react";
import { createClient } from "@workos-inc/authkit-js";
import { useAuth } from "@workos-inc/authkit-react";
import {
  getWorkosClientId,
  getWorkosClientOptions,
  getWorkosDevMode,
  getWorkosRedirectUri,
} from "@/lib/workos-config";

function resolveElectronSignOutPath(returnTo?: string): string {
  if (!returnTo) {
    return "/";
  }

  try {
    const parsed = new URL(returnTo, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return "/";
    }

    if (parsed.pathname === "/callback") {
      return "/";
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

export function useElectronHostedAuth() {
  const auth = useAuth();
  const defaultSignIn = auth.signIn;
  const defaultSignUp = auth.signUp;
  const defaultSignOut = auth.signOut;

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
    (opts?: Parameters<typeof auth.signIn>[0]) =>
      openHostedAuth("signIn", opts),
    [openHostedAuth],
  );

  const signUp = useCallback(
    (opts?: Parameters<typeof auth.signUp>[0]) =>
      openHostedAuth("signUp", opts),
    [openHostedAuth],
  );

  const signOut = useCallback(
    async (opts?: Parameters<typeof auth.signOut>[0]) => {
      if (!window.isElectron) {
        return defaultSignOut(opts);
      }

      const clientId = getWorkosClientId();
      if (!clientId) {
        console.warn(
          "[auth] Missing WorkOS client ID in Electron; falling back to default AuthKit logout.",
        );
        return defaultSignOut(opts);
      }

      const client = await createClient(clientId, {
        redirectUri: getWorkosRedirectUri(),
        devMode: getWorkosDevMode(),
        ...getWorkosClientOptions(),
      });

      try {
        await client.signOut({
          returnTo: window.location.origin,
          navigate: false,
        });
      } finally {
        client.dispose();
      }

      const nextPath = resolveElectronSignOutPath(opts?.returnTo);
      window.history.replaceState({}, "", nextPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new Event("hashchange"));
      window.dispatchEvent(new Event("electron-auth-reset"));
    },
    [defaultSignOut],
  );

  return {
    ...auth,
    signIn,
    signUp,
    signOut,
  };
}
