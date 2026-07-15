/**
 * sandbox-proxy-csp.ts — the production widget-declared CSP, available in Node.
 *
 * The MCP App eval harness mounts a widget in a headless iframe and must apply
 * the EXACT Content-Security-Policy the production sandbox proxy applies. If it
 * applies a more permissive policy, a render observation becomes a false
 * positive: a widget that relies on `eval()`, `<object>`, `base-uri`, or egress
 * to `'self'`/localhost could "render" in the harness yet be blocked by the
 * real widget-declared sandbox in production.
 *
 * The canonical policy lives inline in `routes/apps/mcp-apps/sandbox-proxy.html`
 * (`buildCSP`, the widget-declared branch) because it ships to the browser as
 * part of the proxy document. This module is the Node-side twin of that branch;
 * `__tests__/sandbox-proxy-csp.test.ts` extracts the real `buildCSP` from the
 * HTML and asserts this function is byte-identical, so the two cannot drift.
 *
 * Versus the SDK's `buildCspHeader("widget-declared", …)` (which is intentionally
 * looser, e.g. for response headers): this is `default-src 'none'`, NO
 * `'unsafe-eval'`, NO `'self'`/localhost, with explicit `object-src 'none'` and
 * `base-uri`, and no `worker-src`/`child-src`.
 */
import type { WidgetCspMeta } from "./widget-helpers";

/**
 * Mirror of `sandbox-proxy.html`'s `mergeDirective` with no inspector-override
 * (`cspDirectives`) tokens: order-preserving de-duplication, drop `'none'` once
 * any real token is present, and emit `<name> 'none'` for an empty token set.
 */
function directive(name: string, tokens: string[]): string {
  const merged: string[] = [];
  for (const t of tokens) {
    if (typeof t === "string" && t.length > 0 && !merged.includes(t)) {
      merged.push(t);
    }
  }
  if (merged.length > 1) {
    const noneAt = merged.indexOf("'none'");
    if (noneAt !== -1) merged.splice(noneAt, 1);
  }
  return merged.length === 0 ? `${name} 'none'` : `${name} ${merged.join(" ")}`;
}

/**
 * Strip characters that could break out of a CSP directive or the HTML
 * attribute it is injected into — an exact mirror of `sanitizeDomain` in
 * `sandbox-proxy.html`. Crucially this removes `;`: an unsanitized declared
 * origin like `https://x; connect-src *` would otherwise inject a second,
 * more-permissive directive (the upstream `normalizeWidgetCspMeta` does NOT
 * strip these). Applied to every domain so the harness can never end up more
 * permissive than production for malformed metadata.
 */
export function sanitizeProxyDomain(domain: string): string {
  if (typeof domain !== "string") return "";
  return domain.replace(/['"<>;]/g, "").trim();
}

/**
 * Build the widget-declared CSP string the production sandbox proxy injects for
 * a widget with this declared CSP metadata. Each domain is run through
 * {@link sanitizeProxyDomain} exactly as the proxy does at build time.
 */
export function buildSandboxProxyWidgetCsp(
  cspMeta?: WidgetCspMeta | null
): string {
  const connect = (cspMeta?.connect_domains ?? [])
    .map(sanitizeProxyDomain)
    .filter(Boolean);
  const resource = (cspMeta?.resource_domains ?? [])
    .map(sanitizeProxyDomain)
    .filter(Boolean);
  const frame = (cspMeta?.frame_domains ?? [])
    .map(sanitizeProxyDomain)
    .filter(Boolean);

  // data:/blob: are always allowed for inline content; declared resource
  // domains add to them. No forced CDNs and no 'self' (SEP-1865).
  const resourceTokens =
    resource.length > 0 ? ["data:", "blob:", ...resource] : ["data:", "blob:"];
  const connectTokens = connect.length > 0 ? connect : ["'none'"];
  const frameTokens = frame.length > 0 ? frame : ["'none'"];
  // WidgetCspMeta does not model base-uri, so it is always 'none' here. That
  // matches the proxy for widgets that declare no base-uri, and is otherwise
  // the strict direction — never more permissive than production.
  const baseUriTokens = ["'none'"];

  return [
    directive("default-src", ["'none'"]),
    directive("script-src", ["'unsafe-inline'", ...resourceTokens]),
    directive("style-src", ["'unsafe-inline'", ...resourceTokens]),
    directive("img-src", resourceTokens),
    directive("font-src", resourceTokens),
    directive("media-src", resourceTokens),
    directive("connect-src", connectTokens),
    directive("frame-src", frameTokens),
    directive("object-src", ["'none'"]),
    directive("base-uri", baseUriTokens),
  ].join("; ");
}
