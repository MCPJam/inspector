/**
 * Indexing Headers Middleware Tests
 *
 * The thing worth pinning here is the host exemption. `caniuse.dev` and
 * `score.mcpjam.com` are answered by this same process and exist to rank, so a
 * host-blind `X-Robots-Tag: noindex` would drop both domains out of Google's
 * index on the next deploy.
 */

import { describe, it, expect } from "vitest";
import { Hono, type Context } from "hono";
import { indexingHeadersMiddleware } from "../indexing-headers.js";
import { securityHeadersMiddleware } from "../security-headers.js";

function createTestApp(): Hono {
  const app = new Hono();

  app.use("*", indexingHeadersMiddleware);

  app.get("/", (c) => c.html("<!doctype html><html></html>"));
  app.get("/embed/host-compare", (c) => c.html("<!doctype html><html></html>"));
  app.get("/results/:runToken", (c) => c.html("<!doctype html><html></html>"));
  app.get("/bench/results/:secret", (c) =>
    c.html("<!doctype html><html></html>"),
  );
  app.get("/api/test", (c) => c.json({ message: "success" }));

  return app;
}

async function robotsTagFor(path: string, host?: string) {
  const res = await createTestApp().request(path, {
    headers: host === undefined ? {} : { Host: host },
  });
  return res.headers.get("X-Robots-Tag");
}

describe("indexingHeadersMiddleware", () => {
  it("marks the app shell noindex", async () => {
    expect(await robotsTagFor("/", "app.mcpjam.com")).toBe("noindex");
  });

  it("marks API responses noindex too", async () => {
    expect(await robotsTagFor("/api/test", "app.mcpjam.com")).toBe("noindex");
  });

  // No Host header at all must not read as a landing host, or a request that
  // omits it would be the one way to get an indexable app shell.
  it("marks a request with no Host header noindex", async () => {
    expect(await robotsTagFor("/")).toBe("noindex");
  });

  // These are the pages caniuse.dev and score.mcpjam.com actually serve:
  // server/index.ts redirects their roots to /embed/*, and
  // server/utils/caniuse-meta-tags.ts sets the canonical URL and the snippet
  // description for them.
  it.each([
    "caniuse.dev",
    "www.caniuse.dev",
    "score.mcpjam.com",
    "www.score.mcpjam.com",
  ])("leaves %s indexable", async (host) => {
    expect(await robotsTagFor("/", host)).toBe(null);
    expect(await robotsTagFor("/embed/host-compare", host)).toBe(null);
  });

  // The vanity gates in server/index.ts lowercase the header and strip the
  // port before matching; an exemption that did neither would noindex the real
  // domains behind a proxy that appends one.
  it.each(["CaniUse.DEV", "caniuse.dev:8080", "SCORE.mcpjam.com:443"])(
    "leaves %s indexable",
    async (host) => {
      expect(await robotsTagFor("/", host)).toBe(null);
    },
  );

  // score.mcpjam.com is exempt as a host and `/results/<token>` is the page it
  // exists to serve, so the exemption must stop short of the paths where the
  // URL is the credential — otherwise the score domain is the one host that
  // serves them with no directive at all.
  it.each([
    ["score.mcpjam.com", "/results/tok_abc"],
    ["score.mcpjam.com", "/bench/results/sec_abc"],
    ["caniuse.dev", "/results/tok_abc"],
    ["app.mcpjam.com", "/results/tok_abc"],
    ["app.mcpjam.com", "/bench/results/sec_abc"],
    // Every path-secret route in the credential registry, not only the two
    // the old prefix list named.
    ["score.mcpjam.com", "/conformance/shared/tok_abc"],
    ["score.mcpjam.com", "/evals/shared/tok_abc"],
    ["caniuse.dev", "/user-testing/study_1/tok_abc"],
    ["caniuse.dev", "/chatbox/study_1/tok_abc"],
    ["score.mcpjam.com", "/connect/server/handoff_abc"],
  ])("marks %s%s noindex", async (host, path) => {
    expect(await robotsTagFor(path, host)).toBe("noindex");
  });

  it("leaves a reserved segment indexable on a landing host", async () => {
    // `/user-testing/<id>/edit` is the editor, not a tester link.
    expect(
      await robotsTagFor("/user-testing/study_1/edit", "caniuse.dev"),
    ).toBe(null);
  });
});

/**
 * The production order: securityHeadersMiddleware sets the global
 * Referrer-Policy, then this middleware replaces it on credential pages. Both
 * entries (server/index.ts, server/app.ts) mount them in this order.
 */
function createProductionOrderApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.use("*", indexingHeadersMiddleware);
  const page = (c: Context) => c.html("<!doctype html><html></html>");
  app.get("/", page);
  app.get("/projects/:id", page);
  app.get("/results/:runToken", page);
  app.get("/bench/results/:secret", page);
  app.get("/conformance/shared/:token", page);
  app.get("/user-testing/:slug/:token", page);
  app.get("/oauth/callback", page);
  app.get("/oauth/callback/debug", page);
  app.get("/callback", page);
  app.get("/settings/integrations/github/callback", page);
  app.get("/api/web/score/runs/:token", (c) => c.json({ ok: true }));
  return app;
}

async function referrerPolicyFor(path: string) {
  const res = await createProductionOrderApp().request(path, {
    headers: { Host: "app.mcpjam.com" },
  });
  expect(res.status).toBe(200);
  return res.headers.get("Referrer-Policy");
}

describe("Referrer-Policy on credential pages", () => {
  it.each([
    "/results/tok_abc",
    "/bench/results/sec_abc",
    "/conformance/shared/tok_abc",
    "/user-testing/study_1/tok_abc",
    "/api/web/score/runs/tok_abc",
    // Callback routes, with and without their one-time code.
    "/oauth/callback?code=abc&state=xyz",
    "/oauth/callback",
    "/oauth/callback/debug?code=abc",
    "/callback?code=abc",
    "/settings/integrations/github/callback?code=abc&state=xyz",
    // A secret query key on any path.
    "/?code=abc",
    "/projects/p1?_token=abc",
    "/projects/p1?access_token=abc",
    "/projects/p1?X-Amz-Signature=abc",
    // A credential URL nested in a parameter's value.
    "/projects/p1?redirect=%2Fresults%2Ftok_abc",
  ])("sets no-referrer on %s, over the global policy", async (path) => {
    expect(await referrerPolicyFor(path)).toBe("no-referrer");
  });

  it.each([
    "/",
    "/projects/p1",
    "/projects/p1?tab=servers",
    "/user-testing/study_1/edit",
  ])("keeps the global policy on %s", async (path) => {
    expect(await referrerPolicyFor(path)).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("sets no-referrer on a credential page served from a landing host", async () => {
    const res = await createProductionOrderApp().request("/results/tok_abc", {
      headers: { Host: "score.mcpjam.com" },
    });
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});
