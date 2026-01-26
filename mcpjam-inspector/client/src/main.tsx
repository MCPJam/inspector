import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import {
  getPostHogKey,
  getPostHogOptions,
  isPostHogDisabled,
} from "./lib/PosthogUtils.js";
import { PostHogProvider } from "posthog-js/react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import { initSentry } from "./lib/sentry.js";
import { IframeRouterError } from "./components/IframeRouterError.jsx";
import { initializeSessionToken } from "./lib/session-token.js";

// Initialize Sentry before React mounts
initSentry();

// Detect if we're inside an iframe - this happens when a user's app uses BrowserRouter
// and does history.pushState, then the iframe is refreshed. The server doesn't recognize
// the new path and serves the Inspector's index.html inside the iframe.
const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    // If we can't access window.top due to cross-origin restrictions, we're in an iframe
    return true;
  }
})();

// If we're in an iframe, render a helpful error message instead of the full Inspector
if (isInIframe) {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <IframeRouterError />
    </StrictMode>,
  );
} else {
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
  const workosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string;

  // Compute redirect URI safely across environments
  const workosRedirectUri = (() => {
    const envRedirect =
      (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || undefined;
    if (typeof window === "undefined") return envRedirect ?? "/callback";
    const isBrowserHttp =
      window.location.protocol === "http:" ||
      window.location.protocol === "https:";
    if (isBrowserHttp) return `${window.location.origin}/callback`;
    if (envRedirect) return envRedirect;
    if ((window as any)?.isElectron) return "mcpjam://oauth/callback";
    return `${window.location.origin}/callback`;
  })();

  // Warn if critical env vars are missing
  if (!convexUrl) {
    console.warn(
      "[main] VITE_CONVEX_URL is not set; Convex features may not work.",
    );
  }
  if (!workosClientId) {
    console.warn(
      "[main] VITE_WORKOS_CLIENT_ID is not set; authentication will not work.",
    );
  }

  const workosClientOptions = (() => {
    const envApiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME as
      | string
      | undefined;
    if (envApiHostname) {
      return { apiHostname: envApiHostname };
    }

    // Dev mode: proxy through Vite dev server to avoid CORS
    if (typeof window === "undefined") return {};
    const disableProxy =
      (import.meta.env.VITE_WORKOS_DISABLE_LOCAL_PROXY as
        | string
        | undefined) === "true";
    if (!import.meta.env.DEV || disableProxy) return {};
    const { protocol, hostname, port } = window.location;
    const parsedPort = port ? Number(port) : undefined;
    return {
      apiHostname: hostname,
      https: protocol === "https:",
      ...(parsedPort ? { port: parsedPort } : {}),
    };
  })();

  const convex = new ConvexReactClient(convexUrl);

  const Providers = (
    <AuthKitProvider
      clientId={workosClientId}
      redirectUri={workosRedirectUri}
      {...workosClientOptions}
    >
      <ConvexProviderWithAuthKit client={convex} useAuth={useAuth}>
        <App />
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  );

  // Async bootstrap to initialize session token before rendering
  async function bootstrap() {
    const root = createRoot(document.getElementById("root")!);

    try {
      // Initialize session token BEFORE rendering
      // This ensures all API calls have authentication
      await initializeSessionToken();
      console.log("[Auth] Session token initialized");
    } catch (error) {
      console.error("[Auth] Failed to initialize session token:", error);
      // Show error UI instead of crashing
      root.render(
        <StrictMode>
          <div
            style={{
              padding: "2rem",
              textAlign: "center",
              fontFamily: "system-ui",
            }}
          >
            <h1 style={{ color: "#dc2626" }}>Authentication Error</h1>
            <p>Failed to establish secure session. Please refresh the page.</p>
            <p style={{ color: "#666", fontSize: "0.875rem" }}>
              If accessing via network, use localhost instead.
            </p>
            <button
              onClick={() => location.reload()}
              style={{
                marginTop: "1rem",
                padding: "0.5rem 1rem",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
          </div>
        </StrictMode>,
      );
      return;
    }

    root.render(
      <StrictMode>
        {isPostHogDisabled ? (
          Providers
        ) : (
          <PostHogProvider
            apiKey={getPostHogKey()}
            options={getPostHogOptions()}
          >
            {Providers}
          </PostHogProvider>
        )}
      </StrictMode>,
    );
  }

  bootstrap();
}
