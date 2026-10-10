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

import {
  credentialRouteTemplate,
  scrubCredentialUrl,
  scrubTelemetryEvent,
} from "./credential-urls";
import { isInjectedScriptException } from "./injected-script-frames";
import {
  describeShape,
  MAX_ERROR_TEXT_CHARS,
  scrubLogPayload,
  scrubLogText,
} from "./log-scrubber";

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
 *
 * String entries match by substring, so the bare-network spellings are
 * anchored: Chromium's "Failed to fetch dynamically imported module: <url>"
 * is a code-split chunk that no longer exists on the server, not the network
 * going away, and must keep reporting.
 */
export const BROWSER_IGNORE_ERRORS: (string | RegExp)[] = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^AbortError/,
  /^(?:TypeError: )?Failed to fetch$/,
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
 * with the SDK's `stepFailureFindingKey`, not on the message text. Why the
 * text is wrong in both directions, and what the key does instead, is written
 * once, on `stepFailureFindingKey`. It lives in the SDK next to the code that
 * writes these messages.
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
    return scrubSentryCredentials(
      groupOAuthDebuggerStepFailures(groupDomMutationConflicts(event)),
    );
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

/**
 * Minimal structural view of what a Node SDK attaches to an event ON ITS OWN:
 * the incoming request, the exception's text, a captured message. Declared
 * here for the same reason as `FingerprintableEvent`.
 */
export interface ScrubbableEvent extends FingerprintableEvent {
  message?: string;
  transaction?: string;
  logentry?: { message?: string; params?: unknown[] };
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    data?: unknown;
  };
}

/**
 * Request headers whose VALUES are kept. Every other header keeps its name —
 * "an Authorization header was present" is a diagnostic — and loses its value.
 */
const KEPT_REQUEST_HEADERS = new Set([
  "accept",
  "content-length",
  "content-type",
  "host",
  "origin",
  "user-agent",
]);

function stripQueryAndFragment(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return stripQueryAndFragment(url);
  }
}

/** `a=1&b=2` (or its object / pair-list spellings) → `a=[redacted]&b=[redacted]`. */
function queryParamNames(query: unknown): string | undefined {
  let names: string[] = [];
  if (typeof query === "string") {
    names = query
      .replace(/^\?/, "")
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=")[0] ?? "");
  } else if (Array.isArray(query)) {
    names = query.map((pair) => String(Array.isArray(pair) ? pair[0] : pair));
  } else if (query && typeof query === "object") {
    names = Object.keys(query);
  }
  return names.length > 0
    ? names.map((name) => `${scrubLogText(name, 40)}=[redacted]`).join("&")
    : undefined;
}

/**
 * The SDK captures up to ~10KB of the raw body and sends it as a string. Its
 * structure is the useful part; a body cut off mid-JSON (or not JSON at all)
 * can only report its length.
 */
function describeRequestBody(data: unknown): string {
  if (typeof data !== "string") return describeShape(data);
  try {
    return describeShape(JSON.parse(data));
  } catch {
    return describeShape(data);
  }
}

/**
 * The server-side `beforeSend`: take customer content out of what the Node SDK
 * attaches by itself, keep everything a triager reads.
 *
 * - `request.data`. The http integration attaches the incoming body to every
 *   error event — a chat turn's messages, a tool call's arguments — whatever
 *   `sendDefaultPii` says. It becomes a shape summary rather than being turned
 *   off: "this route got `{messages: array(14)…}`" still reproduces.
 * - `request.url` / `query_string` / `cookies` / `headers`. The path stays;
 *   query values, cookies and header values go.
 * - Exception and message text, capped and redacted like the log rows: an
 *   upstream error quotes URLs, response bodies and, now and then, a token.
 *   Grouping is by stack frames, which are untouched.
 * - `extra.__serialized__`, where the SDK dumps a thrown NON-Error object.
 *
 * Everything else in `extra` was already scrubbed by `logger.ts`, the
 * server's only capture path, and is left alone: a shape summary scrubbed
 * twice would collapse to `string(N)`.
 */
export function scrubServerSentryEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbable: ScrubbableEvent = event;

  for (const exception of scrubbable.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = scrubLogText(exception.value, MAX_ERROR_TEXT_CHARS);
    }
  }
  if (typeof scrubbable.message === "string") {
    scrubbable.message = scrubLogText(scrubbable.message, MAX_ERROR_TEXT_CHARS);
  }
  if (scrubbable.logentry) {
    const { message, params } = scrubbable.logentry;
    if (typeof message === "string") {
      scrubbable.logentry.message = scrubLogText(message, MAX_ERROR_TEXT_CHARS);
    }
    if (Array.isArray(params)) {
      scrubbable.logentry.params = params.map(describeShape);
    }
  }

  const request = scrubbable.request;
  if (request) {
    if (typeof request.url === "string") {
      request.url = scrubCredentialUrl(stripQueryAndFragment(request.url));
    }
    if (request.query_string !== undefined) {
      request.query_string = queryParamNames(request.query_string);
    }
    delete request.cookies;
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          KEPT_REQUEST_HEADERS.has(name.toLowerCase()) ? value : "[redacted]",
        ]),
      );
    }
    if (request.data !== undefined) {
      request.data = describeRequestBody(request.data);
    }
  }

  if (scrubbable.extra && "__serialized__" in scrubbable.extra) {
    scrubbable.extra.__serialized__ = scrubLogPayload(
      scrubbable.extra.__serialized__,
    );
  }
  if (typeof scrubbable.transaction === "string") {
    scrubbable.transaction = sentryTransactionTemplate(scrubbable.transaction);
  }
  return event;
}

