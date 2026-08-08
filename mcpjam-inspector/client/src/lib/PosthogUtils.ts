import { getCachedGuestSession } from "./guest-session";
import { HOSTED_MODE } from "./config";

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
// load that races that fetch attributes early events to a throwaway id and
// inflates guest DAU. In hosted prod the server injects the guest session
// into the page (window.__MCP_GUEST_BOOTSTRAP__, seeded synchronously into
// getCachedGuestSession at module import), so the guestId is known before
// PostHogProvider mounts.
//
// isIdentifiedID is deliberately FALSE: the bootstrap guestId seeds the
// ANONYMOUS distinct_id, not an identified person. This matters because the
// hosted document handler injects the guest blob for every allow-listed
// request — including the first load of a signed-in user whose PostHog
// persistence is empty. If we marked it identified, the subsequent
// usePostHogIdentify() call to identify(workosUserId) would run from an
// already-identified state and posthog-js would refuse the switch (no
// $identify merge), stranding that user's early events under the guest id.
// As anonymous, identify() correctly merges the pre-identify guest activity
// into the real actor: guests stay stably keyed on guestId (fixing DAU
// inflation), and signed-in users' events migrate onto their WorkOS id.
// A returning user with existing persistence keeps their stored id either
// way — bootstrap only seeds when persistence is empty. Local/npm has no
// blob, so this returns {} and the async identify path is unchanged.
function getPostHogBootstrap() {
  const guestId = getCachedGuestSession()?.guestId;
  return guestId
    ? { bootstrap: { distinctID: guestId, isIdentifiedID: false } }
    : {};
}

/**
 * A score result link is a bearer credential — the token in `/results/<token>`
 * is the only thing standing between a private run and anyone who has the URL.
 * Autocapture attaches `$current_url` to every captured event, so a single
 * click on that page would ship the credential to analytics, where it lands in
 * logs and exports that no one thinks of as secret-bearing. Replace the token
 * with a placeholder before anything leaves the browser; the path itself is
 * still useful, and the token never was.
 */
export function scrubSensitiveUrl(value: string): string {
  return value.replace(/(\/results\/)[^/?#]+/g, "$1[redacted]");
}

function sanitizeAnalyticsProperties(
  properties: Record<string, any>
): Record<string, any> {
  for (const key of ["$current_url", "$referrer", "$pathname"]) {
    if (typeof properties[key] === "string") {
      properties[key] = scrubSensitiveUrl(properties[key]);
    }
  }
  return properties;
}

// Public vanity landings (caniuse.dev host-compare, score.mcpjam.com score
// runner) get real Web Analytics: $pageview on SPA route changes plus
// $pageleave, which is what makes bounce rate and session duration exist in
// PostHog's Web Analytics tab. The app proper keeps pageviews OFF — track()
// events already cover it, and in-app route churn would be noise and event
// cost. Mirrors the server-side landing-host defaults (CANIUSE_LANDING_HOSTS /
// SCORE_LANDING_HOSTS in server/config.ts) — keep in sync when a vanity
// domain is added.
export const LANDING_ANALYTICS_HOSTS = new Set([
  "caniuse.dev",
  "www.caniuse.dev",
  "score.mcpjam.com",
  "www.score.mcpjam.com",
]);

export function getPageviewCaptureOptions(
  hostname: string | undefined = typeof window === "undefined"
    ? undefined
    : window.location?.hostname
) {
  const isLandingHost =
    !!hostname && LANDING_ANALYTICS_HOSTS.has(hostname.toLowerCase());
  return {
    capture_pageview: isLandingHost ? ("history_change" as const) : false,
    capture_pageleave: isLandingHost,
  };
}

export const options = {
  api_host: getPostHogApiHost(),
  // Toolbar/app links must point at PostHog itself once api_host is proxied.
  ui_host: "https://us.posthog.com",
  ...getPostHogBootstrap(),
  ...getPageviewCaptureOptions(),
  person_profiles: "always" as const,
  sanitize_properties: sanitizeAnalyticsProperties,

  // Optional: Set static super properties that never change
  loaded: (posthog: any) => {
    posthog.register({
      environment: import.meta.env.MODE, // "development" or "production"
      platform: detectPlatform(),
      version: __APP_VERSION__,
      // OSS self-hosted installs (including ones that never touch
      // app.mcpjam.com, e.g. airgapped lab VMs) share this project's key
      // with the hosted app. `deployment` is the clean discriminator between
      // the two going forward — see PosthogUtils.ts module docs for the
      // relay rationale that put every install in the same project.
      deployment: HOSTED_MODE ? "hosted" : "self_hosted",
      // Symmetric with the server-side `source: "server"` stamp
      // (convex/posthog.ts, server/utils/analytics.ts) — client events
      // previously carried no `source` at all.
      source: "client",
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
        ...getPageviewCaptureOptions(),
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
  // Vite's envPrefix is "VITE_" (vite.renderer.config.mts), so the
  // unprefixed `ENVIRONMENT` from .env.production is never replaced into
  // the client bundle and this always read as undefined — silently
  // clobbering the registered `environment` super-property on every
  // track() call (see standardEventProps below). `VITE_ENVIRONMENT` is the
  // client-visible counterpart; it stays unset for ordinary dev/prod builds
  // (MODE already covers that split) and is set explicitly for builds that
  // need a finer-grained label (e.g. staging).
  return import.meta.env.VITE_ENVIRONMENT;
}

export function standardEventProps(location: string): {
  location: string;
  platform: string;
  environment?: string;
} {
  const environment = detectEnvironment();
  return {
    location,
    platform: detectPlatform(),
    // Omit rather than send `environment: undefined` — an explicit
    // undefined key still overrides the registered super-property when
    // merged into the captured event, which is exactly the bug this
    // guards against.
    ...(environment !== undefined ? { environment } : {}),
  };
}
