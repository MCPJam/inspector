import { describe, it, expect } from "vitest";
import type { Hono } from "hono";
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
 * Be concrete about how much that is worth. Of the routes swept at the time of
 * writing, 95 answer 401 and 6 answer 403 — those are genuinely refusing. Seven
 * answer 5xx because their upstream is absent here, and for those seven this
 * suite proves only "not a success", not "checks a bearer". Three answer 400
 * on body validation, which likewise runs ahead of any upstream. Narrowing that
 * gap needs a Convex stub, not a stricter assertion over the same responses.
 *
 * The one thing that must never be silent is a probe that fails to reach its
 * handler; that is asserted separately below.
 *
 * Adding to `PUBLIC_SUCCESS_ROUTES` is a security decision, not a way to make
 * this test pass. Each entry names why an anonymous 2xx is correct there.
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE"]);
/** What an `.all()` route accepts, so every branch of one gets probed. */
const ALL_ROUTE_METHODS = ["POST", "GET", "HEAD", "PUT", "PATCH", "DELETE"];

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

/**
 * Routes that answer a credential-less request with something other than
 * 401/403, and why.
 *
 * READ THIS AS THE LIST OF THINGS THE SWEEP DOES NOT VERIFY. Every entry is a
 * route whose refusal — if it refuses at all — this harness cannot observe:
 * there is no Convex, so an absent upstream reads as 500/503, and a `{}` body
 * reads as 400 on a route that validates before it authenticates. Several of
 * these legitimately answer 2xx to an anonymous caller in production. Naming
 * them keeps that a decision rather than an artifact of the test environment.
 */
const NON_AUTH_REFUSALS = new Map<string, string>([
  [
    "POST /api/web/guest-session",
    "public by design — minting a guest bearer is how an anonymous caller becomes an authenticated one; the 500 here is the absent Convex, not a refusal",
  ],
  [
    "POST /api/web/guest-session/revoke",
    "same router as the mint; 500 is the absent Convex",
  ],
  [
    "POST /api/web/guest-session/promotion-proof",
    "same router as the mint; 500 is the absent Convex",
  ],
  [
    "GET /api/web/guest-jwks",
    "public JWKS — a verifier fetches it before holding any credential; 503 is the absent Convex",
  ],
  [
    "GET /api/web/conformance-shared/:token",
    "the token in the path IS the credential; 500 is the absent Convex",
  ],
  [
    "GET /api/web/score/runs/:token",
    "the token in the path IS the credential; 503 is the absent Convex",
  ],
  [
    "GET /api/web/bench/results/:secret",
    "the secret in the path IS the credential; 503 is the absent Convex",
  ],
  [
    "POST /api/web/score/runs",
    "400 on the probe body — validates before it authenticates, so the sweep cannot see which it would do with a real payload",
  ],
  [
    "POST /api/web/caniuse/subscribe",
    "public submission endpoint; 400 is the probe body failing validation",
  ],
  [
    "POST /api/web/caniuse/report-inconsistency",
    "public submission endpoint; 400 is the probe body failing validation",
  ],
]);

/**
 * Render a registered path into one a request can actually hit: `:param` and
 * any `*` become a concrete segment.
 *
 * Wildcards are RENDERED, not skipped: `harnessMcp.all("/:serverId/*")` is a
 * callable endpoint, and so is any future `web.get("/foo/*", handler)`.
 * Skipping them would leave exactly the blind spot this suite exists to close.
 */
function concretePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)\??/g, "probe").replace(/\*/g, "probe");
}

/**
 * Marks a response as "nothing matched this path". Hono records `.use()`
 * middleware and `.all()` handlers identically — both are method `ALL` — so
 * there is no structural way to tell a callable endpoint from a middleware
 * mount. (Handler arity happens to differ today, which is a coincidence of how
 * the functions are written, not a contract.)
 *
 * So don't classify them statically: ask the router. Send the request and see
 * whether anything answers. A middleware-only path falls through to this
 * sentinel; an `.all()` endpoint answers for itself. That is also the only
 * question the sweep actually cares about — "can an anonymous caller get a
 * response here" — and it is why `harnessMcp.all("/:serverId")` is now covered.
 */
const UNROUTED_HEADER = "x-probe-unrouted";

function withSentinel(app: Hono): Hono {
  // On a HEADER, not in the body: `HEAD` responses carry no body, and reading
  // the marker out of JSON would make every unrouted HEAD look like an answer.
  app.notFound((c) => c.body(null, 404, { [UNROUTED_HEADER]: "1" }));
  return app;
}

function isUnrouted(response: Response): boolean {
  return response.headers.get(UNROUTED_HEADER) === "1";
}

type Probe = {
  key: string;
  /** Methods to try. An `ALL` route answers any of them. */
  methods: string[];
  path: string;
  /** True when registered against a concrete verb, so it must be reachable. */
  isConcreteVerb: boolean;
};

