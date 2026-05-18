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
// Locates the function signature with a forgiving regex, then walks the
// body counting `{` / `}` so reformatting (whitespace, brace indentation)
// in `sandbox-proxy.html` doesn't break the test.
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

  it("drops cspDirectives value tokens containing ';' — injection guard", () => {
    // Defense in depth: the backend canonicalizer rejects this at write
    // time, but if it ever drifts the proxy must not blindly concatenate
    // a token like `"'self'; script-src *"` into the CSP — that would
    // break out of the intended directive and smuggle a wildcard.
    const out = buildCSP({}, {
      "connect-src": ["'self'; script-src *"],
    });
    // The injected directive must not appear in the output.
    expect(out).not.toContain("script-src *");
    // The hostile token must not be emitted under connect-src either.
    const connectLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("connect-src "));
    expect(connectLine).not.toContain("'self'");
  });

  it("uses permissive baselines (not restrictive) on no-csp + cspDirectives — ChatGPT-style profile", () => {
    // Regression for: a profile like ChatGPT that lists only `frame-src`
    // in cspDirectives (because the real host's emitted CSP only
    // constrains frame-src) used to force restrictive defaults on every
    // other directive — so a widget without its own _meta.ui.csp got
    // `connect-src 'none'` / restrictive `script-src` and silently
    // failed even though the modeled host wouldn't block it.
    const out = buildCSP(undefined, {
      "frame-src": ["'self'", "https:", "data:", "blob:"],
    });
    const lines = out.split(";").map((s) => s.trim());
    const get = (name: string) => lines.find((l) => l.startsWith(name + " "));

    // Directives NOT in cspDirectives should be permissive (specifically
    // include 'unsafe-inline' / 'https:' / 'data:' / 'blob:' so widget
    // code can execute and fetch normally).
    expect(get("script-src")).toContain("'unsafe-inline'");
    expect(get("script-src")).toContain("https:");
    expect(get("connect-src")).toContain("https:");
    expect(get("connect-src")).not.toContain("'none'");

    // frame-src IS in cspDirectives — gets the listed tokens (and no `*`
    // wildcard in the baseline that would dilute them back to permissive).
    const frameSrc = get("frame-src");
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).toContain("https:");
    expect(frameSrc).not.toContain("*");
  });

  it("drops cspDirectives keys containing CSP separators or whitespace", () => {
    // The key is concatenated into the output via `name + " " + tokens`,
    // so a crafted name like `"worker-src *; script-src"` would smuggle
    // a second directive even if every value token is clean.
    const out = buildCSP({}, {
      "worker-src *; script-src": ["'unsafe-eval'"],
    });
    expect(out).not.toContain("script-src 'unsafe-eval'");
    expect(out).not.toContain("worker-src *");
  });
});
