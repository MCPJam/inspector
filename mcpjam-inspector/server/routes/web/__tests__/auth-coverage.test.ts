import { describe, it, expect } from "vitest";
import webRoutes from "../index.js";
import { createWebTestApp } from "./helpers/test-app.js";

/**
 * No route on `/api/web` may ANSWER a caller who presents no credential,
 * unless it is listed below with a reason.
 *
 * This exists because of MJ-002. `/api/web/audio/transcriptions` shipped with
 * no `bearerAuthMiddleware` mount while its ~25 sibling MCP-operation families
 * had one, and the gap was invisible in review: an exemption expressed as a
 * MISSING line in a file of present ones. Nothing failed when that route was
 * added, and nothing would have failed if a second one were added the same way.
 * This is the test that fails.
 *
 * It is deliberately BEHAVIOURAL — it sends a request and reads the status —
 * rather than asserting that a `.use()` is registered. `/export/server` carries
 * no `.use()` and still refuses, because it forwards the bearer to Convex,
 * which rejects. A structural check on middleware registration would both miss
 * real holes and fire on safe routes.
 *
 * ## What this does and does not prove
 *
 * The invariant is "no route SUCCEEDS without a credential" — no 2xx — which is
 * exactly the MJ-002 shape: that finding was a `200` with a transcript in it.
 *
 * It deliberately does not assert a particular refusal code. This suite has no
 * Convex, so a route whose first act is an upstream call fails on that instead
 * of on its bearer check, and which of the two happens first is not stable
 * across environments. Pinning 401 here would make the suite fail for reasons
 * that have nothing to do with auth. The narrow, deterministic 401 assertions
 * for the route this finding was about live in `audio-auth.test.ts`, where the
 * bearer middleware is the first thing the request meets.
 *
 * So: a route's ABSENCE from the list below is not a claim that it requires a
 * bearer. It is a claim that it does not hand an anonymous caller a success.
 *
 * Adding to `PUBLIC_SUCCESS_ROUTES` is a security decision, not a way to make
 * this test pass. Each entry names why an anonymous 2xx is correct there.
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes that correctly return a SUCCESS to a caller with no `Authorization`
 * header, and why. Both are documented as deliberately open at their mount in
 * `../index.ts`.
 */
const PUBLIC_SUCCESS_ROUTES = new Map<string, string>([
  [
    "GET /api/web/apps/mcp-apps/sandbox-proxy",
    "a static sandbox document, needed by the MCP-apps renderer before any authed flow",
  ],
  [
    "GET /api/web/computers/config",
    "returns only a boolean and a public URL; the client needs it pre-auth to find the terminal",
  ],
]);

/** `:param` -> a concrete segment so the router actually matches the route. */
function concretePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)\??/g, "probe");
}

type Probe = { key: string; method: string; path: string };

function probes(): Probe[] {
  const seen = new Set<string>();
  const out: Probe[] = [];
  for (const route of webRoutes.routes) {
    const method = route.method.toUpperCase();
    // `.use()` middleware registers as ALL; wildcards are not real endpoints.
    if (!HTTP_METHODS.has(method)) continue;
    if (route.path.includes("*")) continue;

    const key = `${method} /api/web${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, method, path: `/api/web${concretePath(route.path)}` });
  }
  return out;
}

describe("/api/web — credential-less requests", () => {
  it("enumerates a plausible number of routes", () => {
    // Guards against the sweep below passing because it found nothing: an
    // empty inventory would assert nothing at all.
    expect(probes().length).toBeGreaterThan(80);
  });

  it("never succeeds on a route that is not documented as public", async () => {
    const { app } = createWebTestApp();
    const succeeded: string[] = [];

    for (const probe of probes()) {
      if (PUBLIC_SUCCESS_ROUTES.has(probe.key)) continue;

      const response = await app.request(probe.path, {
        method: probe.method,
        headers: { "Content-Type": "application/json" },
        // A body for the verbs that take one, so a route cannot appear to
        // refuse merely because its parse failed.
        ...(probe.method === "GET" || probe.method === "DELETE"
          ? {}
          : { body: "{}" }),
      });

      if (response.status >= 200 && response.status < 300) {
        succeeded.push(`${probe.key} -> ${response.status}`);
      }
    }

    // Named, not counted: the failure message has to say which route, or
    // whoever hits it cannot act on it.
    expect(succeeded).toEqual([]);
  });

  it("has no stale entries in the public list", () => {
    // An allowlist that outlives its route is how a future exemption gets
    // granted by accident.
    const keys = new Set(probes().map((probe) => probe.key));
    const stale = [...PUBLIC_SUCCESS_ROUTES.keys()].filter(
      (key) => !keys.has(key)
    );
    expect(stale).toEqual([]);
  });
});
