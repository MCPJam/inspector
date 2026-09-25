/**
 * Security Headers Middleware
 *
 * Adds security headers to all responses:
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - X-XSS-Protection: Enables XSS filter
 * - Referrer-Policy: Controls referrer information
 * - Strict-Transport-Security: HTTPS requests only, see below
 *
 * HTML documents also get a Permissions-Policy denying hardware and sensor
 * features nothing here uses, and a Content-Security-Policy (MJ-016):
 * - an ENFORCING policy limited to directives that cannot break the app:
 *   `frame-ancestors 'self'` (what X-Frame-Options already says), no plugin
 *   content, and no `<base>` pointing elsewhere;
 * - in hosted mode, a REPORT-ONLY policy describing the full intended source
 *   list, built from this deploy's runtime config. It blocks nothing; its
 *   reports are what a later enforcing policy gets tuned against. The app
 *   integrates with many external services (WorkOS, PostHog, Sentry, Convex,
 *   Stripe, MCP servers with OAuth), which is why it is not enforced yet.
 *
 * A response that sets its own Content-Security-Policy (the MCP Apps sandbox
 * proxy does) keeps it: those routes know their framing rules better than a
 * global default does.
 */

import type { Context, Next } from "hono";
import { HOSTED_MODE, SANDBOX_HOSTS } from "../config.js";
import { getInspectorClientRuntimeConfig } from "../env.js";
import { SENTRY_DSN } from "../../shared/sentry-config.js";

/** Enforced on every HTML document that does not set its own policy. */
export const DOCUMENT_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

/**
 * Denied on every HTML document (MJ-016). Only hardware and sensor features
 * nothing in the app or its embeds uses: the SEP-1865 sandbox grants (camera,
 * microphone, geolocation, clipboard-write) and media features (fullscreen,
 * autoplay, payment, picture-in-picture) are deliberately UNLISTED, so the
 * per-resource iframe `allow=` grants MCP Apps rely on keep their defaults.
 * An unlisted feature is unaffected by this header; a listed one is denied
 * for the document and every descendant iframe, which is why only
 * never-used features may appear here.
 */
export const DOCUMENT_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "bluetooth=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "midi=()",
  "serial=()",
  "screen-wake-lock=()",
  "usb=()",
  "window-management=()",
].join(", ");

const DEFAULT_WORKOS_API_HOSTNAME = "api.workos.com";

function originOf(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `https://…` and the matching `wss://…` for a Convex origin. */
function convexSources(value: string | undefined): string[] {
  const url = originOf(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return [];
  }
  const socket = url.protocol === "https:" ? "wss:" : "ws:";
  return [url.origin, `${socket}//${url.host}`];
}

/** The Sentry ingest origin and the CSP report endpoint for a DSN. */
export function sentryCspTargets(
  dsn: string,
): { ingestOrigin: string; reportUri: string } | null {
  const url = originOf(dsn);
  const projectId = url?.pathname.replace(/^\/+|\/+$/g, "");
  if (!url || !url.username || !projectId) return null;
  return {
    ingestOrigin: url.origin,
    reportUri: `${url.origin}/api/${projectId}/security/?sentry_key=${url.username}`,
  };
}

/**
 * The full intended policy, sent as Content-Security-Policy-Report-Only.
 * Inputs are process configuration, never the request.
 */
export function buildReportOnlyContentSecurityPolicy(
  runtimeConfig = getInspectorClientRuntimeConfig(),
  sandboxHosts: ReadonlySet<string> = SANDBOX_HOSTS,
  sentryDsn: string = SENTRY_DSN.client,
): string {
  const sentry = sentryCspTargets(sentryDsn);
  const workosHost =
    runtimeConfig.workosApiHostname ?? DEFAULT_WORKOS_API_HOSTNAME;
  const connectSources = new Set<string>([
    "'self'",
    ...convexSources(runtimeConfig.convexUrl),
    ...convexSources(runtimeConfig.convexSiteUrl),
    `https://${workosHost}`,
    ...(sentry ? [sentry.ingestOrigin] : []),
    "https://api.stripe.com",
  ]);
  const frameSources = new Set<string>(["'self'"]);
  for (const host of sandboxHosts) {
    frameSources.add(`https://${host}`);
    frameSources.add(`https://*.${host}`);
  }
  for (const source of [
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://www.youtube.com",
  ]) {
    frameSources.add(source);
  }

  const directives: Array<[string, Iterable<string>]> = [
    ["script-src", ["'self'", "https://js.stripe.com"]],
    [
      "style-src",
      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    ],
    ["font-src", ["https://fonts.gstatic.com", "data:"]],
    ["connect-src", connectSources],
    ["frame-src", frameSources],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["worker-src", ["'self'", "blob:"]],
    ...(sentry
      ? ([["report-uri", [sentry.reportUri]]] as Array<
          [string, Iterable<string>]
        >)
      : []),
  ];
  return directives
    .map(([name, sources]) => `${name} ${Array.from(sources).join(" ")}`)
    .join("; ");
}

let reportOnlyPolicy: string | null = null;

function reportOnlyContentSecurityPolicy(): string {
  reportOnlyPolicy ??= buildReportOnlyContentSecurityPolicy();
  return reportOnlyPolicy;
}

/** Test-only: drop the memoized report-only policy. */
export function resetContentSecurityPolicyForTests(): void {
  reportOnlyPolicy = null;
}

function isHtmlDocument(res: Response): boolean {
  return (res.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("text/html");
}

function setDocumentPolicies(headers: Headers, hosted: boolean): void {
  headers.set("Content-Security-Policy", DOCUMENT_CONTENT_SECURITY_POLICY);
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", DOCUMENT_PERMISSIONS_POLICY);
  }
  if (hosted) {
    headers.set(
      "Content-Security-Policy-Report-Only",
      reportOnlyContentSecurityPolicy(),
    );
  }
}

const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Whether the request reached us over HTTPS, trusting `x-forwarded-proto` first
 * because the hosted deployment terminates TLS at the proxy. The header is a
 * comma-separated list when it crosses more than one hop; the client-facing
 * scheme is the first entry.
 */
function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Security headers middleware.
 * Adds standard security headers to all responses, and the document policies
 * above to HTML responses.
 */
export async function securityHeadersMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  c.header("X-Content-Type-Options", "nosniff");
  // Use SAMEORIGIN instead of DENY to allow widget sandboxed iframes
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Only ever sent over HTTPS. The inspector also runs locally on
  // http://localhost, and a browser that sees HSTS there pins *every* service
  // on localhost to HTTPS — not just this port — which outlives the dev server
  // and is not cleared by reloading.
  //
  // `includeSubDomains` is left off on purpose: it would cover every
  // *.mcpjam.com host, including the tunnel and sandbox subdomains, and one of
  // those not serving HTTPS becomes unreachable for the whole max-age. Widening
  // this, and preload, belong with the edge configuration rather than here.
  if (isHttpsRequest(c)) {
    c.header("Strict-Transport-Security", `max-age=${ONE_YEAR_SECONDS}`);
  }

  await next();

  const res = c.res;
  if (!isHtmlDocument(res) || res.headers.has("Content-Security-Policy")) {
    return;
  }
  try {
    setDocumentPolicies(res.headers, HOSTED_MODE);
  } catch {
    // A response built from another Response (a proxied fetch) can carry
    // immutable headers; copy it into one whose headers can be set.
    const copy = new Response(res.body, res);
    setDocumentPolicies(copy.headers, HOSTED_MODE);
    c.res = copy;
  }
}
