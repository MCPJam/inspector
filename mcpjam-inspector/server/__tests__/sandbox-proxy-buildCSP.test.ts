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
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "routes",
    "apps",
    "mcp-apps",
    "sandbox-proxy.html"
  ),
  "utf8"
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
const buildGuard = extract("buildConnectGuardScript");
const buildStorageGuard = extract("buildBrowserStorageGuardScript");

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const buildCSP = new Function(
  "csp",
  "cspDirectives",
  "cspSubtypePolicy",
  `${sanitize}\n${build}\nreturn buildCSP(csp, cspDirectives, cspSubtypePolicy);`
) as (
  csp: unknown,
  cspDirectives?: Record<string, string[]>,
  cspSubtypePolicy?: Record<string, unknown>
) => string;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const buildConnectGuardScript = new Function(
  "cspSubtypePolicy",
  "cspDirectives",
  `${buildGuard}\nreturn buildConnectGuardScript(cspSubtypePolicy, cspDirectives);`
) as (
  cspSubtypePolicy?: Record<string, unknown>,
  cspDirectives?: Record<string, string[]>
) => string;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const buildBrowserStorageGuardScript = new Function(
  "browserStorage",
  `${buildStorageGuard}\nreturn buildBrowserStorageGuardScript(browserStorage);`
) as (browserStorage?: Record<string, unknown>) => string;