function probes(): Probe[] {
  const seen = new Set<string>();
  const out: Probe[] = [];
  for (const route of webRoutes.routes) {
    const method = route.method.toUpperCase();
    const isConcreteVerb = HTTP_METHODS.has(method);
    // Everything else is `ALL` — either `.use()` middleware or an `.all()`
    // endpoint. Probed either way; the sentinel sorts them out at runtime.
    if (!isConcreteVerb && method !== "ALL") continue;

    const key = `${method} /api/web${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      methods: isConcreteVerb ? [method] : ALL_ROUTE_METHODS,
      path: `/api/web${concretePath(route.path)}`,
      isConcreteVerb,
    });
  }
  return out;
}

/**
 * EVERY method that answered, not the first.
 *
 * An `.all()` handler is free to branch on the verb, and one of those branches
 * answering 2xx to an anonymous caller is exactly the hole this suite hunts.
 * `harnessMcp.all("/:serverId")` is that shape today: POST speaks JSON-RPC
 * while GET/HEAD return a 200 event-stream. Stopping at the first answer would
 * check POST, see a refusal, and never look at the branch that returns 200.
 */
async function probeResponses(
  app: Hono,
  probe: Probe,
): Promise<Array<{ method: string; response: Response }>> {
  const answered: Array<{ method: string; response: Response }> = [];
  for (const method of probe.methods) {
    const response = await app.request(probe.path, {
      method,
      headers: { "Content-Type": "application/json" },
      // A body for the verbs that take one, so a route cannot appear to refuse
      // merely because its parse failed.
      ...(BODYLESS_METHODS.has(method) ? {} : { body: "{}" }),
    });
    if (!isUnrouted(response)) answered.push({ method, response });
  }
  return answered;
}

describe("/api/web — credential-less requests", () => {
  it("enumerates a plausible number of routes", () => {
    // Guards against the sweep below passing because it found nothing: an
    // empty inventory would assert nothing at all.
    expect(probes().length).toBeGreaterThan(80);
  });

  it("lands every verb-registered probe on a real handler", async () => {
    // A route registered as GET/POST/… is definitely an endpoint, so if nothing
    // answers it the rendered path missed — and a missed route would sail
    // through the sweep below as a non-2xx "pass", a silent hole in the
    // coverage rather than a result. Checked separately so the failure says
    // which it is: unreachable means `concretePath` is wrong, not the router.
    //
    // Keyed on the sentinel, NOT on the bare status: a matched handler is
    // free to answer 404 for a resource that does not exist, and reading that
    // as a routing miss would fail this suite for a route that is working.
    const app = withSentinel(createWebTestApp().app);
    const unreachable: string[] = [];

    for (const probe of probes()) {
      if (!probe.isConcreteVerb) continue;
      const answered = await probeResponses(app, probe);
      if (answered.length === 0) unreachable.push(probe.key);
    }

    expect(unreachable).toEqual([]);
  });

  it("never succeeds on a route that is not documented as public", async () => {
    const app = withSentinel(createWebTestApp().app);
    const succeeded: string[] = [];

    for (const probe of probes()) {
      if (PUBLIC_SUCCESS_ROUTES.has(probe.key)) continue;

      // Every method that answered is checked. An empty list is a
      // middleware-only mount, not an endpoint; the verb-registered routes are
      // held to reachability in the test above.
      for (const { method, response } of await probeResponses(app, probe)) {
        if (response.status >= 200 && response.status < 300) {
          succeeded.push(`${probe.key} [${method}] -> ${response.status}`);
        }
      }
    }

    // Named, not counted: the failure message has to say which route, or
    // whoever hits it cannot act on it.
    expect(succeeded).toEqual([]);
  });

  /**
   * The sweep above only proves "not 2xx", and in this harness that is weaker
   * than it looks: there is no Convex, so a route can answer 500 or 503
   * because its upstream is absent rather than because it refused anyone.
   * `POST /guest-session` is the clearest case — it is deliberately public
   * (minting a bearer is how an anonymous caller becomes an authenticated
   * one), it answers 500 here, and it would answer 200 to the same
   * credential-less caller in production. Counting that as a refusal is how a
   * clean run can be reported over routes the sweep never actually tested.
   *
   * So the invariant is tightened: refuse with an AUTH status, or be NAMED
   * below with the reason you do something else. Each entry turns a silent
   * pass into a decision someone wrote down, and a new unauthenticated route
   * whose upstream happens to break in test can no longer hide behind a 500.
   */
  it("refuses with an auth status, or is named as refusing some other way", async () => {
    const app = withSentinel(createWebTestApp().app);
    const unexplained: string[] = [];

    for (const probe of probes()) {
      if (PUBLIC_SUCCESS_ROUTES.has(probe.key)) continue;
      if (NON_AUTH_REFUSALS.has(probe.key)) continue;

      for (const { method, response } of await probeResponses(app, probe)) {
        if (response.status === 401 || response.status === 403) continue;
        // 2xx is the sweep above's business, not this test's.
        if (response.status >= 200 && response.status < 300) continue;
        unexplained.push(`${method} ${probe.path} -> ${response.status}`);
      }
    }

    expect(unexplained).toEqual([]);
  });

  it("has no stale entries in the non-auth refusal list", () => {
    // An entry that outlives its route hides the next one that needs looking at.
    const keys = new Set(probes().map((probe) => probe.key));
    const stale = [...NON_AUTH_REFUSALS.keys()].filter((key) => !keys.has(key));
    expect(stale).toEqual([]);
  });

  it("has no stale entries in the public list", () => {
    // An allowlist that outlives its route is how a future exemption gets
    // granted by accident.
    const keys = new Set(probes().map((probe) => probe.key));
    const stale = [...PUBLIC_SUCCESS_ROUTES.keys()].filter(
      (key) => !keys.has(key),
    );
    expect(stale).toEqual([]);
  });
});
