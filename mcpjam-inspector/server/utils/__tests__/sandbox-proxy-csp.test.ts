/**
 * Parity test: `buildSandboxProxyWidgetCsp` (Node) MUST produce byte-identical
 * output to the production `buildCSP` widget-declared branch that ships inline
 * in `sandbox-proxy.html`. This is what lets the eval harness inject the real
 * production policy; if the two ever drift, the harness silently regains the
 * false-positive class this guards against (e.g. allowing `eval()`).
 *
 * Same extraction approach as `server/__tests__/sandbox-proxy-buildCSP.test.ts`:
 * pull `sanitizeDomain` + `buildCSP` out of the HTML and evaluate them, so the
 * canonical function stays physically in the document it ships in.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSandboxProxyWidgetCsp } from "../sandbox-proxy-csp";
import type { WidgetCspMeta } from "../widget-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "..",
    "routes",
    "apps",
    "mcp-apps",
    "sandbox-proxy.html"
  ),
  "utf8"
);

// Extract a named function body from the inline <script>, brace-walking so
// reformatting of the HTML doesn't break the test.
function extract(name: string): string {
  const sig = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = sig.exec(html);
  if (!m) throw new Error(`Could not extract function ${name}`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const ch = html[i++];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) throw new Error(`Unbalanced braces in ${name}`);
  return html.slice(m.index, i);
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const proxyBuildCSP = new Function(
  "csp",
  "cspDirectives",
  `${extract("sanitizeDomain")}\n${extract(
    "buildCSP"
  )}\nreturn buildCSP(csp, cspDirectives);`
) as (csp: unknown, cspDirectives?: Record<string, string[]>) => string;

// The proxy's widget-declared branch reads camelCase domain arrays; map the
// SDK's snake_case WidgetCspMeta onto it (no base-uri in WidgetCspMeta).
function proxyWidgetCsp(meta: WidgetCspMeta): string {
  return proxyBuildCSP(
    {
      connectDomains: meta.connect_domains ?? [],
      resourceDomains: meta.resource_domains ?? [],
      frameDomains: meta.frame_domains ?? [],
      baseUriDomains: [],
    },
    undefined
  );
}

describe("buildSandboxProxyWidgetCsp — parity with sandbox-proxy.html", () => {
  const cases: Array<[string, WidgetCspMeta]> = [
    ["no declared domains", {}],
    ["connect only", { connect_domains: ["https://api.example.com"] }],
    ["resource only", { resource_domains: ["https://cdn.example.com"] }],
    ["frame only", { frame_domains: ["https://embed.example.com"] }],
    [
      "all three directives",
      {
        connect_domains: ["https://api.example.com", "wss://rt.example.com"],
        resource_domains: ["https://cdn.example.com"],
        frame_domains: ["https://embed.example.com"],
      },
    ],
    // Malformed/adversarial metadata must sanitize identically to the proxy.
    [
      "domain attempting CSP directive injection",
      { connect_domains: ["https://x; script-src 'unsafe-eval'"] },
    ],
    [
      "domain with attribute-breaking chars",
      {
        resource_domains: [
          'https://cdn.example.com"><s',
          "https://ok.example.com",
        ],
      },
    ],
  ];

  it.each(cases)(
    "matches the production policy byte-for-byte (%s)",
    (_label, meta) => {
      expect(buildSandboxProxyWidgetCsp(meta)).toBe(proxyWidgetCsp(meta));
    }
  );

  it("is strictly the production policy: no unsafe-eval, no self, default-src 'none'", () => {
    const csp = buildSandboxProxyWidgetCsp({
      connect_domains: ["https://api.example.com"],
      resource_domains: ["https://cdn.example.com"],
    });
    // The exact false-positive vectors the harness must not reintroduce:
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain("worker-src");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Inline scripts/styles still run; declared/inline resources still load.
    expect(csp).toContain(
      "script-src 'unsafe-inline' data: blob: https://cdn.example.com"
    );
    // connect is scoped to declared origins only.
    expect(csp).toContain("connect-src https://api.example.com");
  });

  it("strips CSP-breaking chars from domains so they can't inject a directive", () => {
    // Without sanitization, the ';' would start a real `script-src 'unsafe-eval'`
    // directive — re-enabling eval and producing a false-positive render.
    const csp = buildSandboxProxyWidgetCsp({
      connect_domains: ["https://x; script-src 'unsafe-eval'"],
    });
    expect(csp).not.toContain("'unsafe-eval'"); // quotes stripped → not the keyword
    // Exactly the 10-directive set: no extra ';' leaked from the domain.
    expect(csp.split(";")).toHaveLength(10);
    // The sanitized remnants stay INSIDE connect-src, not as their own directive.
    expect(csp).toContain("connect-src https://x script-src unsafe-eval");
  });

  it("falls back to 'none' for every undeclared directive (but keeps inline + data/blob)", () => {
    const csp = buildSandboxProxyWidgetCsp({});
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    // With no declared resource domains, inline content still works via
    // data:/blob: — but nothing external loads.
    expect(csp).toContain("script-src 'unsafe-inline' data: blob:");
    expect(csp).toContain("img-src data: blob:");
  });
});
