/**
 * Sandbox Proxy buildCSP merge-rule tests.
 *
 * `buildCSP` lives inline in `sandbox-proxy.html` (it runs in the proxy
 * iframe, not Node). To unit-test the merge rule (domain-derived tokens
 * unioned with `cspDirectives` overrides, with `'none'` dropped when any
 * other token is present), we read the HTML, extract the function source,
 * and evaluate it in a sandbox via the `Function` constructor.
 *
 * Keeps the function physically in the HTML (where it ships to the
 * browser) while still letting us assert on the merge contract.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "routes",
    "apps",
    "mcp-apps",
    "sandbox-proxy.html",
  ),
  "utf8",
);

// Extract sanitizeDomain + buildCSP source from the inline <script>.
function extract(name: string): string {
  const re = new RegExp(
    `function\\s+${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{6}\\}`,
  );
  const m = html.match(re);
  if (!m) throw new Error(`Could not extract function ${name}`);
  return m[0];
}

const sanitize = extract("sanitizeDomain");
const build = extract("buildCSP");

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const buildCSP = new Function(
  "csp",
  "cspDirectives",
  `${sanitize}\n${build}\nreturn buildCSP(csp, cspDirectives);`,
) as (
  csp: unknown,
  cspDirectives?: Record<string, string[]>,
) => string;

describe("sandbox-proxy buildCSP merge rule", () => {
  it("emits 'none' when no domains and no cspDirectives for an empty directive", () => {
    const out = buildCSP({ frameDomains: [] }, undefined);
    expect(out).toContain("frame-src 'none'");
  });

  it("drops 'none' when cspDirectives adds real tokens to an otherwise-empty directive", () => {
    const out = buildCSP(
      { frameDomains: [] },
      { "frame-src": ["https://embed.example.com"] },
    );
    expect(out).toContain("frame-src https://embed.example.com");
    expect(out).not.toContain("frame-src 'none'");
  });

  it("deduplicates when cspDirectives overlaps with domain-derived tokens", () => {
    const out = buildCSP(
      { connectDomains: ["https://api.example.com"] },
      { "connect-src": ["https://api.example.com", "https://api2.example.com"] },
    );
    const connectLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("connect-src "));
    expect(connectLine).toBeDefined();
    const tokens = connectLine!.slice("connect-src ".length).split(/\s+/);
    expect(tokens.filter((t) => t === "https://api.example.com")).toHaveLength(
      1,
    );
    expect(tokens).toContain("https://api2.example.com");
  });

  it("merges cspDirectives into script-src on top of 'unsafe-inline'", () => {
    const out = buildCSP(
      { resourceDomains: [] },
      { "script-src": ["'unsafe-eval'", "'wasm-unsafe-eval'"] },
    );
    const scriptLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("script-src "));
    expect(scriptLine).toContain("'unsafe-inline'");
    expect(scriptLine).toContain("'unsafe-eval'");
    expect(scriptLine).toContain("'wasm-unsafe-eval'");
  });

  it("appends unknown cspDirectives keys verbatim", () => {
    const out = buildCSP({}, { "form-action": ["'self'"] });
    expect(out).toContain("form-action 'self'");
  });

  it("the no-csp branch still respects cspDirectives merge", () => {
    const out = buildCSP(undefined, {
      "script-src": ["'unsafe-eval'"],
    });
    const scriptLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("script-src "));
    expect(scriptLine).toContain("'unsafe-inline'");
    expect(scriptLine).toContain("'unsafe-eval'");
  });

  it("appends unknown cspDirectives keys in the no-csp branch too", () => {
    // Regression: the !csp branch previously early-returned after merging
    // only the 10 known directives, dropping unknown keys (e.g. `form-action`,
    // `worker-src`) — breaking the round-trip guarantee whenever no CSP
    // metadata was declared.
    const out = buildCSP(undefined, {
      "form-action": ["'self'"],
      "worker-src": ["blob:"],
    });
    expect(out).toContain("form-action 'self'");
    expect(out).toContain("worker-src blob:");
  });
});
