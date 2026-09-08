/**
 * Pure Sentry configuration factory shared by the four surfaces that init an
 * SDK: the browser client, the Hono server, the Electron main process, and the
 * Electron renderer (via the client bundle).
 *
 * Deliberately free of environment reads. Every surface resolves its own
 * `environment` / `release` / `deployment` from the API that is actually
 * truthful there (`import.meta.env` in the browser, `app.isPackaged` in
 * Electron main, `process.env` on the server) and hands the result in. That
 * keeps this module importable from all four bundles and makes the config
 * unit-testable without stubbing globals.
 */

/**
 * Where this install runs. `hosted` is app.mcpjam.com; `self_hosted` covers
 * npx, Docker, and the desktop app. Shipped as a Sentry tag so a quota spike
 * or a noisy issue can be attributed to a deployment shape rather than being
 * averaged across all of them.
 */
export type SentryDeployment = "hosted" | "self_hosted";

/**
 * Which build produced the bundle, shipped as Sentry's `dist`.
 *
 * Six independent builds publish into `inspector-client` under one bare
 * `release` (the app version), and `release` alone cannot tell their artifacts
 * apart — so Sentry resolves an event against whichever bundle it happens to
 * pick and symbolicates client frames onto files from a different build.
 * `dist` is the discriminator Sentry provides for exactly this, and it has to
 * be set on both sides: the SDK that reports and the upload that publishes the
 * maps.
 *
 * One entry per artifact set, not per platform-as-metadata — two builds that
 * are separately compiled need separate names even when their sources match:
 *
 * - `web`          Docker/Railway image, `dist/client`
 * - `npm`          published tarball, `dist/client`
 * - `desktop-mac`  mac installer's embedded-server UI, `dist/client`
 * - `desktop-win`  Windows installer's embedded-server UI, `dist/client`
 * - `electron-mac` mac Electron renderer, `.vite/renderer`
 * - `electron-win` Windows Electron renderer, `.vite/renderer`
 *
 * The mac and Windows jobs each build and upload their own `dist/client` AND
 * their own `.vite/renderer`; collapsing either pair back into one name
 * reintroduces the collision this exists to end. `electron-*` doubles as the
 * `dist` for the Electron MAIN bundle in the `inspector-electron` project,
 * where the same two-platform collision applies.
 *
 * `local` is the default for a build that names no surface (a contributor
 * checkout, or a self-hosted user building from source). Those have no
 * uploaded artifacts, and saying so is better than borrowing another build's.
 */
export const SENTRY_BUILD_SURFACES = [
  "web",
  "npm",
  "desktop-mac",
  "desktop-win",
  "electron-mac",
  "electron-win",
  "local",
] as const;

export type SentryBuildSurface = (typeof SENTRY_BUILD_SURFACES)[number];

export function isSentryBuildSurface(
  value: string,
): value is SentryBuildSurface {
  return (SENTRY_BUILD_SURFACES as readonly string[]).includes(value);
}

/**
 * The surfaces `client/vite.config.ts` may stamp, via `MCPJAM_BUILD_SURFACE`.
 *
 * Narrower than `SENTRY_BUILD_SURFACES` because that config only ever builds
 * `dist/client`. The Electron renderer is built by `vite.renderer.config.mts`,
 * which derives `electron-mac` / `electron-win` from `process.platform` and
 * never reads the env var — so accepting an `electron-*` value here would
 * stamp a `dist/client` bundle with the `dist` the renderer's own upload owns,
 * which is the artifact collision the discriminator exists to end.
 */
export const CLIENT_BUILD_SURFACES = [
  "web",
  "npm",
  "desktop-mac",
  "desktop-win",
  "local",
] as const satisfies readonly SentryBuildSurface[];

export type ClientBuildSurface = (typeof CLIENT_BUILD_SURFACES)[number];

function isClientBuildSurface(value: string): value is ClientBuildSurface {
  return (CLIENT_BUILD_SURFACES as readonly string[]).includes(value);
}

/**
 * Resolve the client bundle's `dist` from the env var the build passes.
 *
 * An unset value is a checkout that names no surface, which is `local`. An
 * unrecognised one throws: a typo would otherwise ship a bundle reporting a
 * `dist` no upload ever wrote, silently.
 */
export function resolveClientBuildSurface(
  value: string | undefined,
): ClientBuildSurface {
  const surface = value || "local";
  if (!isClientBuildSurface(surface)) {
    throw new Error(
      `MCPJAM_BUILD_SURFACE="${surface}" is not a client build surface (${CLIENT_BUILD_SURFACES.join(", ")})`,
    );
  }
  return surface;
}

/**
 * The Electron surface for a `process.platform`, shared by the renderer build
 * (which stamps the value in) and the main process (which reports it), so the
 * two cannot drift from each other or from what forge uploads.
 *
 * Only mac and Windows are released; any other platform is someone building
 * the desktop app themselves, and there are no uploaded artifacts for it.
 */
