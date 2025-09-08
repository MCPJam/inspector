import { useEffect } from "react";

declare global {
  interface Window {
    electronAPI?: {
      oauth: {
        onCallback: (callback: (url: string) => void) => void;
        removeCallback: () => void;
      };
    };
    isElectron?: boolean;
  }
}

export function useElectronOAuth() {
  useEffect(() => {
    // Only set up the callback if we're running in Electron
    if (!window.isElectron || !window.electronAPI?.oauth) {
      return;
    }

    const handleOAuthCallback = (url: string) => {
      console.log("Electron OAuth callback received:", url);

      try {
        // Parse the callback URL to extract tokens/parameters
        const urlObj = new URL(url);
        const params = new URLSearchParams(urlObj.search);

        // Extract the code and state from the callback
        const code = params.get("code");
        const state = params.get("state");
        const error = params.get("error");

        if (error) {
          console.error("OAuth error:", error);
          return;
        }

        if (code) {
          console.log("OAuth code received, redirecting to callback page");

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
      } catch (error) {
        console.error("Failed to parse OAuth callback URL:", error);
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
