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
const workosRedirectUri =
  (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) ||
  `${window.location.origin}/callback`;

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
