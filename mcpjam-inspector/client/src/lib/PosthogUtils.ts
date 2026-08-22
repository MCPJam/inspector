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
    // `/tlm`, not `/relay`: Railway's edge in front of the hosted app 403s
    // GETs under `/relay/static/*` and `/relay/array/*` (block is scoped to
    // the /relay prefix — verified with decoy-prefix probes), which starved
    // posthog-js of its remote config and kept session recording `disabled`.
    // The server mounts the same proxy on both prefixes; see
    // RELAY_MOUNT_PREFIXES in server/routes/relay.ts.
    return `${window.location.origin}/tlm`;
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
// Every path whose LAST segment is a bearer credential. Autocapture attaches
// `$current_url` to each event, so a share viewer's address bar would ship the
// redeem token to PostHog on every click if these were not redacted.
const CREDENTIAL_PATH_PREFIXES = [
  "/results/",
  "/conformance/shared/",
  "/evals/shared/",
];

export function scrubSensitiveUrl(value: string): string {
  let out = value;
  for (const prefix of CREDENTIAL_PATH_PREFIXES) {
    const escaped = prefix.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
    out = out.replace(new RegExp(`(${escaped})[^/?#]+`, "g"), "$1[redacted]");
  }
  return out;
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

// Check if PostHog should be disabled
export const isPostHogDisabled =
  import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true";

/**
 * Whether this surface records session replays and captures exceptions.
 *
 * Hosted (app.mcpjam.com) and the packaged desktop app only. npx/Docker
 * installs run on someone else's machine against their own MCP servers —
 * recording those sessions is not ours to do, and the volume from every OSS
 * install would swamp the quota that makes hosted replay useful.
 */
export function isErrorCaptureSurface(): boolean {
  return HOSTED_MODE || isPackagedDesktop();
}

/**
 * A *shipped* desktop build, as opposed to `electron-forge start`.
 *
 * `src/preload.ts` exposes `isElectron: true` unconditionally, so it cannot
 * tell a packaged app from a developer's local run. `import.meta.env.PROD`
 * can: the dev renderer is served by the vite dev server, the packaged one is
 * a `vite build` output. Without this check every `electron-forge start`
 * session would stream renderer DOM and text into the production Sentry and
 * PostHog projects — and the boundary this file documents is *packaged*
 * desktop, not "anything with a preload attached".
 *
 * `HOSTED_MODE` needs no equivalent: it comes from `VITE_MCPJAM_HOSTED_MODE`,
 * which only the deployed bundle's config sets.
 */
function isPackagedDesktop(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== "undefined" &&
    (window as unknown as { isElectron?: boolean }).isElectron === true
  );
}

/**
 * Replay masking.
 *
 * `maskAllInputs` covers every `<input>`. The inspector also renders secrets
 * as TEXT — OAuth access/refresh tokens in the flow logger, the one-time API
 * key reveal, the SDK quickstart snippet — which no input-level masking can
 * reach. Those already carry this repo's `ph-no-capture rr-block` +
 * `data-ph-no-capture` convention for autocapture, so `maskTextSelector`
 * points at the SAME attribute rather than introducing a second thing to
 * remember: annotate a credential surface once and it is opted out of
 * autocapture AND masked in replay.
 */
export const SECRET_SURFACE_ATTRIBUTE = "data-ph-no-capture";

export const SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  maskTextSelector: `[${SECRET_SURFACE_ATTRIBUTE}]`,
} as const;

/**
 * `/results/<token>` is a bearer-credential URL — the token IS the auth. We
 * already redact it out of event properties (`scrubSensitiveUrl`), but a
 * replay of that page would capture the address bar's contents in the DOM
 * snapshot regardless. Don't record there at all.
 */
export function isCredentialBearingPath(
  pathname: string | undefined = typeof window === "undefined"
    ? undefined
    : window.location?.pathname
): boolean {
  return !!pathname && (
    pathname.startsWith("/results/") ||
    pathname.startsWith("/conformance/shared/") ||
    pathname.startsWith("/evals/shared/")
  );
}

export function shouldRecordSession(): boolean {
  return isErrorCaptureSurface() && !isCredentialBearingPath();
}

/**
 * Enforce the credential-path carve-out at RUNTIME.
 *
 * `disable_session_recording` is an init-time option, so it only covers a
 * session that *loads* on `/results/<token>`. `/results/:runToken` is an
 * in-app route: a user who lands anywhere else and then follows a results
 * link already has an active recorder, and rrweb snapshots the address bar.
 * Call this on navigation so the token-bearing page is never in a replay.
 *
 * Never throws — this is a privacy guard on a render path, and posthog-js may
 * be ad-blocked or uninitialized.
 */
