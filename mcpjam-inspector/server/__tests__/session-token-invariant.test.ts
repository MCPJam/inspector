import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * THE SESSION TOKEN NEVER REACHES A TUNNEL.
 *
 * The session token authenticates every local `/api/*` call. A tunnel exposes
 * the MCP adapter surface to the public internet, where the only credential a
 * remote client is meant to hold is the `?k=` bearer in the tunnel URL. Hand
 * the session token down that pipe and anyone with the tunnel URL owns the
 * whole Inspector API.
 *
 * `mayServeSessionToken` is the one decision point that enforces this, and it
 * vetoes tunnel hosts BEFORE consulting the allowlist — so even a
 * `MCPJAM_ALLOWED_HOSTS` misconfiguration that names a tunnel domain cannot
 * open the hole. `server/index.ts` used it. `server/app.ts` — the Electron and
 * embedded entry point — called the raw `isAllowedHost` instead, which is the
 * same allowlist WITHOUT the veto, and its HTML path did not even look at
 * `X-Forwarded-Host`, which is where the relay edge puts the real tunnel host.
 *
 * These tests exercise the real app so the two entries cannot drift apart
 * again by construction. The companion source-text parity test
 * (`entrypoint-parity.test.ts`) asserts BOTH files still reference
 * `mayServeSessionToken` at all, which is the check that survives someone
 * refactoring this route out from under these assertions.
 */

/**
 * The REAL token, learned once from the one host allowed to have it.
 *
 * This used to assert against `/__MCP_SESSION_TOKEN__/` — the placeholder the
 * HTML injection replaces. That string is what a NON-leaking document
 * contains; a leaking one contains the token in its place, and the JSON route
 * never contains the placeholder at all. So the assertion held whether or not
 * the bug was present. Comparing against the issued value is the only form of
 * this check that can fail.
 */
let issuedToken: string;

// Every tunnel shape the relay can present, and the two headers it can present
// them in. `X-Forwarded-Host` is the one that actually matters in production:
// the edge terminates TLS, so `Host` by then is the local listener.
const TUNNEL_HOSTS = [
  "abc123.tunnels.mcpjam.com",
  "quiet-otter.ngrok.app",
  "legacy.ngrok.io",
];

type App = { fetch: (request: Request) => Response | Promise<Response> };

/**
 * Boot a fresh app with a given allowlist.
 *
 * `ALLOWED_HOSTS` is read once at `config.ts` module scope, so changing it
 * means a fresh module registry — which is exactly what makes the
 * misconfiguration case below testable at all.
 */
async function bootApp(allowedHosts: string): Promise<App> {
  vi.resetModules();
  // Non-hosted, non-production: the Electron/dev shape, the one where
  // `/api/session-token` actually serves rather than 410-ing.
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ELECTRON_APP", "");
  vi.stubEnv("MCPJAM_ALLOWED_HOSTS", allowedHosts);

  const { createHonoApp } = await import("../app.js");
  return (await createHonoApp()).app;
}

let app: App;

beforeAll(async () => {
  app = await bootApp("");
  const response = await app.fetch(
    new Request("http://localhost:6274/api/session-token", {
      headers: { Host: "localhost:6274" },
    })
  );
  issuedToken = ((await response.json()) as { token: string }).token;
  // A blank or trivially short token would make every assertion below pass by
  // matching nothing — fail loudly instead of quietly proving nothing.
  expect(typeof issuedToken).toBe("string");
  expect(issuedToken.length).toBeGreaterThan(16);
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
});

function get(path: string, headers: Record<string, string>, target = app) {
  return target.fetch(new Request(`http://localhost:6274${path}`, { headers }));
}

describe("/api/session-token", () => {
  it("serves the token to localhost", async () => {
    const response = await get("/api/session-token", { Host: "localhost:6274" });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("token");
  });

  it.each(TUNNEL_HOSTS)("denies a tunnel Host (%s)", async (host) => {
    const response = await get("/api/session-token", { Host: host });
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(issuedToken);
  });

  it.each(TUNNEL_HOSTS)(
    "denies a tunnel X-Forwarded-Host behind a localhost Host (%s)",
    async (forwarded) => {
      // The production shape. `Host` is the local listener the edge dialed;
      // the public tunnel hostname survives only in `X-Forwarded-Host`. Before
      // this route consulted it, this exact request returned the token.
      const response = await get("/api/session-token", {
        Host: "localhost:6274",
        "X-Forwarded-Host": forwarded,
      });
      expect(response.status).toBe(403);
    }
  );

  it("denies a non-allowlisted public host", async () => {
    const response = await get("/api/session-token", {
      Host: "evil.example.com",
    });
    expect(response.status).toBe(403);
  });
});

// The allowlist (`MCPJAM_ALLOWED_HOSTS`) now applies in self-hosted mode too
// (BB-118): a self-hosted operator can name their own LAN host so the inspector
// is reachable over the network. The tunnel veto still runs first, so a tunnel
// domain wrongly added to the allowlist can never leak the token — covered
// directly in `server/utils/__tests__/localhost-check.test.ts` ("SECURITY
// INVARIANT: denies a tunnel host even when allowlisted"), where the decision
// actually lives. The route-level positive/negative cases are below.
describe("/api/session-token with MCPJAM_ALLOWED_HOSTS (self-hosted)", () => {
  it("serves the token to an allowlisted LAN host in self-hosted mode", async () => {
    const allowlisted = await bootApp("192.168.1.50");
    const response = await get(
      "/api/session-token",
      { Host: "192.168.1.50:6274" },
      allowlisted
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("token");
  });

  it("still denies a host that isn't in the allowlist", async () => {
    const allowlisted = await bootApp("192.168.1.50");
    const response = await get(
      "/api/session-token",
      { Host: "192.168.1.99:6274" },
      allowlisted
    );
    expect(response.status).toBe(403);
  });

  it("still denies a tunnel host even when its domain is allowlisted", async () => {
    const misconfigured = await bootApp("*.tunnels.mcpjam.com");
    const response = await get(
      "/api/session-token",
      { Host: "abc123.tunnels.mcpjam.com" },
      misconfigured
    );
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(issuedToken);
  });
});

describe("the injected document", () => {
  // In this env the app serves the dev JSON root rather than index.html, so
  // the assertion that carries weight is the negative one: whatever this path
  // returns for a tunnel host, it never contains the ISSUED token. That holds
  // for both branches, which is what makes it worth pinning here — and unlike
  // the placeholder it replaced, it is a string a leak would actually emit.
  it.each(TUNNEL_HOSTS)("never carries the token for %s", async (host) => {
    const cases: Record<string, string>[] = [
      { Host: host },
      { Host: "localhost:6274", "X-Forwarded-Host": host },
    ];
    for (const headers of cases) {
      const response = await get("/", headers);
      expect(await response.text()).not.toContain(issuedToken);
    }
  });
});
