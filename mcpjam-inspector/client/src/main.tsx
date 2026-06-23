import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterProvider } from "./router";
import "./index.css";
import { getPostHogKey, getPostHogOptions } from "./lib/PosthogUtils.js";
import { PostHogProvider } from "posthog-js/react";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import { initSentry } from "./lib/sentry.js";
import { IframeRouterError } from "./components/IframeRouterError.jsx";
import { initializeSessionToken } from "./lib/session-token.js";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";
import { HOSTED_MODE } from "./lib/config";
import {
  buildElectronHostedAuthCallbackUrl,
  resolveWorkosRedirectUri,
} from "./lib/electron-hosted-auth";
import { useUnifiedConvexAuth } from "./lib/unified-convex-auth";
import { getRuntimeConvexUrl } from "./lib/runtime-config";
import { normalizeInitialLegacyHashBookmark } from "./lib/app-navigation";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { DbUserReadyProvider } from "./contexts/db-user-ready-context";

// Initialize Sentry before React mounts
initSentry();

function AuthBootstrap({ children }: { children: ReactNode }) {
  const { isEnsuringUser, isUserReady } = useEnsureDbUser();

  return (
    <DbUserReadyProvider
      isEnsuringUser={isEnsuringUser}
      isUserReady={isUserReady}
    >
      {children}
    </DbUserReadyProvider>
  );
}

// Detect if we're inside an iframe - this happens when a user's app uses BrowserRouter
// and does history.pushState, then the iframe is refreshed. The server doesn't recognize
// the new path and serves the Inspector's index.html inside the iframe.
//
// Exception: same-origin self-embed of the public chatbox runtime
// (`/chatbox/<slug>/<token>`). The Chatboxes tab's Preview pane iframes the
// publish link to show a live preview inside the app — that's intentional,
// not a misrouted-pushState misconfiguration, so we let the normal tree
// mount. Restricted to the chatbox route + same-origin parent so the
// "user app accidentally serving inspector index.html" guard still fires
// for every other shape.
const isInIframe = (() => {
  try {
    if (window.self === window.top) return false;
    try {
      const sameOrigin =
        window.top!.location.origin === window.location.origin;
      // Match the documented `/chatbox/<slug>/<token>` shape only; a generic
      // `startsWith("/chatbox/")` would let any unrelated future subpath
      // slip past the misrouted-pushState guard.
      const isPublicChatboxRuntimePath =
        /^\/chatbox\/[^/]+\/[^/]+\/?$/.test(window.location.pathname);
      if (sameOrigin && isPublicChatboxRuntimePath) {
        return false;
      }
    } catch {
      // window.top.location throws under cross-origin — definitely an
      // unrelated embed, keep the guard.
    }
    return true;
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
    </StrictMode>
  );
} else {
  const buildConvexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  const runtimeConvexUrl = getRuntimeConvexUrl();
  const convexUrl = runtimeConvexUrl || buildConvexUrl || "";
  const workosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string;
  const workosDevMode = (() => {
    const explicit = import.meta.env.VITE_WORKOS_DEV_MODE as string | undefined;
    if (explicit === "true") return true;
    if (explicit === "false") return false;
    if (import.meta.env.DEV) return true;
    // Match SDK default: enable devMode on localhost so refresh tokens
    // persist in localStorage across hard refreshes for local prod builds.
    return (
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
    );
  })();

  // Compute redirect URI safely across environments
  const workosRedirectUri = (() => {
    const envRedirect =
      (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || undefined;
    if (typeof window === "undefined") return envRedirect ?? "/callback";
    return resolveWorkosRedirectUri({
      envRedirect,
      isElectron: window.isElectron === true,
      location: window.location,
    });
  })();
  const electronHostedAuthCallbackUrl =
    typeof window === "undefined" || window.isElectron
      ? null
      : buildElectronHostedAuthCallbackUrl(window.location);

  // Warn if critical env vars are missing
  if (!convexUrl) {
    console.warn(
      "[main] VITE_CONVEX_URL is not set; Convex features may not work."
    );
  }
  if (import.meta.env.DEV) {
    console.info("[main] Convex client config", {
      convexUrl: convexUrl || "(empty)",
      source: runtimeConvexUrl
        ? "runtime"
        : buildConvexUrl
          ? "build (VITE_CONVEX_URL)"
          : "none",
      HOSTED_MODE,
    });
  }
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __mcpjamConvex?: unknown }).__mcpjamConvex = {
      convexUrl,
      buildConvexUrl,
      runtimeConvexUrl,
    };
  }
  if (
    HOSTED_MODE &&
    runtimeConvexUrl &&
    buildConvexUrl &&
    runtimeConvexUrl !== buildConvexUrl
  ) {
    console.warn(
      "[main] Hosted runtime Convex URL overrides build-time VITE_CONVEX_URL.",
      {
        buildConvexUrl,
        runtimeConvexUrl,
      }
    );
  }
  if (!workosClientId) {
    console.warn(
      "[main] VITE_WORKOS_CLIENT_ID is not set; authentication will not work."
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
  normalizeInitialLegacyHashBookmark();

  const Providers = (
    <AuthKitProvider
      clientId={workosClientId}
      redirectUri={workosRedirectUri}
      devMode={workosDevMode}
      {...workosClientOptions}
    >
      <ConvexProviderWithAuthKit client={convex} useAuth={useUnifiedConvexAuth}>
        <AuthBootstrap>
          <AppRouterProvider />
        </AuthBootstrap>
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  );

  // Async bootstrap to initialize session token before rendering
  async function bootstrap() {
    const root = createRoot(document.getElementById("root")!);
    const skipLocalSessionBootstrap =
      import.meta.env.DEV && window.location.pathname.startsWith("/__e2e/");

    if (electronHostedAuthCallbackUrl) {
      root.render(
        <StrictMode>
          <OAuthDesktopReturnNotice
            returnToElectronUrl={electronHostedAuthCallbackUrl}
          />
        </StrictMode>,
      );
      return;
    }

    try {
      if (!HOSTED_MODE && !skipLocalSessionBootstrap) {
        // Initialize session token BEFORE rendering in local mode.
        await initializeSessionToken();
        console.log("[Auth] Session token initialized");
      } else {
        console.log(
          "[Auth] Hosted mode active, skipping session token bootstrap"
        );
      }
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
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "100vh",
            }}
          >
            <img
              src="/mcp_jam.svg"
              alt="MCPJam Logo"
              style={{ width: "120px", height: "auto", marginBottom: "1.5rem" }}
            />
            <h1 style={{ color: "#dc2626", marginBottom: "0.5rem" }}>
              Authentication Error
            </h1>
            <p style={{ marginBottom: "0.25rem" }}>
              Failed to establish secure session.
            </p>
            <p style={{ color: "#666", fontSize: "0.875rem" }}>
              If accessing via network, use localhost instead.
            </p>
            <button
              onClick={() => location.reload()}
              style={{
                marginTop: "1.5rem",
                padding: "0.75rem 1.5rem",
                cursor: "pointer",
                backgroundColor: "#18181b",
                color: "#fff",
                border: "none",
                borderRadius: "0.5rem",
                fontSize: "1rem",
                fontWeight: 500,
              }}
            >
              Restart App
            </button>
          </div>
        </StrictMode>
      );
      return;
    }

    root.render(
      <StrictMode>
        <PostHogProvider apiKey={getPostHogKey()} options={getPostHogOptions()}>
          {Providers}
        </PostHogProvider>
      </StrictMode>
    );
  }

  bootstrap();
}
