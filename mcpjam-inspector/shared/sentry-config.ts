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

import { isInjectedScriptException } from "./injected-script-frames";

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
  // The production deployment is also reachable on first-party custom domains
  // routed through our own Cloudflare zone: `rt.mcpjam.com` (Convex API) and
  // `rt-http.mcpjam.com` (HTTP actions). Same anchoring as above — the host is
  // matched exactly, so `rt.mcpjam.com.evil`, `x.rt.mcpjam.com` and userinfo
  // tricks all fall outside it.
  /^https?:\/\/rt(?:-http)?\.mcpjam\.com(?::\d+)?(?:[/?#]|$)/,
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

/**
 * Blink names the mutating method, so a match is a DOM mutation conflict and
 * nothing else.
 */
const BLINK_DOM_MUTATION_CONFLICT =
  /^Failed to execute '(?:removeChild|insertBefore)' on 'Node'/;

/*
 * WebKit's wording is deliberately NOT matched. It emits one generic sentence
 * for the whole `NotFoundError` class ("The object can not be found here."),
 * so a match cannot tell a DOM mutation conflict from an IndexedDB failure,
 * and nothing survives minification to separate them. Grouping on it would
 * make a storage bug unattributable to buy a collapse worth 4 of the 23
 * production events; the Blink wording carries the other 19. Frame-based
 * grouping is the better answer for the ambiguous ones.
 */

/**
 * Minimal structural view of the event `beforeSend` receives.
 *
 * Declared here rather than imported so this module keeps its "no SDK, no
 * globals" property — it is compiled into four bundles, two of which pull a
 * different Sentry package.
 */
export interface FingerprintableEvent {
  environment?: string;
  fingerprint?: string[];
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: { filename?: string; function?: string }[] };
    }[];
  };
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/**
 * Group DOM mutation conflicts by class instead of by stack.
 *
 * React reports these from `commitDeletionEffectsOnFiber`, so the frames are
 * all react-dom internals: a recursive `recursivelyTraverseMutationEffects` /
 * `commitMutationEffectsOnFiber` chain whose depth follows the component tree
 * and whose minified column offsets move with every build. Sentry fingerprints
 * on frames, so each occurrence lands in its own issue — 23 production events
 * of one bug arrived as nine issues of one to seven events, none of them big
 * enough to trip an alert, while a 394-event `dev` group with the same title
 * sat on top of the list. The billing crash in #4730 surfaced through a
 * PostHog alert instead, and only because that event happened to be the one
 * someone looked at.
 *
 * Matching on the exception type and message, not on frames: the prod frames
 * are minified to names like `mze`/`fg` with no `react-dom` string left to
 * test, and the message is the one part that survives minification.
 *
 * `environment` is part of the fingerprint because an issue spans
 * environments in Sentry, and dev is the larger share of this project's error
 * volume — collapsing without it would bury the production signal again.
 */
export function groupDomMutationConflicts<T extends FingerprintableEvent>(
  event: T,
): T {
  const exception = event.exception?.values?.[0];
  if (exception?.type !== "NotFoundError") return event;

  const value = exception.value ?? "";
  if (!BLINK_DOM_MUTATION_CONFLICT.test(value)) return event;

  event.fingerprint = ["dom-mutation-conflict", event.environment ?? "unknown"];
  return event;
}

/**
 * Group OAuth-debugger step failures by WHAT failed, not by where they were
 * reported.
 *
 * The inverse of the problem above. There, one bug's frames moved with every
 * build and scattered it across nine issues. Here, every step failure the
 * debugger has — a missing metadata document, a registration endpoint that
 * wants a token, a wrong client secret, a server answering 404 where MCP
 * requires 401 — is reported from the SAME line (`withStepFailureReporting` in
 * `debug-state-machine-adapter.ts` builds the `Error` there), so they share one
 * stack and Sentry files them all as one issue.
 *
 * INSPECTOR-CLIENT-2FE shows the cost. Titled "Dynamic Client Registration
 * failed (400)", its 9 events are five unrelated findings; the headline is one
 * of them. And because the bundle hash is in the frames, each release opens a
 * fresh catch-all issue — INSPECTOR-CLIENT-2F9 is the same bucket for the
 * previous build — so every deploy re-alerts on nothing new.
 *
 * Keyed on the step and `extra.finding`, which the reporting adapter computes
 * with the SDK's `stepFailureFindingKey` — not on the message text, which is
 * wrong in both directions:
 *
 * - Cut at its first sentence, it MERGES different failures: every era's
 *   machine reports `Could not discover authorization server metadata. …`,
 *   with what each well-known URL returned after the period.
 * - Whole, it SPLITS one failure: the server under test chooses part of it
 *   (status text, free-form `error_description`, URLs, ids), so one finding
 *   would open a new issue per server wording and per request, unbounded.
 *
 * The key strips exactly the known registration advisory, reduces response
 * failures to label, status and OAuth `error` code, and otherwise keeps the
 * full cause with URLs and ids replaced and the length capped. It lives in the
 * SDK because the SDK writes these messages; computed here, from text alone,
 * it would drift from them. (The first version of this rule cut at the first
 * sentence, and claimed that never merged different failures. It did.)
 *
 * A report without `finding` — none should exist, since the adapter and this
 * rule ship together — falls back to its message capped at the same length,
 * which splits rather than merges.
 *
 * `environment` for the same reason `groupDomMutationConflicts` carries it:
 * stack grouping kept dev and prod apart only by accident of their bundles, and
 * a message-keyed fingerprint would otherwise merge them.
 *
 * Only `oauth_debugger_step`. `oauth_debugger_advance` is a genuine exception
 * thrown out of the flow, and its stack is the useful part.
 */
