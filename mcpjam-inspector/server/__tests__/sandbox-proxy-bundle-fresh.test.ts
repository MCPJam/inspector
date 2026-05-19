/**
 * Sandbox Proxy bundle-freshness regression test.
 *
 * `server/routes/apps/SandboxProxyHtml.bundled.ts` is auto-generated from
 * `server/routes/apps/{mcp-apps,chatgpt-apps}/sandbox-proxy.html` by
 * `scripts/bundle-sandbox-proxy-html.js`. If the source HTML changes but
 * the bundle isn't regenerated, the proxy served to clients runs stale
 * code — silently, no type error, no runtime error until a behavior diff
 * surfaces. This test fails when that drift exists, telling the dev to
 * run `node scripts/bundle-sandbox-proxy-html.js`.
 *
 * Same shape of test as the compat-runtime bundle freshness check, just
 * applied to the proxy HTML pair.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const mcpAppsHtml = fs.readFileSync(
  path.join(repoRoot, "server/routes/apps/mcp-apps/sandbox-proxy.html"),
  "utf-8",
);
const chatgptAppsHtml = fs.readFileSync(
  path.join(repoRoot, "server/routes/apps/chatgpt-apps/sandbox-proxy.html"),
  "utf-8",
);
const bundledTs = fs.readFileSync(
  path.join(repoRoot, "server/routes/apps/SandboxProxyHtml.bundled.ts"),
  "utf-8",
);

describe("sandbox proxy bundle freshness", () => {
  it("MCP_APPS_SANDBOX_PROXY_HTML matches sandbox-proxy.html source", () => {
    const expected = JSON.stringify(mcpAppsHtml);
    expect(bundledTs).toContain(
      `export const MCP_APPS_SANDBOX_PROXY_HTML = ${expected};`,
    );
  });

  it("CHATGPT_APPS_SANDBOX_PROXY_HTML matches sandbox-proxy.html source", () => {
    const expected = JSON.stringify(chatgptAppsHtml);
    expect(bundledTs).toContain(
      `export const CHATGPT_APPS_SANDBOX_PROXY_HTML = ${expected};`,
    );
  });
});
