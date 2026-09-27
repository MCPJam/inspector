/**
 * Document policies from the security headers middleware (MJ-016).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mockConfig = vi.hoisted(() => ({ hosted: false }));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return mockConfig.hosted;
    },
    SANDBOX_HOSTS: new Set(["sandbox.mcpjam.test"]),
  };
});

vi.mock("../../env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../env.js")>();
  return {
    ...actual,
    getInspectorClientRuntimeConfig: () => ({
      convexUrl: "https://rt.mcpjam.test",
      convexSiteUrl: "https://rt-http.mcpjam.test",
      workosClientId: "client_123",
      workosApiHostname: "auth.mcpjam.test",
    }),
  };
});

const {
  CSP_REPORT_SAMPLE_RATE,
  DOCUMENT_CONTENT_SECURITY_POLICY,
  DOCUMENT_PERMISSIONS_POLICY,
  buildReportOnlyContentSecurityPolicy,
  documentScriptNonce,
  resetContentSecurityPolicyForTests,
  securityHeadersMiddleware,
  sentryCspTargets,
  withScriptNonce,
} = await import("../security-headers.js");

function createApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.get("/", (c) => c.html("<!doctype html><title>app</title>"));
  app.get("/api/data", (c) => c.json({ ok: true }));
  // Mirrors the SPA document handlers in server/index.ts and server/app.ts:
  // inline scripts written into the document carry the response's nonce.
  app.get("/document", (c) => {
    const nonce = documentScriptNonce(c);
    const scripts = [
      `<script>window.__MCP_SESSION_TOKEN__="token";</script>`,
      `<script>window.__MCP_RUNTIME_CONFIG__={};</script>`,
    ].map((script) => withScriptNonce(script, nonce));
    return c.html(
      `<!doctype html><html><head>${scripts.join("")}</head></html>`,
    );
  });
  app.get("/own-policy", (c) => {
    c.header("Content-Security-Policy", "frame-ancestors https://host.test");
    return c.html("<!doctype html><title>own</title>");
  });
  return app;
}

function directives(policy: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const directive of (policy ?? "").split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

function inlineScriptNonces(html: string): Array<string | null> {
  return Array.from(
    html.matchAll(/<script(?: nonce="([^"]*)")?>/g),
    (match) => match[1] ?? null,
  );
}

describe("securityHeadersMiddleware document policies", () => {
  beforeEach(() => {
    mockConfig.hosted = false;
    resetContentSecurityPolicyForTests();
    // Sample every document unless a test says otherwise.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    mockConfig.hosted = false;
    resetContentSecurityPolicyForTests();
    vi.restoreAllMocks();
  });

  it("enforces frame-ancestors, object-src and base-uri on HTML documents", async () => {
    expect(DOCUMENT_CONTENT_SECURITY_POLICY).toBe(
      "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
    );
    const res = await createApp().request("/");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      DOCUMENT_CONTENT_SECURITY_POLICY,
    );
    const enforced = directives(res.headers.get("Content-Security-Policy"));
    expect(enforced.get("frame-ancestors")).toEqual(["'self'"]);
    expect(enforced.get("object-src")).toEqual(["'none'"]);
    expect(enforced.get("base-uri")).toEqual(["'self'"]);
    // The pre-existing headers are unchanged.
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("leaves non-HTML responses without a policy", async () => {
    const res = await createApp().request("/api/data");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(res.headers.get("Permissions-Policy")).toBeNull();
  });

  it("denies unused hardware features and leaves SEP-1865 grants unlisted", async () => {
    const res = await createApp().request("/");
    const policy = res.headers.get("Permissions-Policy");
    expect(policy).toBe(DOCUMENT_PERMISSIONS_POLICY);
    // Every listed feature is fully denied.
    for (const entry of (policy ?? "").split(",")) {
      expect(entry.trim()).toMatch(/^[a-z-]+=\(\)$/);
    }
    // The features MCP Apps iframes are granted per-resource (SEP-1865) and
    // the media features embeds rely on must stay unlisted: listing one here
    // would deny it for every descendant iframe regardless of `allow=`.
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "clipboard-write",
      "fullscreen",
      "autoplay",
      "payment",
      "picture-in-picture",
    ]) {
      expect(policy).not.toContain(`${feature}=`);
    }
  });

  it("keeps a route's own policy", async () => {
    const res = await createApp().request("/own-policy");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://host.test",
    );
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("sets the policy on a response whose headers cannot be changed in place", async () => {
    const upstream = new Response("<!doctype html><title>up</title>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const headers = upstream.headers;
    Object.defineProperty(upstream, "headers", {
      value: new Proxy(headers, {
        get(target, prop) {
          if (prop === "set") {
            return () => {
              throw new TypeError("immutable");
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    const ctx = { header: vi.fn(), res: upstream } as unknown as Context;

    await securityHeadersMiddleware(ctx, async () => {});

    expect(ctx.res).not.toBe(upstream);
    expect(ctx.res.headers.get("Content-Security-Policy")).toBe(
      DOCUMENT_CONTENT_SECURITY_POLICY,
    );
    expect(await ctx.res.text()).toBe("<!doctype html><title>up</title>");
  });

  it("sends the report-only policy only in hosted mode", async () => {
    const local = await createApp().request("/");
    expect(local.headers.get("Content-Security-Policy-Report-Only")).toBeNull();

    mockConfig.hosted = true;
    const hosted = await createApp().request("/");
    expect(hosted.headers.get("Content-Security-Policy-Report-Only")).toBe(
      buildReportOnlyContentSecurityPolicy(),
    );
    // Report-only never replaces the enforcing policy.
    expect(hosted.headers.get("Content-Security-Policy")).toBe(
      DOCUMENT_CONTENT_SECURITY_POLICY,
    );
  });

  it("allows the document's inline scripts by the nonce they carry", async () => {
    mockConfig.hosted = true;
    const res = await createApp().request("/document");
    const html = await res.text();

    const nonces = inlineScriptNonces(html);
    expect(nonces).toHaveLength(2);
    const [nonce] = nonces;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonces).toEqual([nonce, nonce]);

    const policy = res.headers.get("Content-Security-Policy-Report-Only");
    expect(policy).toBe(
      buildReportOnlyContentSecurityPolicy(
        undefined,
        undefined,
        undefined,
        nonce!,
      ),
    );
    expect(directives(policy).get("script-src")).toContain(`'nonce-${nonce}'`);
    // The enforcing policy has no script-src to carry a nonce.
    expect(res.headers.get("Content-Security-Policy")).toBe(
      DOCUMENT_CONTENT_SECURITY_POLICY,
    );
  });

  it("issues a fresh nonce for each response", async () => {
    mockConfig.hosted = true;
    const app = createApp();
    const first = inlineScriptNonces(
      await (await app.request("/document")).text(),
    )[0];
    const second = inlineScriptNonces(
      await (await app.request("/document")).text(),
    )[0];
    expect(first).not.toBe(second);
  });

  it("leaves script-src without a nonce when the document issued none", async () => {
    mockConfig.hosted = true;
    const res = await createApp().request("/");
    const scriptSrc =
      directives(res.headers.get("Content-Security-Policy-Report-Only")).get(
        "script-src",
      ) ?? [];
    expect(scriptSrc.some((source) => source.startsWith("'nonce-"))).toBe(
      false,
    );
  });

  it("sends the report-only policy on a sampled share of documents", async () => {
    mockConfig.hosted = true;
    const app = createApp();

    vi.mocked(Math.random).mockReturnValue(CSP_REPORT_SAMPLE_RATE - 0.001);
    const sampled = await app.request("/document");
    expect(sampled.headers.get("Content-Security-Policy-Report-Only")).toMatch(
      /report-uri /,
    );

    vi.mocked(Math.random).mockReturnValue(CSP_REPORT_SAMPLE_RATE);
    const unsampled = await app.request("/document");
    expect(
      unsampled.headers.get("Content-Security-Policy-Report-Only"),
    ).toBeNull();
    // The enforcing policy and Permissions-Policy are on every document.
    for (const res of [sampled, unsampled]) {
      expect(res.headers.get("Content-Security-Policy")).toBe(
        DOCUMENT_CONTENT_SECURITY_POLICY,
      );
      expect(res.headers.get("Permissions-Policy")).toBe(
        DOCUMENT_PERMISSIONS_POLICY,
      );
    }

    vi.mocked(Math.random).mockRestore();
    let reported = 0;
    for (let i = 0; i < 2000; i++) {
      const res = await app.request("/");
      if (res.headers.has("Content-Security-Policy-Report-Only")) reported++;
    }
    expect(CSP_REPORT_SAMPLE_RATE).toBe(0.05);
    expect(reported).toBeGreaterThan(40);
    expect(reported).toBeLessThan(170);
  });
});

// Source text, like entrypoint-parity.test.ts: importing server/index.ts
// would bind a port.
describe.each(["index.ts", "app.ts"])("server/%s document handler", (file) => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../..", file),
    "utf8",
  );

  it("writes every inline script with the response's nonce", () => {
    expect(source).toContain("documentScriptNonce(c)");
    const literals = [...source.matchAll(/`<script>/g)];
    expect(literals.length).toBeGreaterThanOrEqual(2);
    for (const literal of literals) {
      expect(source.slice(0, literal.index)).toMatch(/withScriptNonce\(\s*$/);
    }
    expect(source).toMatch(
      /withScriptNonce\(runtimeConfigScript, scriptNonce\)/,
    );
    expect(source).toMatch(
      /withScriptNonce\(\s*buildGuestBootstrapScript\(session\),\s*scriptNonce,?\s*\)/,
    );
  });
});

describe("withScriptNonce", () => {
  it("adds the nonce to the leading script tag only", () => {
    expect(
      withScriptNonce('<script>window.x="<script>";</script>', "abc+/="),
    ).toBe('<script nonce="abc+/=">window.x="<script>";</script>');
  });

  it("leaves anything that is not an inline script element unchanged", () => {
    expect(withScriptNonce("<scripts>", "n")).toBe("<scripts>");
    expect(withScriptNonce("<meta name=x>", "n")).toBe("<meta name=x>");
  });
});

describe("buildReportOnlyContentSecurityPolicy", () => {
  it("builds each directive from the runtime config", () => {
    const policy = directives(buildReportOnlyContentSecurityPolicy());

    expect(policy.get("script-src")).toEqual([
      "'self'",
      "'unsafe-eval'",
      "https://js.stripe.com",
      "https://*.js.stripe.com",
      "https://maps.googleapis.com",
    ]);
    expect(policy.get("style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
    ]);
    expect(policy.get("font-src")).toEqual([
      "https://fonts.gstatic.com",
      "data:",
    ]);
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://rt.mcpjam.test",
        "wss://rt.mcpjam.test",
        "https://rt-http.mcpjam.test",
        "wss://rt-http.mcpjam.test",
        "https://auth.mcpjam.test",
        "https://api.stripe.com",
        "https://maps.googleapis.com",
        "https://r.stripe.com",
      ]),
    );
    expect(policy.get("frame-src")).toEqual([
      "'self'",
      "https://sandbox.mcpjam.test",
      "https://*.sandbox.mcpjam.test",
      "https://js.stripe.com",
      "https://*.js.stripe.com",
      "https://hooks.stripe.com",
      "https://m.stripe.network",
      "https://www.youtube.com",
    ]);
    expect(policy.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https:",
    ]);
    expect(policy.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(policy.get("report-uri")).toHaveLength(1);
    expect(policy.has("default-src")).toBe(false);
  });

  it("reports to the Sentry security endpoint for the DSN", () => {
    const dsn = "https://publickey@o123.ingest.us.sentry.io/456";
    expect(sentryCspTargets(dsn)).toEqual({
      ingestOrigin: "https://o123.ingest.us.sentry.io",
      reportUri:
        "https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey",
    });

    const policy = directives(
      buildReportOnlyContentSecurityPolicy(
        { convexUrl: "https://rt.mcpjam.test" },
        new Set(),
        dsn,
      ),
    );
    expect(policy.get("report-uri")).toEqual([
      "https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey",
    ]);
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining([
        "https://o123.ingest.us.sentry.io",
        "https://api.workos.com",
      ]),
    );
  });

  it("omits report-uri when the DSN cannot be parsed", () => {
    const policy = directives(
      buildReportOnlyContentSecurityPolicy({}, new Set(), "not a dsn"),
    );
    expect(policy.has("report-uri")).toBe(false);
  });
});