let recordingStoppedByGuard = false;

export function syncSessionRecordingForPath(
  posthogClient: {
    startSessionRecording?: () => void;
    stopSessionRecording?: () => void;
    sessionRecordingStarted?: () => boolean;
  },
  pathname: string,
): void {
  try {
    if (!isErrorCaptureSurface()) return;
    if (isCredentialBearingPath(pathname)) {
      // Arm the resume only if the recorder was ACTUALLY running. The build
      // flag is not a proxy for that: PostHog's own project-side sampling can
      // decline a session, and resuming one it declined would both break
      // sampling and cost quota.
      //
      // Never DISARM here — `stop()` makes the probe read false, so
      // `/results/a` → `/results/b` would otherwise forget that this guard is
      // what stopped the recorder and the exit would never resume it.
      // `stop()` itself stays unconditional: it is idempotent, and an SDK
      // build without the probe must still stop on a credential path.
      if (posthogClient.sessionRecordingStarted?.()) {
        recordingStoppedByGuard = true;
      }
      posthogClient.stopSessionRecording?.();
      return;
    }
    // Resume ONLY what this guard itself stopped. Starting on every
    // non-credential path would undo `VITE_DISABLE_POSTHOG_LOCAL` on the first
    // navigation — silently recording in a build documented as having it off —
    // and would force a recorder on for a session sampling never selected.
    if (recordingStoppedByGuard) {
      recordingStoppedByGuard = false;
      posthogClient.startSessionRecording?.();
    }
  } catch {
    // A failed guard must not break the render. Recording stays as-is.
  }
}

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

  // Rageclick's quieter sibling: a click on something that looks
  // interactive and does nothing. Cheap (no extra network calls) and safe
  // on every platform, so it is not gated like replay/exceptions.
  capture_dead_clicks: true,

  // Getters, not eager calls. `options` is a module-scope literal, so calling
  // these at literal-creation time made merely IMPORTING this module read
  // `HOSTED_MODE` — which broke every test that partially mocks
  // `@/lib/config` (62 files do). Getters defer the read to property access,
  // which is when posthog-js actually reads config.

  // Uncaught errors and unhandled rejections -> `$exception`, which is what
  // feeds PostHog Error Tracking. Boundary-caught errors reach it through
  // lib/error-reporting.ts instead, so there is no double-count.
  get capture_exceptions() {
    return isErrorCaptureSurface();
  },
  get disable_session_recording() {
    return !shouldRecordSession();
  },
  session_recording: SESSION_RECORDING_OPTIONS,

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
    // Super properties ride EVENTS; `/flags` evaluates PERSON properties, so a
    // registered `deployment` is invisible to flag targeting. This makes the
    // same discriminator usable in a flag rule (e.g. rolling the local computer
    // engine out to the self-hosted signed-in cohort) from the first request of
    // the session, before any identify has run.
    // Guarded: `loaded` also runs against partial posthog stand-ins (tests, and
    // any host that pins an older posthog-js without this method). Flag
    // targeting degrading to "no person properties" is acceptable; throwing
    // inside `loaded` would take out the whole analytics init.
    posthog.setPersonPropertiesForFlags?.({
      deployment: HOSTED_MODE ? "hosted" : "self_hosted",
      platform: detectPlatform(),
    });
  },
};

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
        // Explicitly off in the opt-out branch too. `opt_out_capturing_by_default`
        // suppresses event SENDING but the recorder and the exception handlers
        // still load — which in dev means fetching /relay/static/recorder.js on
        // every page load for events that are then discarded.
        disable_session_recording: true,
        capture_exceptions: false,
        // Disable event capture but keep /decide enabled for feature flag evaluation.
        // Must be `opt_out_capturing_by_default` — `opt_out_capturing` is a method,
        // not a config field, so passing it here was silently ignored and dev
        // events flowed into prod PostHog from 2026-03-12 until this fix.
        opt_out_capturing_by_default: true,
        // This branch keeps /decide ON for flag evaluation, so it needs the flag
        // PERSON properties too — otherwise a `deployment = self_hosted` rule
        // targets nobody in exactly the local build someone would use to test
        // that rollout.
        loaded: (posthog: any) => {
          posthog.setPersonPropertiesForFlags?.({
            deployment: HOSTED_MODE ? "hosted" : "self_hosted",
            platform: detectPlatform(),
          });
        },
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
