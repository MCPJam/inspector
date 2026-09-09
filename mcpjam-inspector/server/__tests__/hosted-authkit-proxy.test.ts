import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE AUTHKIT PROXY IS MOUNTED IN HOSTED MODE.
 *
 * AuthKit's `initialize()` makes no network call whatsoever unless the page's
 * own cookies carry `workos-has-session` (see `create-client.ts` in
 * `@workos-inc/authkit-js`), and only a same-origin response can set that
 * cookie. A hosted deployment whose AuthKit points straight at
 * `api.workos.com` therefore reads as permanently signed out: sign-in
 * succeeds, and the very next page load falls back to a guest with no error
 * and no failed request to show for it. That was staging for months.
 *
 * `/user_management` was gated behind `!HOSTED_MODE`, so the proxy that makes
 * the cookie first-party existed but could never run where it was needed.
 * These tests boot the real app with hosted mode on and assert the route is
 * reachable — the gate cannot come back without turning this red.
 */

type App = { fetch: (request: Request) => Response | Promise<Response> };

async function bootHostedApp(): Promise<App> {
  vi.resetModules();
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ELECTRON_APP", "");
  vi.stubEnv("MCPJAM_WORKOS_SESSION_SECRET", "test-workos-session-secret");

  const { createHonoApp } = await import("../app.js");
  return (await createHonoApp()).app;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted mode AuthKit proxy", () => {
  it("mounts /user_management/authenticate", async () => {
    const app = await bootHostedApp();

    const response = await app.fetch(
      new Request("https://staging.mcpjam.com/user_management/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "refresh_token",
        }),
      }),
    );

    // 400 "No local WorkOS session" is the handler answering: there is no
    // session cookie on this bare request. What matters is that the route
    // EXISTS — a 404 is the gated build, which is the regression.
    expect(response.status).not.toBe(404);
    expect(await response.json()).toEqual({
      error_description: "No local WorkOS session",
    });
  }, 120_000);

  it("mounts /user_management/authorize", async () => {
    const app = await bootHostedApp();

    const response = await app.fetch(
      new Request(
        "https://staging.mcpjam.com/user_management/authorize?client_id=client_123",
        { redirect: "manual" },
      ),
    );

    // Redirects the browser on to WorkOS proper. Again: not a 404.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("api.workos.com");
  }, 120_000);
});
