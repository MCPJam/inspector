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

const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
const workosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string;
// Determine redirect URI with an env override for special cases
// Priority: explicit env → Electron deep link → current origin
const envRedirect = (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || "";
const workosRedirectUri = envRedirect
  ? envRedirect
  : (window as any).isElectron
    ? "mcpjam://oauth/callback"
    : `${window.location.origin}/callback`;

const convex = new ConvexReactClient(convexUrl);

const root = createRoot(document.getElementById("root")!);

const AppTree = (
  <StrictMode>
    <AuthKitProvider clientId={workosClientId} redirectUri={workosRedirectUri}>
      <ConvexProviderWithAuthKit client={convex} useAuth={useAuth}>
        <App />
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  </StrictMode>
);

if (isPostHogDisabled) {
  root.render(AppTree);
} else {
  root.render(
    <StrictMode>
      <PostHogProvider apiKey={getPostHogKey()} options={getPostHogOptions()}>
        {AppTree}
      </PostHogProvider>
    </StrictMode>,
  );
}
