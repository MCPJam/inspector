import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import {
  getPostHogKey,
  getPostHogOptions,
  isPostHogDisabled,
} from "./logs/PosthogUtils.ts";
import { PostHogProvider } from "posthog-js/react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import { initSentry } from "./lib/sentry.ts";

// Initialize Sentry before React mounts
initSentry();

const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
const workosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string;

// Compute redirect URI safely across environments
const workosRedirectUri = (() => {
  const envRedirect =
    (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || undefined;

  // If explicitly set in env, use that
  if (envRedirect) return envRedirect;

  if (typeof window === "undefined") return "/callback";

  // Check if running in Electron - this is set by preload.ts
  // IMPORTANT: Must check this before checking HTTP protocol
  if ((window as any)?.isElectron) {
    console.log("Detected Electron environment, using custom protocol");
    return "mcpjam://authkit/callback";
  }

  // For web browsers
  const isBrowserHttp =
    window.location.protocol === "http:" ||
    window.location.protocol === "https:";
  if (isBrowserHttp) {
    console.log("Detected web browser, using web callback");
    return `${window.location.origin}/callback`;
  }

  return `${window.location.origin}/callback`;
})();

console.log("WorkOS Redirect URI:", workosRedirectUri);

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

const convex = new ConvexReactClient(convexUrl);

const root = createRoot(document.getElementById("root")!);

// Handle MCP OAuth callback when it lands in external browser during Electron flow
// The OAuth provider redirects to http://localhost:8080/oauth/callback?platform=electron
// We need to redirect to mcpjam:// protocol so Electron can handle it
const urlParams = new URLSearchParams(window.location.search);
const isElectronOAuthCallback =
  window.location.pathname.startsWith("/oauth/callback") &&
  urlParams.get("platform") === "electron";

if (isElectronOAuthCallback) {
  // Extract OAuth params
  const code = urlParams.get("code");
  const state = urlParams.get("state");
  const error = urlParams.get("error");

  if (code || error) {
    // Build the custom protocol URL
    const protocolUrl = new URL("mcpjam://oauth/callback");
    if (code) protocolUrl.searchParams.set("code", code);
    if (state) protocolUrl.searchParams.set("state", state);
    if (error) protocolUrl.searchParams.set("error", error);

    // Show redirect message
    root.render(
      <StrictMode>
        <div className="flex items-center justify-center min-h-screen bg-background">
          <div className="text-center space-y-4 p-8">
            <div className="text-6xl">🔄</div>
            <h1 className="text-2xl font-semibold">Redirecting to MCPJam...</h1>
            <p className="text-sm text-muted-foreground">
              If the app doesn't open automatically, please return to it manually.
            </p>
          </div>
        </div>
      </StrictMode>
    );

    // Redirect to custom protocol - this will trigger Electron's open-url handler
    window.location.href = protocolUrl.toString();
  }
} else {
  // Normal app flow (web mode or non-callback routes)
  const Providers = (
    <AuthKitProvider clientId={workosClientId} redirectUri={workosRedirectUri}>
      <ConvexProviderWithAuthKit client={convex} useAuth={useAuth}>
        <App />
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  );

  root.render(
    <StrictMode>
      {isPostHogDisabled ? (
        Providers
      ) : (
        <PostHogProvider apiKey={getPostHogKey()} options={getPostHogOptions()}>
          {Providers}
        </PostHogProvider>
      )}
    </StrictMode>,
  );
}
