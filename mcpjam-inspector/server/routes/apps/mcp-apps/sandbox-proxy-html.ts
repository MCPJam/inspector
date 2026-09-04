/**
 * One place that renders the MCP Apps sandbox-proxy document, for both the
 * local (`/api/apps/...`) and hosted (`/api/web/apps/...`) routes.
 *
 * Two things get templated into the HTML at serve time, and both must agree
 * with the `frame-ancestors` the route sends:
 *
 *   - the recorder shim, so the heavy unit-tested source lives in one TS
 *     module rather than a copy inside the HTML;
 *   - the host origins the proxy will accept messages from. The proxy is a
 *     document that receives untrusted widget HTML over `postMessage` and
 *     relays the widget's messages back out, so it has to know who the host
 *     legitimately is. Only the process knows which origins this deploy
 *     answers as, which is why the list is templated rather than inferred in
 *     the browser.
 */
import { CORS_ORIGINS, MCPJAM_HOSTED_ORIGIN } from "../../../config.js";
import { MCP_APPS_SANDBOX_PROXY_HTML } from "../SandboxProxyHtml.bundled.js";
import { RECORDER_SHIM_JS } from "./recorder-shim.js";

/**
 * Loopback origins that may frame the proxy and post to it.
 *
 * A port wildcard rather than a fixed port: the Vite dev server, the Hono
 * server and the Electron renderer each pick their own (the renderer's is
 * assigned at runtime), and all three are the host app on the same machine.
 */
export const SANDBOX_PROXY_LOCALHOST_PATTERNS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
];

/**
 * Origins the proxy accepts as the host, and the same list the route allows to
 * frame it. One source of truth on purpose: an origin that may frame the proxy
 * but may not talk to it produces a widget that renders and then silently does
 * nothing, which is the least debuggable of the possible mismatches.
 *
 * `'self'` is deliberately NOT here. It belongs in `frame-ancestors` (a
 * same-origin fallback deploy is documented), but as a message-sender rule it
 * would admit `location.origin` — and once views get their own per-app
 * subdomains the widget is same-origin with its proxy, so `'self'` would let
 * widget content pose as the host.
 */
export function sandboxProxyHostOriginPatterns(): string[] {
  const patterns = new Set<string>(SANDBOX_PROXY_LOCALHOST_PATTERNS);
  if (MCPJAM_HOSTED_ORIGIN.startsWith("https://")) {
    patterns.add(MCPJAM_HOSTED_ORIGIN);
  }
  for (const origin of CORS_ORIGINS) {
    if (origin.startsWith("https://")) {
      patterns.add(origin);
    }
  }
  return Array.from(patterns);
}

/** The `Content-Security-Policy` the proxy route sends. */
export function buildSandboxProxyFrameAncestors(
  patterns: string[] = sandboxProxyHostOriginPatterns(),
): string {
  return `frame-ancestors 'self' ${patterns.join(" ")}`;
}

let rendered: string | null = null;

/**
 * The proxy document with both placeholders replaced.
 *
 * Memoized because the inputs are process constants and the HTML is ~40KB.
 * The replacements use replacer FUNCTIONS so a `$&` or `$1` inside the shim
 * source or an origin can never be interpreted as a substitution pattern.
 *
 * Deliberately does not assert the placeholders exist: two route tests stub
 * the bundled module with `"<html></html>"`, and a serving helper that threw
 * on that would turn an unrelated test's fixture into a failure here.
 */
export function renderSandboxProxyHtml(): string {
  if (rendered !== null) return rendered;
  rendered = MCP_APPS_SANDBOX_PROXY_HTML.replace(
    '"__MCPJAM_RECORDER_SHIM__"',
    () => JSON.stringify(RECORDER_SHIM_JS),
  ).replace('"__MCPJAM_HOST_ORIGINS__"', () =>
    JSON.stringify(sandboxProxyHostOriginPatterns()),
  );
  return rendered;
}

/** Test-only: drop the memo so a `vi.mock` of the config is observable. */
export function resetSandboxProxyHtmlForTests(): void {
  rendered = null;
}
