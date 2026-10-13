/**
 * Security Headers Middleware
 *
 * Adds security headers to all responses:
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - X-XSS-Protection: Enables XSS filter
 * - Referrer-Policy: Controls referrer information
 * - Strict-Transport-Security: hosted HTTPS requests only, see below
 *
 * HTML documents also get a Permissions-Policy denying hardware and sensor
 * features nothing here uses, and a Content-Security-Policy (MJ-016):
 * - an ENFORCING policy limited to directives that cannot break the app:
 *   `frame-ancestors 'self'` (what X-Frame-Options already says) and no
 *   plugin content. It is inherited by srcdoc iframes, including MCP-UI
 *   rawHtml widgets, so it holds nothing a widget document may rely on;
 * - in hosted mode, a REPORT-ONLY policy describing the full intended source
 *   list, built from this deploy's runtime config. It blocks nothing; its
 *   reports are what a later enforcing policy gets tuned against. The app
 *   integrates with many external services (WorkOS, PostHog, Sentry, Convex,
 *   Stripe, MCP servers with OAuth), which is why it is not enforced yet.
 *   The header goes on every hosted response, documents and assets alike
 *   (MJ-016), but only a sampled share of responses
 *   carries the report-uri directive (CSP_REPORT_SAMPLE_RATE), which is what
 *   bounds how many violation reports page views produce — a report-only
 *   policy without a report endpoint only logs to the console. On documents,
 *   its script-src allows the inline scripts the server writes into the
 *   document through a per-response nonce (documentScriptNonce).
 *
 * A response that sets its own Content-Security-Policy (the MCP Apps sandbox
 * proxy does) keeps it: those routes know their framing rules better than a
 * global default does.
 */

import { randomBytes } from "node:crypto";
import type { Context, Next } from "hono";
import { HOSTED_MODE, SANDBOX_HOSTS } from "../config.js";
import { getInspectorClientRuntimeConfig } from "../env.js";
import { SENTRY_DSN } from "../../shared/sentry-config.js";

/** Enforced on every HTML document that does not set its own policy. */
export const DOCUMENT_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'self'; object-src 'none'";

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

/**
 * Share of hosted responses whose report-only policy carries report-uri,
 * which bounds how many violation reports page views produce. The policy
 * itself is on every hosted response.
 */
export const CSP_REPORT_SAMPLE_RATE = 0.05;

const DEFAULT_WORKOS_API_HOSTNAME = "api.workos.com";

// Stripe.js, per https://docs.stripe.com/security/guide#content-security-policy,
// plus the fraud-detection frame and telemetry hosts Stripe.js contacts.
const STRIPE_SCRIPT_SOURCES = [
  "https://js.stripe.com",
  "https://*.js.stripe.com",
  "https://maps.googleapis.com",
];
const STRIPE_FRAME_SOURCES = [
  "https://js.stripe.com",
  "https://*.js.stripe.com",
  "https://hooks.stripe.com",
  "https://m.stripe.network",
];
const STRIPE_CONNECT_SOURCES = [
  "https://api.stripe.com",
  "https://maps.googleapis.com",
  "https://r.stripe.com",
];

// Meticulous session recorder, per
// https://app.meticulous.ai/docs/session-recording/csp-exceptions. Only hosted
// builds that set METICULOUS_RECORDING_TOKEN load it.
const METICULOUS_SCRIPT_SOURCES = [
  "https://snippet.meticulous.ai",
  "https://browser.sentry-cdn.com",
];
const METICULOUS_FRAME_SOURCES = ["https://snippet.meticulous.ai"];
const METICULOUS_CONNECT_SOURCES = [
  "https://cognito-identity.us-west-2.amazonaws.com",
  "https://user-events-v3.s3-accelerate.amazonaws.com",
];

const scriptNonces = new WeakMap<Context, string>();

/**
 * The nonce for inline scripts a handler writes into this response's HTML
 * document; the same value on every call for one request. The report-only
 * policy's script-src allows scripts that carry it.
 */
export function documentScriptNonce(c: Context): string {
  let nonce = scriptNonces.get(c);
  if (!nonce) {
    nonce = randomBytes(16).toString("base64");
    scriptNonces.set(c, nonce);
  }
  return nonce;
}

/** `script` (an inline `<script>…</script>` element) carrying `nonce`. */
export function withScriptNonce(script: string, nonce: string): string {
  return script.replace(/^<script(?=[\s>])/i, `<script nonce="${nonce}"`);
}

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

type Directive = [name: string, sources: Iterable<string>];

function reportOnlyDirectives(
  runtimeConfig: ReturnType<typeof getInspectorClientRuntimeConfig>,
  sandboxHosts: ReadonlySet<string>,
  sentryDsn: string,
): Directive[] {
  const sentry = sentryCspTargets(sentryDsn);
  const workosHost =
    runtimeConfig.workosApiHostname ?? DEFAULT_WORKOS_API_HOSTNAME;
  const connectSources = new Set<string>([
    "'self'",
    ...convexSources(runtimeConfig.convexUrl),
    ...convexSources(runtimeConfig.convexSiteUrl),
    `https://${workosHost}`,
    ...(sentry ? [sentry.ingestOrigin] : []),
    ...STRIPE_CONNECT_SOURCES,
    ...METICULOUS_CONNECT_SOURCES,
  ]);
  const frameSources = new Set<string>(["'self'"]);
  for (const host of sandboxHosts) {
    frameSources.add(`https://${host}`);
    frameSources.add(`https://*.${host}`);
  }
  for (const source of [
    ...STRIPE_FRAME_SOURCES,
    "https://www.youtube.com",
    ...METICULOUS_FRAME_SOURCES,
  ]) {
    frameSources.add(source);
  }

  return [
    // The fallback for fetch directives not listed below (media-src, …);
    // report-only, so an unlisted source only produces a report.
    ["default-src", ["'self'"]],
    // 'unsafe-eval': JSON Schema validators (ajv) compile schemas at runtime
    // with `new Function`.
    [
      "script-src",
      [
        "'self'",
        "'unsafe-eval'",
        ...STRIPE_SCRIPT_SOURCES,
        ...METICULOUS_SCRIPT_SOURCES,
      ],
    ],
    [
      "style-src",
      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    ],
    ["font-src", ["https://fonts.gstatic.com", "data:"]],
    ["connect-src", connectSources],
    ["frame-src", frameSources],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["base-uri", ["'self'"]],
    ...(sentry ? ([["report-uri", [sentry.reportUri]]] as Directive[]) : []),
  ];
}

