import { isErrorCaptureSurface, isPostHogDisabled } from "./PosthogUtils";

/**
 * Compile PostHog's lazy-loaded feature code into our own build instead of
 * letting posthog-js fetch it at runtime.
 *
 * By default the SDK downloads replay (`posthog-recorder.js`), surveys,
 * exception autocapture, and dead-clicks autocapture from its `api_host` —
 * which we point at the same-origin `/relay` proxy. On app.mcpjam.com those
 * `GET /relay/static/*.js` fetches are 403'd by Railway's edge (NOT our
 * Cloudflare zone — its WAF skip rule is in place and logs Skip events), so
 * replay, surveys, and exception capture silently never activated on the one
 * surface they matter most. Events were unaffected: small POSTs to
 * `/relay/e/` pass the same edge.
 *
 * Importing the `posthog-js/dist/*` bundles registers each feature on
 * `window.__PosthogExtensions__` (`rrweb`/`initSessionRecording`,
 * `generateSurveys`, `errorWrappingFunctions`,
 * `initDeadClicksAutocapture`, `postHogWebVitalsCallbacks`), and the SDK
 * uses a registered extension
 * instead of calling `loadExternalDependency` — verified against the
 * installed posthog-js build. Because the bundles ship in the SAME package
 * version as the SDK consuming them, the registration keys cannot drift.
 *
 * Dynamic imports, not static: Vite splits them into chunks served from our
 * `/assets/` path (which every edge already lets through, or the app itself
 * wouldn't load), and only the error-capture surfaces pay the download —
 * npx/Docker installs keep today's lazy loading, which works on their own
 * origins.
 *
 * Must complete BEFORE `PostHogProvider` initializes the SDK: registration is
 * checked at feature start, and losing the race would fall back to the
 * blocked remote fetch.
 */
export async function preloadPosthogBundledExtensions(): Promise<void> {
  // The dev opt-out branch runs with replay/exceptions off; fetching four
  // chunks there would be pure waste.
  if (isPostHogDisabled || !isErrorCaptureSurface()) return;
  try {
    await Promise.all([
      import("posthog-js/dist/posthog-recorder"),
      import("posthog-js/dist/surveys"),
      import("posthog-js/dist/exception-autocapture"),
      import("posthog-js/dist/dead-clicks-autocapture"),
      import("posthog-js/dist/web-vitals"),
    ]);
  } catch {
    // Analytics must never block boot. On a failed chunk load posthog-js
    // falls back to its normal remote lazy loading — no worse than today.
  }
}