export function groupOAuthDebuggerStepFailures<T extends FingerprintableEvent>(
  event: T,
): T {
  if (event.tags?.source !== "oauth_debugger_step") return event;

  const reported = event.extra?.finding;
  const finding =
    typeof reported === "string" && reported !== ""
      ? reported
      : (event.exception?.values?.[0]?.value ?? "").slice(0, 160);
  const step = event.extra?.step;

  event.fingerprint = [
    "oauth-debugger-step",
    typeof step === "string" && step !== "" ? step : "unknown",
    finding,
    event.environment ?? "unknown",
  ];
  return event;
}

/**
 * The browser `beforeSend`: drop injected-script crashes, then group the DOM
 * mutation conflicts and OAuth-debugger step failures that survive.
 *
 * Sentry keeps its own `window.onerror` handler — `initSentry()` passes an
 * `integrations` array without `defaultIntegrations: false`, so
 * `globalHandlersIntegration` stays on — and `BROWSER_IGNORE_ERRORS` carries
 * no entry for a stack overflow. Filtering only PostHog would leave Sentry
 * opening issues for the same non-bug, which is how INSPECTOR-CLIENT-2GD
 * arrived with its culprit set to a document route.
 *
 * Both reporters therefore share one rule (shared/injected-script-frames.ts)
 * rather than each getting a message string to ignore: a real stack overflow
 * in our own code has app frames and must still report from both.
 *
 * `origin` is the app's own origin, supplied by the caller. Omitted on a
 * surface that has no document, where nothing is dropped.
 */
export function buildBrowserBeforeSend(origin?: string) {
  return <T extends FingerprintableEvent>(event: T): T | null => {
    if (origin !== undefined) {
      const stacks = (event.exception?.values ?? []).map((value) => {
        const frames = value.stacktrace?.frames ?? [];
        return isSynthesizedInitialFrame(frames)
          ? []
          : frames.map((frame) => frame.filename);
      });
      if (isInjectedScriptException(stacks, origin)) return null;
    }
    return groupOAuthDebuggerStepFailures(groupDomMutationConflicts(event));
  };
}

/**
 * Is this stack just the frame Sentry invented because it had none?
 *
 * `globalHandlersIntegration` runs `_enhanceEventWithInitialFrame`, which
 * pushes `{ function: "?", filename: url || getLocationHref() }` — the
 * document URL — and does so ONLY when the parsed stack came back empty
 * (@sentry/browser 8.x, integrations/globalhandlers.js).
 *
 * A fabricated frame is not attribution. Without this the rule would invert
 * itself on the Sentry side: the frameless exceptions it promises to spare are
 * exactly the ones that reach `beforeSend` looking like a lone document frame,
 * so they would be the only ones it dropped.
 *
 * Both conditions are load-bearing. `stripSentryFramesAndReverse` gives any
 * nameless PARSED frame the same `"?"` placeholder, and the SDK only ever
 * fabricates into an empty array, so the count and the name together are what
 * separate an invention from a one-frame stack. A parsed lone `"?"` frame that
 * matches anyway only ever keeps the event: the value it empties counts as
 * unattributed (isInjectedScriptException), never as injected.
 */
function isSynthesizedInitialFrame(frames: { function?: string }[]): boolean {
  return frames.length === 1 && frames[0]?.function === "?";
}

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
    /**
     * The app's own origin, used to spot frames the browser stamped with the
     * document. The caller reads it — this module stays globals-free.
     */
    documentOrigin?: string;
  },
) {
  return {
    ...buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.client }),
    ignoreErrors: BROWSER_IGNORE_ERRORS,
    // Browser surfaces only. A `NotFoundError` on the server is an upstream
    // or storage failure that has nothing to do with DOM mutation, and
    // collapsing those by message would merge unrelated defects. The OAuth
    // debugger runs only in the browser client too.
    beforeSend: buildBrowserBeforeSend(ctx.documentOrigin),
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
