/**
 * Indexing Headers Middleware Tests
 *
 * The thing worth pinning here is the host exemption. `caniuse.dev` and
 * `score.mcpjam.com` are answered by this same process and exist to rank, so a
 * host-blind `X-Robots-Tag: noindex` would drop both domains out of Google's
 * index on the next deploy.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { indexingHeadersMiddleware } from "../indexing-headers.js";

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
  ])("marks %s%s noindex", async (host, path) => {
    expect(await robotsTagFor(path, host)).toBe("noindex");
  });
});
