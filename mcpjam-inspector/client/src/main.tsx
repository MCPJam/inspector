import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterProvider } from "./router";
import "./index.css";
import { getPostHogKey, getPostHogOptions } from "./lib/PosthogUtils.js";
import { preloadPosthogBundledExtensions } from "./lib/posthog-bundled-extensions";
import { PostHogProvider } from "posthog-js/react";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import { captureSentryException, initSentry } from "./lib/sentry.js";
import { reportCaught } from "./lib/error-reporting";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { IframeRouterError } from "./components/IframeRouterError.jsx";
import { initializeSessionToken } from "./lib/session-token.js";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";
import { HOSTED_MODE, SANDBOX_ORIGIN } from "./lib/config";
import {
  buildElectronHostedAuthCallbackUrl,
  resolveWorkosRedirectUri,
} from "./lib/electron-hosted-auth";
import { useUnifiedConvexAuth } from "./lib/unified-convex-auth";
import {
  getRuntimeConvexUrl,
  getRuntimeWorkosApiHostname,
  getRuntimeWorkosClientId,
} from "./lib/runtime-config";
import {
  isDebugOAuthCallbackPath,
  normalizeInitialLegacyHashBookmark,
} from "./lib/app-navigation";
import { TESTER_LINK_RUNTIME_PATH_PATTERN } from "./lib/tester-link-path";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import { ServerConnectionHandoff } from "./components/server-connections/ServerConnectionHandoff";
import {
  PERMALINK_SIGN_IN_STATE_KEY,
  takePermalinkSignInReturn,
} from "./lib/permalink-signin-return";
import {
  callbackMatchesPending,
  HANDOFF_SIGN_IN_STATE_KEY,
  matchHandoffRoute,
  readCallbackParams,
  readPendingAuthorization,
  takeHandoffSignInReturn,
} from "./lib/server-connection-handoff";
import { PlanLimitDialogPreview } from "./components/billing/PlanLimitDialogPreview";
import {
  getInitialThemeMode,
  getInitialThemePreset,
  updateThemeMode,
  updateThemePreset,
} from "./lib/theme-utils";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { DbUserReadyProvider } from "./contexts/db-user-ready-context";
import {
  clearLegacyWorkosRefreshTokenStorage,
  resolveWorkosClientOptions,
  WORKOS_DEV_MODE,
} from "./lib/workos-authkit-config";

// Initialize Sentry before React mounts
initSentry();

/**
 * A hosted deploy with no sandbox origin is a SECURITY REGRESSION, not a
 * config nicety.
 *
 * `VITE_MCPJAM_SANDBOX_ORIGIN` is what puts MCP Apps widgets on an origin that
 * shares no cookies with the host app. Unset, the iframe falls back to
 * same-origin and the isolation the sandbox exists to provide is simply gone.
 *
 * `widget-react` already warns — but it warns from inside a shared package, at
 * RENDER time, on a `console.warn` nobody is watching, and only for a user who
 * happens to open a widget. Reporting it here instead means it is noticed at
 * BOOT, once, by whoever deployed it, through the channel that pages someone.
 *
 * Deliberately non-fatal: refusing to start would take the whole app down over
 * a widget-isolation setting, which is a worse outcome than a loud deploy.
 *
 * SET TO THE APP'S OWN ORIGIN counts as unset. A configured value that equals
 * `window.location.origin` produces exactly the same same-origin iframe as no
 * value at all — the isolation is gone either way — and it is the more likely
 * mistake of the two, because it looks configured.
 *
 * REPORTED ONCE PER TAB. This is a deployment fault, and it is true for every
 * visitor for as long as the deploy lives: capturing on each load turns one
 * static misconfiguration into an exception per page view (and, with replay on,
 * a session recording per visitor), which buries the signal it is meant to
 * raise. `sessionStorage` bounds it to one report per tab without needing
 * anything server-side. The console line stays unconditional — it costs
 * nothing and it is what a developer looking at THIS page load will see.
 */
const sandboxOriginFault =
  HOSTED_MODE && (!SANDBOX_ORIGIN || SANDBOX_ORIGIN === window.location.origin);
