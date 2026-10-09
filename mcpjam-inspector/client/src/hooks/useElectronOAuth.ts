import { navigateApp } from "@/lib/app-navigation";
import { useEffect } from "react";

export function useElectronOAuth() {
  useEffect(() => {
    // Only set up the callback if we're running in Electron
    if (!window.isElectron || !window.electronAPI?.oauth) {
      return;
    }

    const handleOAuthCallback = (url: string) => {
      try {
        // Parse the callback URL to extract tokens/parameters
        const urlObj = new URL(url);
        if (
          urlObj.protocol !== "mcpjam:" ||
          urlObj.host !== "oauth" ||
          urlObj.pathname !== "/callback"
        )
          return;
        const flow = urlObj.searchParams.get("flow");
        const params = new URLSearchParams(urlObj.search);

        window.dispatchEvent(
          new CustomEvent<string>("electron-oauth-callback", {
            detail: url,
          }),
        );

        if (flow === "debug") return;
        if (
          flow === "mcp" ||
          params.get("state")?.startsWith("electron_mcp:")
        ) {
          params.delete("flow");
          navigateApp(`/oauth/callback?${params}`, {
            replace: true,
            unscoped: true,
          });
          return;
        }

        // Extract the code and state from the callback
        const code = params.get("code");
        const state = params.get("state");
        const error = params.get("error");

        if (error) {
          console.error("OAuth error:", error);
          return;
        }

        if (code) {
          // Redirect to the callback page with the code and state
          // This mimics what would happen in a browser OAuth flow
          const callbackUrl = new URL("/callback", window.location.origin);
          callbackUrl.searchParams.set("code", code);
          if (state) {
            callbackUrl.searchParams.set("state", state);
          }

          // Navigate to the callback URL to trigger AuthKit's processing
          window.location.href = callbackUrl.toString();
        }
      } catch {
        console.error("Failed to parse OAuth callback");
      }
    };

    // Set up the callback listener
    window.electronAPI.oauth.onCallback(handleOAuthCallback);

    // Cleanup on unmount
    return () => {
      if (window.electronAPI?.oauth) {
        window.electronAPI.oauth.removeCallback();
      }
    };
  }, []);
}
