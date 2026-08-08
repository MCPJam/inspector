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

export interface SentryConfigContext {
  dsn: string;
  environment: string;
  release?: string;
  deployment: SentryDeployment;
  /** Defaults to true. `false` short-circuits transport without unwiring init. */
  enabled?: boolean;
  tracesSampleRate?: number;
}

export interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  enabled: boolean;
  sendDefaultPii: false;
  tracesSampleRate: number;
  tracePropagationTargets: (string | RegExp)[];
  initialScope: { tags: { deployment: SentryDeployment } };
}

const TRACE_PROPAGATION_TARGETS: (string | RegExp)[] = [
  "localhost",
  /^\//, // All relative URLs (includes /api/*, /sse/message, /health, etc.)
  /^https?:\/\/[^/]*\.convex\.(cloud|site)/, // Convex backend
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

export function buildClientSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & { dsn?: string },
) {
  return {
    ...buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.client }),
    ignoreErrors: BROWSER_IGNORE_ERRORS,
    ...CLIENT_REPLAY_SAMPLE_RATES,
  };
}

export function buildElectronSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & { dsn?: string },
) {
  return {
    ...buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.electron }),
    ignoreErrors: BROWSER_IGNORE_ERRORS,
  };
}

export function buildServerSentryConfig(
  ctx: Omit<SentryConfigContext, "dsn"> & { dsn?: string },
) {
  return buildSentryConfig({ ...ctx, dsn: ctx.dsn ?? SENTRY_DSN.server });
}
