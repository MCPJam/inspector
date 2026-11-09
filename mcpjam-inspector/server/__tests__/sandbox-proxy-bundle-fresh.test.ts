/**
 * Sandbox Proxy bundle-freshness regression test.
 *
 * `server/routes/apps/SandboxProxyHtml.bundled.ts` is auto-generated from
 * `server/routes/apps/mcp-apps/sandbox-proxy.html` by
 * `scripts/bundle-sandbox-proxy-html.js`. If the source HTML changes but
 * the bundle isn't regenerated, the proxy served to clients runs stale
 * code — silently, no type error, no runtime error until a behavior diff
 * surfaces. This test fails when that drift exists, telling the dev to
 * run `node scripts/bundle-sandbox-proxy-html.js`.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("sandbox proxy bundle freshness", () => {
  it("MCP_APPS_SANDBOX_PROXY_HTML matches the HTML template and policy module", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts/bundle-sandbox-proxy-html.js"), "--check"],
        { cwd: repoRoot, stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});