/**
 * A transaction name with any credential path replaced by its template:
 * `GET /api/web/score/runs/<token>` → `GET /api/web/score/runs/:token`.
 * Keeps an HTTP method prefix if there is one.
 */
export function sentryTransactionTemplate(name: string): string {
  const match = /^([A-Z]+ )?(\/\S*)$/.exec(name);
  if (!match) return scrubCredentialUrl(name);
  const [, method = "", path] = match;
  const pathname = path.split(/[?#]/)[0];
  const template = credentialRouteTemplate(pathname);
  return template
    ? `${method}${template}`
    : `${method}${scrubCredentialUrl(path)}`;
}

/**
 * The last step of every Sentry hook on every surface: every credential out
 * of the whole event (`shared/credential-urls.ts`) — request URLs,
 * transaction names, span descriptions, breadcrumbs, exception text, tags,
 * contexts, extras — whatever the SDK or our own code put there.
 *
 * Fail closed. If the walker cannot finish, the URL-bearing fields are
 * deleted and the rest scrubbed; if even that fails, `null` drops the event.
 */
export function scrubSentryCredentials<T extends object>(event: T): T | null {
  return scrubTelemetryEvent(event);
}

/** Minimal structural view of a Sentry breadcrumb. */
export interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * How much of a console call's first argument survives. Enough for the label
 * (`"[chat] stream failed:"`), not for a payload interpolated after it.
 */
const CONSOLE_BREADCRUMB_MAX_CHARS = 120;

function describeConsoleCall(
  args: unknown[] | undefined,
  fallback: string | undefined,
): string {
  if (!args || args.length === 0) {
    return scrubLogText(fallback ?? "", CONSOLE_BREADCRUMB_MAX_CHARS);
  }
  const [first] = args;
  const head =
    typeof first === "string"
      ? scrubLogText(first, CONSOLE_BREADCRUMB_MAX_CHARS)
      : first instanceof Error
        ? `${first.name}: ${scrubLogText(first.message, CONSOLE_BREADCRUMB_MAX_CHARS)}`
        : describeShape(first);
  return args.length > 1 ? `${head} (+${args.length - 1} args)` : head;
}

/**
 * Every surface's `beforeBreadcrumb`.
 *
 * - `console`: the SDK joins EVERY argument into `message` and keeps the raw
 *   values in `data.arguments` — the payload someone logged while debugging.
 *   Level and category stay; the message becomes the first argument's label
 *   and an argument count.
 * - `http` / `fetch` / `xhr`: the query string and fragment always go. On the
 *   server (`"origin"`) the path goes too — outgoing requests there are to a
 *   customer's MCP server, and its host is what tells you which one. The
 *   browser (`"path"`) talks to its own API, whose paths are ours.
 * - `navigation`: the query goes (an OAuth callback carries `code`/`state`).
 * - Anything else: its message is redacted and capped.
 */
export function scrubSentryBreadcrumb<T extends ScrubbableBreadcrumb>(
  breadcrumb: T,
  urlDetail: "origin" | "path",
): T | null {
  const crumb: ScrubbableBreadcrumb = breadcrumb;
  const data = crumb.data;
  switch (crumb.category) {
    case "console": {
      const args = Array.isArray(data?.arguments) ? data.arguments : undefined;
      crumb.message = describeConsoleCall(args, crumb.message);
      crumb.data = {
        ...(data?.logger !== undefined ? { logger: data.logger } : {}),
        ...(args ? { argumentCount: args.length } : {}),
      };
      break;
    }
    case "http":
    case "fetch":
    case "xhr": {
      if (data && typeof data.url === "string") {
        data.url =
          urlDetail === "origin"
            ? originOf(data.url)
            : stripQueryAndFragment(data.url);
      }
      delete data?.["http.query"];
      delete data?.["http.fragment"];
      break;
    }
    case "navigation": {
      for (const key of ["from", "to"]) {
        const value = data?.[key];
        if (data && typeof value === "string") {
          data[key] = stripQueryAndFragment(value);
        }
      }
      break;
    }
    default:
      if (typeof crumb.message === "string") {
        crumb.message = scrubLogText(crumb.message, MAX_ERROR_TEXT_CHARS);
      }
  }
  // Every category, Electron's (`electron`) and any the SDK adds later
  // included: whatever URL a breadcrumb carries — `data.url`, `from`, `to` —
  // loses its credentials. A crumb that cannot be shown clean is dropped.
  return scrubSentryCredentials(breadcrumb) as T;
}

/** `beforeBreadcrumb` for the browser client and Electron renderer. */
export function scrubClientSentryBreadcrumb<T extends ScrubbableBreadcrumb>(
  breadcrumb: T,
): T | null {
  return scrubSentryBreadcrumb(breadcrumb, "path");
}

/** `beforeBreadcrumb` for the Node surfaces: the server and Electron main. */
export function scrubServerSentryBreadcrumb<T extends ScrubbableBreadcrumb>(
  breadcrumb: T,
): T | null {
  return scrubSentryBreadcrumb(breadcrumb, "origin");
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
    // Spans and transaction names carry request URLs (`GET /api/web/score/
    // runs/<token>`). Names are set to route templates at the source; this is
    // the backstop for everything else in a transaction.
    beforeSendTransaction: scrubSentryCredentials,
    // Console arguments are whatever a component logged — often a payload.
    beforeBreadcrumb: scrubClientSentryBreadcrumb,
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