describe("sandbox-proxy buildCSP merge rule", () => {
  it("emits 'none' when no domains and no cspDirectives for an empty directive", () => {
    const out = buildCSP({ frameDomains: [] }, undefined);
    expect(out).toContain("frame-src 'none'");
  });

  it("drops 'none' when cspDirectives adds real tokens to an otherwise-empty directive", () => {
    const out = buildCSP(
      { frameDomains: [] },
      { "frame-src": ["https://embed.example.com"] }
    );
    expect(out).toContain("frame-src https://embed.example.com");
    expect(out).not.toContain("frame-src 'none'");
  });

  it("deduplicates when cspDirectives overlaps with domain-derived tokens", () => {
    const out = buildCSP(
      { connectDomains: ["https://api.example.com"] },
      { "connect-src": ["https://api.example.com", "https://api2.example.com"] }
    );
    const connectLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("connect-src "));
    expect(connectLine).toBeDefined();
    const tokens = connectLine!.slice("connect-src ".length).split(/\s+/);
    expect(tokens.filter((t) => t === "https://api.example.com")).toHaveLength(
      1
    );
    expect(tokens).toContain("https://api2.example.com");
  });

  it("merges cspDirectives into script-src on top of 'unsafe-inline'", () => {
    const out = buildCSP(
      { resourceDomains: [] },
      { "script-src": ["'unsafe-eval'", "'wasm-unsafe-eval'"] }
    );
    const scriptLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("script-src "));
    expect(scriptLine).toContain("'unsafe-inline'");
    expect(scriptLine).toContain("'unsafe-eval'");
    expect(scriptLine).toContain("'wasm-unsafe-eval'");
  });

  it("applies resource-domain support per directive without removing host tokens", () => {
    const out = buildCSP(
      { resourceDomains: ["https://cdn.example.com"] },
      { "script-src": ["https://host.example.com"] },
      {
        cspResourceDomains: {
          script: false,
          stylesheet: true,
          image: false,
          font: true,
          media: false,
        },
      }
    );
    expect(out).toContain(
      "script-src 'unsafe-inline' data: blob: https://host.example.com"
    );
    expect(out).toContain(
      "style-src 'unsafe-inline' data: blob: https://cdn.example.com"
    );
    expect(out).toContain("img-src data: blob:");
    expect(out).toContain("font-src data: blob: https://cdn.example.com");
    expect(out).toContain("media-src data: blob:");
  });

  it("keeps shared connect domains for true or unknown APIs", () => {
    const csp = { connectDomains: ["https://api.example.com"] };
    expect(
      buildCSP(csp, undefined, {
        cspConnectDomains: { fetch: false, xhr: false },
      })
    ).toContain("connect-src https://api.example.com");
    expect(
      buildCSP(csp, undefined, {
        cspConnectDomains: {
          fetch: false,
          xhr: false,
          websocket: false,
        },
      })
    ).toContain("connect-src 'none'");
  });

  it.each([
    [
      "Claude",
      {
        cspConnectDomains: { fetch: true, xhr: true, websocket: true },
        cspResourceDomains: {
          script: true,
          stylesheet: true,
          image: true,
          font: true,
          media: true,
        },
      },
      true,
    ],
    [
      "Cursor",
      {
        cspConnectDomains: { fetch: true, xhr: true, websocket: true },
        cspResourceDomains: {
          script: true,
          stylesheet: true,
          image: true,
          font: true,
          media: true,
        },
      },
      true,
    ],
    [
      "ChatGPT",
      {
        cspConnectDomains: { fetch: false, xhr: false, websocket: true },
        cspResourceDomains: {
          script: false,
          stylesheet: false,
          image: false,
          font: false,
          media: false,
        },
      },
      false,
    ],
    [
      "Goose",
      {
        cspConnectDomains: { fetch: false, xhr: false },
        cspResourceDomains: {
          script: false,
          stylesheet: false,
          image: false,
          font: false,
          media: false,
        },
      },
      false,
    ],
  ] as const)(
    "matches the %s declared-domain canary",
    (_host, policy, resourceDomainsAllowed) => {
      const out = buildCSP(
        {
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://cdn.example.com"],
        },
        undefined,
        policy
      );
      const resourceDirectives = [
        "script-src",
        "style-src",
        "img-src",
        "font-src",
        "media-src",
      ];
      for (const directive of resourceDirectives) {
        const line = out
          .split(";")
          .map((entry) => entry.trim())
          .find((entry) => entry.startsWith(`${directive} `));
        expect(line?.includes("https://cdn.example.com")).toBe(
          resourceDomainsAllowed
        );
      }
      expect(out).toContain("connect-src https://api.example.com");
    }
  );

  it("appends unknown cspDirectives keys verbatim", () => {
    const out = buildCSP({}, { "form-action": ["'self'"] });
    expect(out).toContain("form-action 'self'");
  });

  it("no-csp + cspDirectives REPLACES the baseline for overridden directives", () => {
    // When cspDirectives names a directive, the profile is authoritative
    // — the permissive baseline is dropped so a restrictive entry isn't
    // diluted (e.g. `frame-src "https://widgets.example.com"` must not
    // be widened to `frame-src https: data: blob: https://widgets...`).
    //
    // Template authors who want 'unsafe-inline' alongside 'unsafe-eval'
    // for script-src must list both explicitly; the inspector won't
    // silently add baseline tokens that would lie about the modeled
    // host's CSP shape.
    const out = buildCSP(undefined, {
      "script-src": ["'unsafe-eval'"],
    });
    const scriptLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("script-src "));
    expect(scriptLine).toBe("script-src 'unsafe-eval'");
  });

  it("no-csp + cspDirectives keeps permissive defaults on UNOVERRIDDEN directives", () => {
    // The ChatGPT case: profile only restricts frame-src. Other
    // directives stay permissive (with 'unsafe-inline' / https: / etc.)
    // so widgets without their own CSP keep working.
    const out = buildCSP(undefined, {
      "frame-src": ["'self'", "https://embed.example.com"],
    });
    const lines = out.split(";").map((s) => s.trim());
    const get = (name: string) => lines.find((l) => l.startsWith(name + " "));

    // script-src wasn't overridden → permissive baseline applies.
    expect(get("script-src")).toContain("'unsafe-inline'");
    expect(get("script-src")).toContain("https:");
    // connect-src wasn't overridden → permissive baseline applies.
    expect(get("connect-src")).toContain("https:");

    // frame-src IS in cspDirectives → REPLACE, no permissive dilution.
    // The strict `toBe` pins the full directive shape; the regex
    // assertions below additionally guard against the scheme-only
    // `https:` (or `data:` / `blob:`) tokens bleeding in from the
    // permissive baseline as separate tokens, which is what we're
    // specifically defending against (`https://embed...` contains the
    // substring "https:" but is a host-bearing token, not scheme-wide).
    const frameSrc = get("frame-src");
    expect(frameSrc).toBe("frame-src 'self' https://embed.example.com");
    expect(frameSrc).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
    expect(frameSrc).not.toMatch(/(?:^|\s)data:(?:\s|$)/);
    expect(frameSrc).not.toMatch(/(?:^|\s)blob:(?:\s|$)/);
  });

  it("treats cspDirectives with only whitespace-string entries as no-override", () => {
    // Regression: `{ "frame-src": [" "] }` and similar entries trim
    // away to nothing in mergeDirective, so they contribute nothing to
    // frame-src — but `hasCspOverrides` used to count them as
    // "configured" and flip every other directive's baseline from
    // restrictive secure-default to broad permissive.
    const out = buildCSP(undefined, { "frame-src": [" "] });
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-src 'none'");
  });

  it("treats cspDirectives with only injection-rejected entries as no-override", () => {
    // Same idea for tokens rejected by the `;,\n\r` injection guard —
    // mergeDirective drops them, so they contribute nothing and must
    // not flip the baseline.
    const out = buildCSP(undefined, {
      "frame-src": ["bad;injection"],
    });
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-src 'none'");
  });

  it("treats cspDirectives with HTML-attribute-breakout tokens as no-override", () => {
    // mergeDirective rejects `"`, `<`, `>` (they'd break out of the
    // injectCSP meta-tag content attribute). hasCspOverrides must
    // mirror that filter — otherwise an entry like `["https:\"><script>"]`
    // flips the baseline to permissive for every other directive while
    // contributing zero tokens to the named one.
    const out = buildCSP(undefined, {
      "frame-src": ['https:"><script>'],
    });
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-src 'none'");
  });

  it("treats cspDirectives with only empty-array entries as no-override (keeps restrictive defaults)", () => {
    // Regression: `cspDirectives: { "frame-src": [] }` is semantically
    // a no-op (no source expressions for that directive). Without a
    // non-empty check, it used to flip the no-csp branch's baseline
    // from restrictive secure-default to broad permissive (`https:` /
    // `wss:` on connect-src etc.), silently widening the iframe's
    // network surface for widgets without their own _meta.ui.csp.
    const out = buildCSP(undefined, { "frame-src": [] });
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-src 'none'");
    expect(out).toContain("default-src 'none'");
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
    const out = buildCSP(
      {},
      {
        "connect-src": ["'self'; script-src *"],
      }
    );
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

  it("drops cspDirectives value tokens containing HTML-attribute breakouts — meta-tag injection guard", () => {
    // The merged CSP string is injected as the value of
    // `<meta http-equiv="Content-Security-Policy" content="...">` without
    // HTML-escaping. A token containing `"`, `<`, or `>` would close the
    // content attribute or open a tag in the srcdoc before the intended
    // CSP is established. CSP source expressions never legitimately
    // contain these characters, so reject them outright.
    const out = buildCSP(
      {},
      {
        "connect-src": [
          "'self\"><script>alert(1)</script>",
          "https://evil<>.example",
        ],
      }
    );
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('">');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain('"');
    const connectLine = out
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("connect-src "));
    // Both hostile tokens dropped → directive falls back to 'none'.
    expect(connectLine).toBe("connect-src 'none'");
  });

  it("drops cspDirectives keys containing HTML-attribute breakouts", () => {
    // Same risk as the value path: the key flows into the unescaped
    // content="..." of the injected <meta> tag via `name + " " + tokens`.
    const out = buildCSP(
      {},
      {
        'x"><script>alert(1)</script><x ': ["'self'"],
      }
    );
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('"');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("drops cspDirectives keys containing CSP separators or whitespace", () => {
    // The key is concatenated into the output via `name + " " + tokens`,
    // so a crafted name like `"worker-src *; script-src"` would smuggle
    // a second directive even if every value token is clean.
    const out = buildCSP(
      {},
      {
        "worker-src *; script-src": ["'unsafe-eval'"],
      }
    );
    expect(out).not.toContain("script-src 'unsafe-eval'");
    expect(out).not.toContain("worker-src *");
  });
});

describe("sandbox-proxy connect subtype guards", () => {
  it("blocks false fetch, emits a compatible violation, and keeps unknown websocket untouched", async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const postMessage = vi.fn();
    let originalWebSocket: unknown;
    const script = buildConnectGuardScript({
      cspConnectDomains: { fetch: false, xhr: false },
    });
    const dom = new JSDOM(
      `<!doctype html><html><head>${script}</head></html>`,
      {
        runScripts: "dangerously",
        url: "https://widget.example.test/",
        beforeParse(window) {
          Object.defineProperty(window, "fetch", {
            value: nativeFetch,
            configurable: true,
            writable: true,
          });
          window.postMessage = postMessage as typeof window.postMessage;
          originalWebSocket = window.WebSocket;
        },
      }
    );

    await expect(
      dom.window.fetch("https://declared.example.test/data")
    ).rejects.toThrow("Failed to fetch");
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp-apps:csp-violation",
        directive: "connect-src",
        effectiveDirective: "connect-src",
        subtype: "fetch",
        blockedUri: "https://declared.example.test/data",
      }),
      "*"
    );

    const xhr = new dom.window.XMLHttpRequest();
    xhr.open("GET", "https://declared.example.test/xhr");
    expect(() => xhr.send()).toThrow();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp-apps:csp-violation",
        directive: "connect-src",
        subtype: "xhr",
        blockedUri: "https://declared.example.test/xhr",
      }),
      "*"
    );
    expect(dom.window.WebSocket).toBe(originalWebSocket);
  });

  it("lets explicit host-owned connect-src sources through", async () => {
    const response = new Response("ok");
    const nativeFetch = vi.fn(() => Promise.resolve(response));
    const postMessage = vi.fn();
    const script = buildConnectGuardScript(
      { cspConnectDomains: { fetch: false } },
      { "connect-src": ["https://host.example.test"] }
    );
    const dom = new JSDOM(
      `<!doctype html><html><head>${script}</head></html>`,
      {
        runScripts: "dangerously",
        url: "https://widget.example.test/",
        beforeParse(window) {
          Object.defineProperty(window, "fetch", {
            value: nativeFetch,
            configurable: true,
            writable: true,
          });
          window.postMessage = postMessage as typeof window.postMessage;
        },
      }
    );

    await expect(
      dom.window.fetch("https://host.example.test/data")
    ).resolves.toBe(response);
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("sandbox-proxy host baseline allowlist", () => {
  const ALL_CONNECT_ALLOWED = {
    cspConnectDomains: { fetch: true, xhr: true, websocket: true },
  };

  it("keeps the host's own connect origins when the widget declares none", () => {
    // ChatGPT's catalog row carries the two CDNs its 2026-08-19 probe loaded
    // WITHOUT a declaration. With the row empty the proxy emitted
    // `connect-src 'none'` and blocked every fetch a real widget can make.
    const out = buildCSP(
      {},
      { "connect-src": ["https://cdn.jsdelivr.net", "https://unpkg.com"] },
      ALL_CONNECT_ALLOWED
    );
    expect(out).toContain(
      "connect-src https://cdn.jsdelivr.net https://unpkg.com"
    );
    expect(out).not.toContain("connect-src 'none'");
  });

  it("unions the host baseline with the widget's declared origins", () => {
    const out = buildCSP(
      { connectDomains: ["https://api.example.com"] },
      { "connect-src": ["https://unpkg.com"] },
      ALL_CONNECT_ALLOWED
    );
    expect(out).toContain(
      "connect-src https://api.example.com https://unpkg.com"
    );
  });

  it("keeps the host baseline on resource directives too", () => {
    const out = buildCSP(
      {},
      { "img-src": ["https://cdn.jsdelivr.net"] },
      ALL_CONNECT_ALLOWED
    );
    expect(out).toContain("img-src data: blob: https://cdn.jsdelivr.net");
  });
});

/**
 * The guard's `sourceMatches` decides whether a call the HOST would allow
 * escapes an otherwise-blocked subtype, so it has to follow real CSP source
 * matching rather than approximate it. Ignoring paths or ports makes it
 * fail OPEN, which is the direction that actually costs something.
 *
 * Rules under test: CSP3 §6.7.2.9 (scheme-part), §6.7.2.11 (port-part),
 * §6.7.2.12 (path-part), and the schemeless-host rule in §6.7.2.7 step 3.2.
 */
describe("sandbox-proxy connect guard — CSP source matching", () => {
  /**
   * Run one fetch through a guard that blocks fetch and allows exactly
   * `sources`. Resolves true when the call reached the network (the host
   * allowlist matched), false when the guard refused it.
   */
  async function fetchAllowed(
    sources: string[],
    target: string,
    documentUrl = "https://widget.example.test/",
    baseHref?: string
  ): Promise<boolean> {
    const response = new Response("ok");
    const nativeFetch = vi.fn(() => Promise.resolve(response));
    const script = buildConnectGuardScript(
      { cspConnectDomains: { fetch: false } },
      { "connect-src": sources }
    );
    const base = baseHref ? `<base href="${baseHref}">` : "";
    const dom = new JSDOM(
      `<!doctype html><html><head>${base}${script}</head></html>`,
      {
        runScripts: "dangerously",
        url: documentUrl,
        beforeParse(window) {
          Object.defineProperty(window, "fetch", {
            value: nativeFetch,
            configurable: true,
            writable: true,
          });
          window.postMessage = vi.fn() as typeof window.postMessage;
        },
      }
    );
    try {
      await dom.window.fetch(target);
    } catch {
      return false;
    }
    return nativeFetch.mock.calls.length === 1;
  }

  describe("document base URL", () => {
    // The view is written into a same-origin frame, so its document URL is
    // the proxy URL (the srcdoc fallback inherits the same baseURI). Both
    // shapes must resolve relative requests and 'self' the same way.
    const PROXY_URL =
      "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1";

    it("resolves relative requests against the proxy URL", async () => {
      await expect(
        fetchAllowed(["http://127.0.0.1:6274"], "/api/data", PROXY_URL),
      ).resolves.toBe(true);
    });

    it("matches 'self' against the proxy origin", async () => {
      await expect(
        fetchAllowed(["'self'"], "http://127.0.0.1:6274/api/data", PROXY_URL),
      ).resolves.toBe(true);
    });

    it("resolves relative requests against document.baseURI (srcdoc fallback)", async () => {
      await expect(
        fetchAllowed(
          ["https://widget.example.test"],
          "/api/data",
          "about:srcdoc",
          "https://widget.example.test/app/"
        )
      ).resolves.toBe(true);
    });

    it("matches 'self' against document.baseURI origin (srcdoc fallback)", async () => {
      await expect(
        fetchAllowed(
          ["'self'"],
          "https://widget.example.test/api/data",
          "about:srcdoc",
          "https://widget.example.test/app/"
        )
      ).resolves.toBe(true);
    });
  });

  describe("path-part", () => {
    it("treats a trailing slash as a directory prefix", async () => {
      await expect(
        fetchAllowed(["https://h.test/api/"], "https://h.test/api/items")
      ).resolves.toBe(true);
      await expect(
        fetchAllowed(["https://h.test/api/"], "https://h.test/api/")
      ).resolves.toBe(true);
    });

    it("refuses a sibling path outside the prefix", async () => {
      await expect(
        fetchAllowed(["https://h.test/api/"], "https://h.test/admin")
      ).resolves.toBe(false);
    });

    it("requires an exact match with no trailing slash", async () => {
      await expect(
        fetchAllowed(["https://h.test/api/v1"], "https://h.test/api/v1")
      ).resolves.toBe(true);
      await expect(
        fetchAllowed(["https://h.test/api/v1"], "https://h.test/api/v2")
      ).resolves.toBe(false);
      // Deeper than the expression: exact matching compares segment counts.
      await expect(
        fetchAllowed(["https://h.test/api/v1"], "https://h.test/api/v1/x")
      ).resolves.toBe(false);
    });

    it("still allows any path when the expression carries none", async () => {
      await expect(
        fetchAllowed(["https://h.test"], "https://h.test/anything/at/all")
      ).resolves.toBe(true);
    });
  });

  describe("port-part", () => {
    it("matches a spelled-out default port against an implicit one", async () => {
      // `URL.port` is "" for 443, so a naive string compare rejects this.
      await expect(
        fetchAllowed(["https://h.test:443"], "https://h.test/x")
      ).resolves.toBe(true);
    });

    it("refuses a non-default port when the expression names none", async () => {
      await expect(
        fetchAllowed(["https://h.test"], "https://h.test:8443/x")
      ).resolves.toBe(false);
    });

    it("matches an explicit non-default port", async () => {
      await expect(
        fetchAllowed(["https://h.test:8443"], "https://h.test:8443/x")
      ).resolves.toBe(true);
    });

    it("accepts any port behind the port wildcard", async () => {
      await expect(
        fetchAllowed(["https://h.test:*"], "https://h.test:8443/x")
      ).resolves.toBe(true);
    });
  });

  describe("host-part", () => {
    it("matches a subdomain against a wildcard host", async () => {
      await expect(
        fetchAllowed(["https://*.h.test"], "https://api.h.test/x")
      ).resolves.toBe(true);
    });

    it("does not let a wildcard cover the bare domain", async () => {
      await expect(
        fetchAllowed(["https://*.h.test"], "https://h.test/x")
      ).resolves.toBe(false);
    });

    it("refuses a host that merely ends with the expression", async () => {
      await expect(
        fetchAllowed(["https://h.test"], "https://evil-h.test/x")
      ).resolves.toBe(false);
    });
  });

  describe("scheme-part", () => {
    it("upgrades an insecure expression to its secure variant", async () => {
      await expect(
        fetchAllowed(["http://h.test"], "https://h.test/x")
      ).resolves.toBe(true);
    });

    it("never downgrades a secure expression", async () => {
      await expect(
        fetchAllowed(["https://h.test"], "http://h.test/x")
      ).resolves.toBe(false);
    });

    it("reads a schemeless host against the protected document's scheme", async () => {
      await expect(fetchAllowed(["h.test"], "https://h.test/x")).resolves.toBe(
        true
      );
      // The document is https, so an http target is not the same endpoint.
      await expect(fetchAllowed(["h.test"], "http://h.test/x")).resolves.toBe(
        false
      );
    });
  });

  it("refuses anything outside the host allowlist", async () => {
    await expect(
      fetchAllowed(["https://h.test"], "https://other.test/x")
    ).resolves.toBe(false);
    await expect(fetchAllowed([], "https://h.test/x")).resolves.toBe(false);
  });
});

describe("sandbox-proxy browser storage guard", () => {
  it("throws SecurityError on a blocked API and leaves the others working", () => {
    const script = buildBrowserStorageGuardScript({ localStorage: false });
    const dom = new JSDOM(
      `<!doctype html><html><head>${script}</head></html>`,
      { runScripts: "dangerously", url: "https://widget.example.test/" }
    );

    // Access itself throws — matching a real iframe without
    // `allow-same-origin`, so a widget's `try { localStorage } catch`
    // feature-detect takes the same branch here as in production.
    let caught: unknown;
    try {
      void dom.window.localStorage;
    } catch (error) {
      caught = error;
    }
    expect((caught as DOMException | undefined)?.name).toBe("SecurityError");

    // Unlisted APIs are untouched.
    expect(() => dom.window.sessionStorage).not.toThrow();
  });

  it("blocks every listed API, including indexedDB", () => {
    const script = buildBrowserStorageGuardScript({
      localStorage: false,
      sessionStorage: false,
      indexedDB: false,
    });
    const dom = new JSDOM(
      `<!doctype html><html><head>${script}</head></html>`,
      { runScripts: "dangerously", url: "https://widget.example.test/" }
    );

    for (const api of ["localStorage", "sessionStorage", "indexedDB"] as const) {
      let caught: unknown;
      try {
        void (dom.window as unknown as Record<string, unknown>)[api];
      } catch (error) {
        caught = error;
      }
      expect((caught as DOMException | undefined)?.name).toBe("SecurityError");
    }
  });

  it("emits nothing when no API is blocked, so the fast path stays free", () => {
    // Absent, empty, and all-true are the same statement: nothing is denied.
    expect(buildBrowserStorageGuardScript(undefined)).toBe("");
    expect(buildBrowserStorageGuardScript({})).toBe("");
    expect(
      buildBrowserStorageGuardScript({
        localStorage: true,
        sessionStorage: true,
        indexedDB: true,
      })
    ).toBe("");
  });

  it("only an explicit false blocks — true and absent both mean available", () => {
    const script = buildBrowserStorageGuardScript({
      localStorage: true,
      indexedDB: false,
    });
    const dom = new JSDOM(
      `<!doctype html><html><head>${script}</head></html>`,
      { runScripts: "dangerously", url: "https://widget.example.test/" }
    );
    expect(() => dom.window.localStorage).not.toThrow();
    expect(() => dom.window.sessionStorage).not.toThrow();
    let caught: unknown;
    try {
      void dom.window.indexedDB;
    } catch (error) {
      caught = error;
    }
    expect((caught as DOMException | undefined)?.name).toBe("SecurityError");
  });
});