export function electronBuildSurface(platform: string): SentryBuildSurface {
  if (platform === "darwin") return "electron-mac";
  if (platform === "win32") return "electron-win";
  return "local";
}

export interface SentryConfigContext {
  dsn: string;
  environment: string;
  release?: string;
  dist?: SentryBuildSurface;
  deployment: SentryDeployment;
  /** Defaults to true. `false` short-circuits transport without unwiring init. */
  enabled?: boolean;
  tracesSampleRate?: number;
}

export interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  dist?: SentryBuildSurface;
  enabled: boolean;
  sendDefaultPii: false;
  tracesSampleRate: number;
  tracePropagationTargets: (string | RegExp)[];
  initialScope: { tags: { deployment: SentryDeployment } };
}

const TRACE_PROPAGATION_TARGETS: (string | RegExp)[] = [
  "localhost",
  /^\//, // All relative URLs (includes /api/*, /sse/message, /health, etc.)
  // Both ends are load-bearing. `[^/]*` before the suffix would admit
  // userinfo (`https://x.convex.cloud@evil.test/`) and other arbitrary
  // authority text, and no trailing boundary would admit
  // `https://x.convex.cloud.evil/`. Either way Sentry would attach trace +
  // baggage headers to an origin we do not control.
  /^https?:\/\/(?:[A-Za-z0-9-]+\.)+convex\.(?:cloud|site)(?::\d+)?(?:[/?#]|$)/,
];

/**
 * Browser noise that is never actionable: benign ResizeObserver loop notices
 * fired by virtualized lists, aborted fetches from unmounts/navigations, and
 * the four ways browsers spell "the network went away". Applied to the client
 * and Electron-renderer builders only — on the server these strings would
 * suppress real upstream failures.
 */
export const BROWSER_IGNORE_ERRORS: (string | RegExp)[] = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^AbortError/,
  "Failed to fetch",
  "NetworkError when attempting to fetch resource",
  "Load failed",
];

export function buildSentryConfig(ctx: SentryConfigContext): SentryConfig {
  return {
    dsn: ctx.dsn,
    environment: ctx.environment,
    ...(ctx.release ? { release: ctx.release } : {}),
    ...(ctx.dist ? { dist: ctx.dist } : {}),
    enabled: ctx.enabled ?? true,
    sendDefaultPii: false,
    tracesSampleRate: ctx.tracesSampleRate ?? 0.1,
    tracePropagationTargets: TRACE_PROPAGATION_TARGETS,
    initialScope: { tags: { deployment: ctx.deployment } },
  };
}

export const SENTRY_DSN = {
  client:
    "https://c9df3785c734acfe9dad2d0c1e963e28@o4510109778378752.ingest.us.sentry.io/4510111435063296",
  server:
    "https://ec309069e18ebe1d0be9088fa7bf56d9@o4510109778378752.ingest.us.sentry.io/4510112186433536",
  electron:
    "https://6a41a208e72267f181f66c47138f2b9d@o4510109778378752.ingest.us.sentry.io/4510112190431232",
} as const;

/** Replay sampling for the browser client. Kept here so tests can assert it. */
export const CLIENT_REPLAY_SAMPLE_RATES = {
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
} as const;

/**
 * Replay sampling when replay is NOT permitted on this surface. Sentry treats
 * 0 as "never sample", which is the off switch.
 */
export const REPLAY_DISABLED_SAMPLE_RATES = {
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
} as const;

export function buildClientSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & {
    dsn?: string;
    /**
     * Whether this surface may record session replays. Same policy as PostHog
     * (`isErrorCaptureSurface()`): hosted + packaged desktop only. Sentry
     * Replay captures DOM and text just like rrweb does, so shipping it to
     * every npx/Docker install would break the same boundary from the other
     * side. Defaults to false — replay is opt-in, per surface.
     */
    replayEnabled?: boolean;
  },
) {
  return {
    ...buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.client }),
    ignoreErrors: BROWSER_IGNORE_ERRORS,
    ...(ctx.replayEnabled
      ? CLIENT_REPLAY_SAMPLE_RATES
      : REPLAY_DISABLED_SAMPLE_RATES),
  };
}

export function buildElectronSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & { dsn?: string },
) {
  // No `ignoreErrors` here. This builds the config for the Electron MAIN
  // process, which is Node, not a browser: "Failed to fetch" / "Load failed"
  // there are real updater, auto-update, or startup network failures, and
  // filtering them would hide exactly the desktop crashes this is meant to
  // surface. The renderer gets the browser baseline via
  // `buildClientSentryConfig`.
  return buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.electron });
}

export function buildServerSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & { dsn?: string },
) {
  return buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.server });
}