function renderPolicy(
  directives: Directive[],
  scriptNonce?: string,
  includeReportUri = true,
): string {
  return directives
    .filter(([name]) => includeReportUri || name !== "report-uri")
    .map(([name, iterable]) => {
      const sources = Array.from(iterable);
      if (name === "script-src" && scriptNonce) {
        sources.splice(1, 0, `'nonce-${scriptNonce}'`);
      }
      return `${name} ${sources.join(" ")}`;
    })
    .join("; ");
}

/**
 * The full intended policy, sent as Content-Security-Policy-Report-Only.
 * Inputs are process configuration, never the request, plus the response's
 * script nonce when the document has one.
 */
export function buildReportOnlyContentSecurityPolicy(
  runtimeConfig = getInspectorClientRuntimeConfig(),
  sandboxHosts: ReadonlySet<string> = SANDBOX_HOSTS,
  sentryDsn: string = SENTRY_DSN.client,
  scriptNonce?: string,
  includeReportUri = true,
): string {
  return renderPolicy(
    reportOnlyDirectives(runtimeConfig, sandboxHosts, sentryDsn),
    scriptNonce,
    includeReportUri,
  );
}

let reportOnlyBase: Directive[] | null = null;

function reportOnlyContentSecurityPolicy(
  scriptNonce: string | undefined,
  includeReportUri: boolean,
): string {
  reportOnlyBase ??= reportOnlyDirectives(
    getInspectorClientRuntimeConfig(),
    SANDBOX_HOSTS,
    SENTRY_DSN.client,
  );
  return renderPolicy(reportOnlyBase, scriptNonce, includeReportUri);
}

/** Test-only: drop the memoized report-only policy. */
export function resetContentSecurityPolicyForTests(): void {
  reportOnlyBase = null;
}

function isHtmlDocument(res: Response): boolean {
  return (res.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("text/html");
}

function setResponsePolicies(
  headers: Headers,
  isDocument: boolean,
  reportOnlyPolicy: string | null,
): void {
  if (isDocument) {
    headers.set("Content-Security-Policy", DOCUMENT_CONTENT_SECURITY_POLICY);
    if (!headers.has("Permissions-Policy")) {
      headers.set("Permissions-Policy", DOCUMENT_PERMISSIONS_POLICY);
    }
  }
  if (reportOnlyPolicy) {
    headers.set("Content-Security-Policy-Report-Only", reportOnlyPolicy);
  }
}

const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Whether the client reached the hosted deployment over HTTPS. TLS terminates
 * at the proxy, so `c.req.url` is `http://` internally and `x-forwarded-proto`
 * carries the scheme; across more than one hop it is a comma-separated list
 * whose first entry is the client-facing scheme. Hosted mode only: a local run
 * has no proxy, so there the header is whatever the client chose to send.
 */
function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

/**
 * Security headers middleware.
 * Adds standard security headers to all responses, the document policies
 * above to HTML responses, and (hosted) the report-only policy to every
 * response that does not carry its own Content-Security-Policy.
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

  // Hosted mode only. Browsers ignore STS received over plain HTTP (RFC 6797
  // §8.1), so http://localhost is unaffected either way. https://localhost is
  // not: a local run behind a TLS proxy would pin every service on localhost,
  // on any port, to HTTPS for the whole max-age.
  //
  // `includeSubDomains` is left off on purpose: it would cover every
  // *.mcpjam.com host, including the tunnel and sandbox subdomains, and one of
  // those not serving HTTPS becomes unreachable for the whole max-age. Widening
  // this, and preload, belong with the edge configuration rather than here.
  if (HOSTED_MODE && isHttpsRequest(c)) {
    c.header("Strict-Transport-Security", `max-age=${ONE_YEAR_SECONDS}`);
  }

  await next();

  const res = c.res;
  if (res.headers.has("Content-Security-Policy")) {
    return;
  }
  const isDocument = isHtmlDocument(res);
  const reportOnlyPolicy = HOSTED_MODE
    ? reportOnlyContentSecurityPolicy(
        isDocument ? scriptNonces.get(c) : undefined,
        Math.random() < CSP_REPORT_SAMPLE_RATE,
      )
    : null;
  if (!isDocument && !reportOnlyPolicy) {
    return;
  }
  try {
    setResponsePolicies(res.headers, isDocument, reportOnlyPolicy);
  } catch {
    // A response built from another Response (a proxied fetch) can carry
    // immutable headers; copy it into one whose headers can be set.
    const copy = new Response(res.body, res);
    setResponsePolicies(copy.headers, isDocument, reportOnlyPolicy);
    c.res = copy;
  }
}
