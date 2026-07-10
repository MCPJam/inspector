import { getCachedGuestSession } from "./guest-session";

export const VITE_PUBLIC_POSTHOG_KEY =
  "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
export const VITE_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

// posthog-js talks to the same-origin /relay reverse proxy (server/routes/
// relay.ts) instead of *.posthog.com directly: ad blockers block PostHog by
// hostname, which drops events AND breaks feature-flag evaluation for
// blocker users. Same-origin works on every platform — hosted web, local
// npm, and packaged Electron are all served by the Hono server that hosts
// /relay; Vite dev (web and Electron renderer) proxies /relay to it.
export function getPostHogApiHost(): string {
  if (
    typeof window !== "undefined" &&
    window.location?.origin?.startsWith("http")
  ) {
    return `${window.location.origin}/relay`;
  }
  // Non-browser context (tests) — no relay origin to derive.
  return VITE_PUBLIC_POSTHOG_HOST;
}

// Guest identity bootstrap. Without it, posthog-js mints a random anonymous
// distinct_id at init and only converges on the guestId when
// usePostHogIdentify's async actor resolution calls identify() — every cold
// load that races that fetch creates a throwaway person and inflates guest
// DAU. In hosted prod the server injects the guest session into the page
// (window.__MCP_GUEST_BOOTSTRAP__, seeded synchronously into
// getCachedGuestSession at module import), so the guestId is known before
// PostHogProvider mounts. posthog-js handles the edge cases safely: an
// existing IDENTIFIED persisted id wins over the bootstrap value (returning
// signed-in users are untouched), and an existing anonymous id is merged
// into the bootstrap id via identify(). Local/npm has no blob — this
// returns {} there and the async identify path behaves as before.
function getPostHogBootstrap() {
  const guestId = getCachedGuestSession()?.guestId;
  return guestId
    ? { bootstrap: { distinctID: guestId, isIdentifiedID: true } }
    : {};
}

export const options = {
  api_host: getPostHogApiHost(),
  // Toolbar/app links must point at PostHog itself once api_host is proxied.
  ui_host: "https://us.posthog.com",
  ...getPostHogBootstrap(),
  capture_pageview: false,
  person_profiles: "always" as const,

  // Optional: Set static super properties that never change
  loaded: (posthog: any) => {
    posthog.register({
      environment: import.meta.env.MODE, // "development" or "production"
      platform: detectPlatform(),
      version: __APP_VERSION__,
    });
  },
};

// Check if PostHog should be disabled
export const isPostHogDisabled =
  import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true";

/** Normalize PostHog boolean flags (`useFeatureFlagEnabled` may not be strict `true` in dev). */
export function isPostHogBooleanFlagOn(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

// Conditional PostHog key and options
// Always use the real PostHog key so feature flags evaluate properly via /decide
export const getPostHogKey = () => VITE_PUBLIC_POSTHOG_KEY;
export const getPostHogOptions = () =>
  isPostHogDisabled
    ? {
        // Same relay host as the enabled branch — otherwise dev-mode /flags
        // calls hit us.i.posthog.com directly and stay ad-blocked.
        api_host: getPostHogApiHost(),
        ui_host: "https://us.posthog.com",
        ...getPostHogBootstrap(),
        capture_pageview: false,
        person_profiles: "always" as const,
        // Disable event capture but keep /decide enabled for feature flag evaluation.
        // Must be `opt_out_capturing_by_default` — `opt_out_capturing` is a method,
        // not a config field, so passing it here was silently ignored and dev
        // events flowed into prod PostHog from 2026-03-12 until this fix.
        opt_out_capturing_by_default: true,
      }
    : options;

export function detectPlatform() {
  // Check if running in hosted/web mode
  if (import.meta.env.VITE_MCPJAM_HOSTED_MODE === "true") {
    return "web";
  }

  // Check if running in Docker
  const isDocker =
    import.meta.env.VITE_DOCKER === "true" ||
    import.meta.env.VITE_RUNTIME === "docker";

  if (isDocker) {
    return "docker";
  }

  // Check if Electron
  const isElectron = (window as any)?.isElectron;

  if (isElectron) {
    // Detect OS within Electron using userAgent
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes("mac") || userAgent.includes("darwin")) {
      return "mac";
    } else if (userAgent.includes("win")) {
      return "win";
    }
    return "electron"; // fallback
  }

  // npm package running in browser
  return "npm";
}

export function detectEnvironment() {
  return import.meta.env.ENVIRONMENT;
}

export function standardEventProps(location: string) {
  return {
    location,
    platform: detectPlatform(),
    environment: detectEnvironment(),
  };
}
