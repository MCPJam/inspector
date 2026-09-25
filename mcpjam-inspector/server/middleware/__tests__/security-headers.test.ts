/**
 * Document policies from the security headers middleware (MJ-016).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";

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
  DOCUMENT_CONTENT_SECURITY_POLICY,
  DOCUMENT_PERMISSIONS_POLICY,
  buildReportOnlyContentSecurityPolicy,
  resetContentSecurityPolicyForTests,
  securityHeadersMiddleware,
  sentryCspTargets,
} = await import("../security-headers.js");

function createApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.get("/", (c) => c.html("<!doctype html><title>app</title>"));
  app.get("/api/data", (c) => c.json({ ok: true }));
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

describe("securityHeadersMiddleware document policies", () => {
  beforeEach(() => {
    mockConfig.hosted = false;
    resetContentSecurityPolicyForTests();
  });
  afterEach(() => {
    mockConfig.hosted = false;
    resetContentSecurityPolicyForTests();
  });

  it("enforces frame-ancestors, object-src and base-uri on HTML documents", async () => {
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

  it.each(["https", "http"])(
    "preserves document policies with conditional HSTS over %s",
    async (scheme) => {
      mockConfig.hosted = true;
      const res = await createApp().request("/", {
        headers: { "x-forwarded-proto": scheme },
      });

      expect(res.headers.get("Strict-Transport-Security")).toBe(
        scheme === "https" ? "max-age=31536000" : null,
      );
      expect(res.headers.get("Content-Security-Policy")).toBe(
        DOCUMENT_CONTENT_SECURITY_POLICY,
      );
      expect(res.headers.get("Permissions-Policy")).toBe(
        DOCUMENT_PERMISSIONS_POLICY,
      );
      expect(res.headers.get("Content-Security-Policy-Report-Only")).toBe(
        buildReportOnlyContentSecurityPolicy(),
      );
    },
  );

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
    const ctx = {
      header: vi.fn(),
      req: { header: () => undefined, url: "http://localhost/" },
      res: upstream,
    } as unknown as Context;

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
});

describe("buildReportOnlyContentSecurityPolicy", () => {
  it("builds each directive from the runtime config", () => {
    const policy = directives(buildReportOnlyContentSecurityPolicy());

    expect(policy.get("script-src")).toEqual([
      "'self'",
      "https://js.stripe.com",
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
      ]),
    );
    expect(policy.get("frame-src")).toEqual([
      "'self'",
      "https://sandbox.mcpjam.test",
      "https://*.sandbox.mcpjam.test",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
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
