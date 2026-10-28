/**
 * The fixed page the hosted-browser synthetic check opens.
 *
 * Served by this inspector because nothing stable outside it registers a
 * WebMCP tool. The test fixtures listen on loopback inside the test process.
 * The inspector's own app does publish tools, but which ones depends on the
 * whole SPA booting and on the screen it lands on, so a broken bundle would
 * page as a broken browser. The hosted browser runs in a cloud desktop, so it
 * reaches this page through the inspector's public URL, the same origin a
 * cloud harness uses.
 *
 * Outside /api on purpose: the browser fetching it presents no credential, and
 * sessionAuthMiddleware only guards /api/*. The page holds nothing but one
 * echo tool. The `empty` variant registers none, so an operator can force the
 * check to fail at the `tools` stage and see it page.
 */
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { resolveWebAuthorizedHarnessStrategy } from "../utils/harness/harness-proxy-strategy.js";

export type SyntheticPageVariant = "tools" | "empty";

const PAGE_PATHS: Record<SyntheticPageVariant, string> = {
  tools: "/synthetic/webmcp",
  empty: "/synthetic/webmcp-empty",
};

export const SYNTHETIC_TOOL_NAME = "mcpjam_synthetic_echo";

// `document.modelContext` is the current API; older pinned Chromium builds
// only had `navigator.modelContext`.
const REGISTER_SCRIPT = `(document.modelContext || navigator.modelContext).registerTool({
  name: "${SYNTHETIC_TOOL_NAME}",
  description: "Echoes its input. Used by MCPJam's hosted browser check.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  async execute(args) {
    return { content: [{ type: "text", text: String((args && args.text) || "") }] };
  },
});`;

// Nothing on the page loads from anywhere, so the policy allows only the one
// inline script, pinned by its hash.
const BASE_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SCRIPT_HASH = createHash("sha256")
  .update(REGISTER_SCRIPT)
  .digest("base64");

function renderPage(script: string | undefined): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MCPJam hosted browser check</title></head>
<body>
<p>MCPJam's hourly hosted browser check opens this page and lists its WebMCP tools.</p>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

const PAGES: Record<SyntheticPageVariant, { html: string; policy: string }> = {
  tools: {
    html: renderPage(REGISTER_SCRIPT),
    policy: `${BASE_POLICY}; script-src 'sha256-${SCRIPT_HASH}'`,
  },
  empty: { html: renderPage(undefined), policy: BASE_POLICY },
};

function send(c: Context, variant: SyntheticPageVariant): Response {
  const page = PAGES[variant];
  return c.body(page.html, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // WebMCP is only exposed to origin-isolated documents.
    "Origin-Agent-Cluster": "?1",
    "Content-Security-Policy": page.policy,
  });
}

/**
 * Where the hosted browser can load the page, or null when this inspector has
 * no public HTTPS URL a cloud desktop could reach.
 */
export function syntheticPageUrl(variant: SyntheticPageVariant): string | null {
  const strategy = resolveWebAuthorizedHarnessStrategy();
  if (strategy.plane !== "web-authorized" || strategy.mode !== "direct") {
    return null;
  }
  return `${strategy.publicBaseUrl.replace(/\/+$/, "")}${PAGE_PATHS[variant]}`;
}

export function registerSyntheticWebMcpPageRoutes(app: Hono): void {
  app.get("/synthetic/webmcp", (c) => send(c, "tools"));
  app.get("/synthetic/webmcp-empty", (c) => send(c, "empty"));
}