if (sandboxOriginFault) {
  const message = SANDBOX_ORIGIN
    ? `VITE_MCPJAM_SANDBOX_ORIGIN is set to this app's own origin (${SANDBOX_ORIGIN}). MCP Apps widgets will render SAME-ORIGIN with the host app, losing the cookie/storage isolation the sandbox provides.`
    : "VITE_MCPJAM_SANDBOX_ORIGIN is not configured in hosted mode. MCP Apps widgets will render SAME-ORIGIN with the host app, losing the cookie/storage isolation the sandbox provides.";
  console.error(`[MCPJam] ${message}`);

  const REPORTED_KEY = "mcpjam.sandbox-origin-fault-reported";
  let alreadyReported = false;
  try {
    alreadyReported = window.sessionStorage.getItem(REPORTED_KEY) === "1";
    window.sessionStorage.setItem(REPORTED_KEY, "1");
  } catch {
    // Storage can be unavailable (Safari private mode, a blocked third-party
    // context). Reporting every load is the safe direction for a security
    // regression — better noisy than silent.
  }
  if (!alreadyReported) {
    captureSentryException(new Error(message), {
      tags: { area: "sandbox-origin", severity: "config" },
    });
  }
}

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
// Exception: same-origin self-embed of the public scenario runtime (a tester
// link path — `/user-testing/<slug>/<token>`).
// The User Testing tab's Preview pane iframes the publish link to show a live
// preview inside the app — that's intentional, not a misrouted-pushState
// misconfiguration, so we let the normal tree mount. Restricted to a tester
// link route + same-origin parent so the "user app accidentally serving
// inspector index.html" guard still fires for every other shape.
const isInIframe = (() => {
  try {
    if (window.self === window.top) return false;
    try {
      const sameOrigin = window.top!.location.origin === window.location.origin;
      // Match the documented `<segment>/<slug>/<token>` shape only; a generic
      // prefix test would let any unrelated future subpath slip past the
      // misrouted-pushState guard. See lib/tester-link-path.ts.
      const isPublicScenarioRuntimePath = TESTER_LINK_RUNTIME_PATH_PATTERN.test(
        window.location.pathname
      );
      if (sameOrigin && isPublicScenarioRuntimePath) {
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

/**
 * Whether this load belongs to the connection handoff page.
 *
 * Two ways in. The handoff paths are unambiguous. The third case is
 * `/oauth/callback`, which is SHARED with the Inspector's own OAuth flow — so
 * it is claimed only when this tab actually started a connection
 * authorization, and only when the query carries an authorization server's
 * answer. Claiming it on the marker alone would swallow the Inspector's own
 * callbacks in the same tab.
 */
function isServerConnectionHandoff(): boolean {
  if (matchHandoffRoute(window.location.pathname)) return true;
  if (window.location.pathname !== "/oauth/callback") return false;
  // Matched on `state`, not merely on a marker existing: an abandoned handoff
  // must not swallow the Inspector's own OAuth callbacks in the same tab.
  return callbackMatchesPending(
    readPendingAuthorization(),
    readCallbackParams(window.location.search)
  );
}

// If we're in an iframe, render a helpful error message instead of the full Inspector
if (isInIframe) {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <IframeRouterError />
    </StrictMode>
  );
} else if (isServerConnectionHandoff()) {
  // <AuthKitProvider> BUT NO CONVEX. The page still holds no credential of its
  // own — every connection call authenticates with an HttpOnly cookie it
  // cannot read — but the CLAIM has to say who the visitor is: the backend
  // refuses an account-owned handoff link to anyone but its owner, and with no
  // token to send it refused the owner too.
  //
  // The provider rather than a hand-rolled token fetch, because only the SDK
  // knows where to ask. The `/user_management` proxy this page first tried is
  // mounted only when `!HOSTED_MODE` (see `server/index.ts`), so in hosted it
  // 404s and every signed-in owner is refused exactly as before — the same
  // shape of never-passing gate this flow has already shipped twice.
  //
  // A signed-out visitor or a guest costs one failed refresh and proceeds
  // unauthenticated, which is what `bestEffortAccessToken` in the page is for.
  // App's theme bootstrap does not run here, so apply the stored theme
  // directly — same as the debug callback below.
  updateThemeMode(getInitialThemeMode());
  updateThemePreset(getInitialThemePreset());
  const handoffWorkosClientId =
    getRuntimeWorkosClientId() ??
    (import.meta.env.VITE_WORKOS_CLIENT_ID as string | undefined) ??
    "";
  const handoffRuntimeApiHostname = getRuntimeWorkosApiHostname();
  const handoffWorkosOptions = handoffRuntimeApiHostname
    ? { apiHostname: handoffRuntimeApiHostname }
    : resolveWorkosClientOptions(import.meta.env, window.location);
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <AuthKitProvider
        clientId={handoffWorkosClientId}
        redirectUri={resolveWorkosRedirectUri({
          envRedirect:
            (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || undefined,
          isElectron: window.isElectron === true,
          location: window.location,
        })}
        devMode={WORKOS_DEV_MODE}
        {...handoffWorkosOptions}
      >
        <ServerConnectionHandoff />
      </AuthKitProvider>
    </StrictMode>
  );
} else if (
  import.meta.env.DEV &&
  window.location.pathname.startsWith("/__preview/plan-limit")
) {
  // Dev-only design harness for the free-plan limit wall. Mounted here, ahead
  // of AuthKit and Convex, because the states worth reviewing (member who
  // can't upgrade, org already at its Team ceiling) can't be produced on
  // demand against a real backend. Renders the real component and the real
  // stylesheet with dummy data. The DEV guard keeps it out of production
  // bundles entirely.
  updateThemeMode(getInitialThemeMode());
  updateThemePreset(getInitialThemePreset());
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <PlanLimitDialogPreview />
    </StrictMode>
  );
} else if (isDebugOAuthCallbackPath(window.location.pathname)) {
  // Throwaway popup: render without <AuthKitProvider>/Convex so it can't fire a
  // WorkOS refresh that logs the opener window out. See isDebugOAuthCallbackPath.
  // App's theme bootstrap doesn't run here, so apply the stored theme directly.
  updateThemeMode(getInitialThemeMode());
  updateThemePreset(getInitialThemePreset());
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <OAuthDebugCallback />
    </StrictMode>
  );
} else {
  const buildConvexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  const runtimeConvexUrl = getRuntimeConvexUrl();
  const convexUrl = runtimeConvexUrl || buildConvexUrl || "";
  // Runtime config wins over the build-time value for the same reason the
  // Convex URL above does: the deployed bundle is shared across environments
  // and only the serving process knows which WorkOS environment it belongs to.
  const buildWorkosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID as
    | string
    | undefined;
  // Coerced to "" rather than typed as `string`: the previous `as string` cast
  // claimed a value that may not exist, and AuthKit already fails loudly on a
  // falsy client id. The warning below is the one that should fire first.
  const workosClientId =
    getRuntimeWorkosClientId() ?? buildWorkosClientId ?? "";

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
      "[main] WorkOS client id is not set (runtime config or VITE_WORKOS_CLIENT_ID); authentication will not work."
    );
  }

  // A runtime hostname takes the same precedence an explicit
  // `VITE_WORKOS_API_HOSTNAME` has inside `resolveWorkosClientOptions`: it
  // overrides the local-proxy derivation rather than merging with it.
  const runtimeWorkosApiHostname = getRuntimeWorkosApiHostname();
  const workosClientOptions = runtimeWorkosApiHostname
    ? { apiHostname: runtimeWorkosApiHostname }
    : resolveWorkosClientOptions(
        import.meta.env,
        typeof window === "undefined" ? undefined : window.location
      );
  clearLegacyWorkosRefreshTokenStorage();

  const convex = new ConvexReactClient(convexUrl);
  normalizeInitialLegacyHashBookmark();

  const Providers = (
    <AuthKitProvider
      clientId={workosClientId}
      redirectUri={workosRedirectUri}
      devMode={WORKOS_DEV_MODE}
      onRefresh={() => {
        clearLegacyWorkosRefreshTokenStorage();
      }}
      /**
       * Send a returning sign-in back where it started, when something asked
       * to come back.
       *
       * TWO things do. The handoff page lives on `/connect/server/…`, and an
       * agent-minted PERMALINK can be any exact resource path plus its
       * `?project=` scope; both redirect HERE on `/callback`, and without
       * this the user arrives at the app shell having lost what they opened.
       *
       * In both cases the nonce is all that crossed the network — the path
       * itself was kept in same-origin storage, and each `take…` re-validates
       * it as same-origin on the way out before anything navigates. AuthKit's
       * default for this hook is a no-op, so nothing else changes by
       * supplying it.
       *
       * It runs AFTER the session is persisted (authkit-js sets session data,
       * then calls this), so navigating away here does not race the login.
       */
      onRedirectCallback={({ state }) => {
        const carried = state as Record<string, unknown> | null;
        const returnTo =
          takeHandoffSignInReturn(
            carried?.[HANDOFF_SIGN_IN_STATE_KEY],
            window.location.origin
          ) ??
          // An agent-minted permalink the visitor opened while signed out.
          // Without this they authenticate and land on the app shell, having
          // lost both the resource AND the `?project=` scope — the
          // wrong-project landing permalinks exist to prevent, reintroduced
          // at the last step.
          takePermalinkSignInReturn(
            carried?.[PERMALINK_SIGN_IN_STATE_KEY],
            window.location.origin
          );
        // `replace`, not `assign`: `/callback` is not somewhere the back
        // button should return to.
        if (returnTo) window.location.replace(returnTo);
      }}
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
        </StrictMode>
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
      // This branch replaces the whole app with a static screen — without a
      // report the failure is invisible outside the user's own console.
      reportCaught(error, { source: "session_token_bootstrap" });
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

    // Replay/surveys/exception bundles must be REGISTERED before the provider
    // initializes the SDK, or feature start falls back to the remote fetch
    // that Railway's edge blocks on hosted — see lib/posthog-bundled-extensions.ts.
    // No-op (and no chunk download) off the error-capture surfaces.
    await preloadPosthogBundledExtensions();

    root.render(
      <StrictMode>
        {/* OUTSIDE PostHogProvider on purpose: a crash while the provider
            initializes must still be caught and reported, and Sentry capture
            needs no React context. */}
        <ErrorBoundary name="root">
          <PostHogProvider
            apiKey={getPostHogKey()}
            options={getPostHogOptions()}
          >
            {Providers}
          </PostHogProvider>
        </ErrorBoundary>
      </StrictMode>
    );
  }

  bootstrap();
}
