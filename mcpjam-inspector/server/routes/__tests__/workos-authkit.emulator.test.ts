/**
 * The AuthKit session bridge (`server/routes/workos-authkit.ts`) driven end to
 * end against a real WorkOS API.
 *
 * The sibling suite stubs `global.fetch` and hands the route a canned
 * `{ access_token, refresh_token }`, which is enough to prove the cookie jar is
 * written and is silent on everything the proxy exists for: that a PKCE code
 * actually exchanges, that the token it returns verifies against the issuer's
 * JWKS, that a refresh really rotates, and that replaying a spent refresh token
 * is refused so the jar gets cleared. Those are all WorkOS behaviours, and a
 * stub can only assert we believe in them.
 *
 * Requests target `http://localhost:6274` deliberately: that is what
 * `isLocalHttpUrl` keys the multi-origin cookie jar off, and the hosted branch
 * writes a different cookie entirely.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import workosAuthkitRoutes from "../workos-authkit.js";
import { verifyAuthKitToken } from "../../services/authkit-jwt.js";
import {
  SEED,
  cookieHeaderFrom,
  createPkcePair,
  setCookieFor,
  startWorkosEmulator,
  type WorkosEmulatorHandle,
} from "../../test/support/workos-emulator.js";

const ORIGIN = "http://localhost:6274";
const REDIRECT_URI = `${ORIGIN}/callback`;
const SESSION_COOKIE = "mcpjam_workos_sessions";
const HAS_SESSION_COOKIE = "workos-has-session";

let h: WorkosEmulatorHandle;

beforeAll(async () => {
  h = await startWorkosEmulator();
}, 30_000);

afterAll(async () => {
  await h?.close();
});

function createApp(): Hono {
  const app = new Hono();
  app.route("/user_management", workosAuthkitRoutes);
  return app;
}

/** Front-channel through the proxy, ending at the code the callback receives. */
async function authorizeThroughProxy(app: Hono, state = "test-state") {
  const { verifier, challenge } = createPkcePair();
  const query = new URLSearchParams({
    client_id: h.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    provider: "authkit",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    login_hint: SEED.user.email,
  });

  const redirect = await app.request(
    `${ORIGIN}/user_management/authorize?${query.toString()}`,
  );
  const location = redirect.headers.get("location");
  if (!location) throw new Error(`no redirect: ${redirect.status}`);

  const upstream = await fetch(location, { redirect: "manual" });
  const callback = new URL(upstream.headers.get("location") ?? "");
  return { verifier, redirect, location, callback };
}

async function exchangeThroughProxy(
  app: Hono,
  args: { code: string; verifier: string },
) {
  return app.request(`${ORIGIN}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: h.clientId,
      grant_type: "authorization_code",
      code: args.code,
      code_verifier: args.verifier,
    }),
  });
}

describe("authorize", () => {
  it("forwards the browser to WorkOS with the query intact", async () => {
    const app = createApp();
    const { redirect, location, callback } = await authorizeThroughProxy(
      app,
      "xyz",
    );

    expect(redirect.status).toBe(302);
    const forwarded = new URL(location);
    expect(`${forwarded.origin}${forwarded.pathname}`).toBe(
      `${h.url}/user_management/authorize`,
    );
    // The PKCE challenge and client id must survive the hop, or the exchange
    // below fails with an error that looks like a client bug.
    expect(forwarded.searchParams.get("client_id")).toBe(h.clientId);
    expect(forwarded.searchParams.get("code_challenge_method")).toBe("S256");

    // ...and WorkOS sends the browser back to us with a code.
    expect(callback.origin).toBe(ORIGIN);
    expect(callback.pathname).toBe("/callback");
    expect(callback.searchParams.get("code")).toEqual(expect.any(String));
    expect(callback.searchParams.get("state")).toBe("xyz");
  }, 30_000);
});

describe("code exchange", () => {
  it("returns a verifiable session and stores the refresh token in an HttpOnly cookie", async () => {
    const app = createApp();
    const { verifier, callback } = await authorizeThroughProxy(app);

    const res = await exchangeThroughProxy(app, {
      code: callback.searchParams.get("code")!,
      verifier,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      user: { email: string };
    };
    expect(body.user.email).toBe(SEED.user.email);

    // The issuer is the one `authkitIssuerJwks` already trusts, and the JWKS
    // now resolves through WORKOS_API_BASE_URL — so this proves the token our
    // own verifier accepts is the token the flow actually produced.
    const claims = decodeJwt(body.access_token);
    expect(claims.iss).toBe(
      `https://api.workos.com/user_management/${h.clientId}`,
    );
    expect(claims.aud).toBe(h.clientId);
    await expect(verifyAuthKitToken(body.access_token)).resolves.toMatchObject({
      sub: SEED.user.id,
    });

    // The refresh token must not be readable by scripts on the page; that is
    // the entire reason this proxy holds it instead of the browser.
    expect(setCookieFor(res, SESSION_COOKIE)).toContain("HttpOnly");
    expect(setCookieFor(res, HAS_SESSION_COOKIE)).toContain(
      `${HAS_SESSION_COOKIE}=true`,
    );
  }, 30_000);
});

describe("refresh", () => {
  it("rotates on a cookie-only refresh, and clears the jar when a spent token is replayed", async () => {
    const app = createApp();
    const { verifier, callback } = await authorizeThroughProxy(app);
    const exchanged = await exchangeThroughProxy(app, {
      code: callback.searchParams.get("code")!,
      verifier,
    });
    const firstJar = cookieHeaderFrom(exchanged, [SESSION_COOKIE]);
    const firstBody = (await exchanged.json()) as { refresh_token: string };

    // No refresh_token in the body: the whole point is that the client does
    // not hold one and the proxy supplies it from the cookie.
    const refreshed = await app.request(
      `${ORIGIN}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: firstJar },
        body: JSON.stringify({
          client_id: h.clientId,
          grant_type: "refresh_token",
        }),
      },
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = (await refreshed.json()) as { refresh_token: string };
    expect(refreshedBody.refresh_token).not.toBe(firstBody.refresh_token);

    // Replay the now-spent token by sending the STALE jar. WorkOS rotates on
    // every refresh, so this is what a stolen or duplicated cookie looks like.
    const replayed = await app.request(
      `${ORIGIN}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: firstJar },
        body: JSON.stringify({
          client_id: h.clientId,
          grant_type: "refresh_token",
        }),
      },
    );
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });

    // A dead session must not leave a jar behind, or the app renders
    // signed-in chrome over a connection WorkOS has already de-authenticated.
    expect(setCookieFor(replayed, SESSION_COOKIE)).toContain("Max-Age=0");
    expect(setCookieFor(replayed, HAS_SESSION_COOKIE)).toContain("Max-Age=0");
  }, 30_000);

  it("refuses a refresh when no session cookie is present", async () => {
    const res = await createApp().request(
      `${ORIGIN}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: h.clientId,
          grant_type: "refresh_token",
        }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error_description: "No local WorkOS session",
    });
  }, 30_000);
});

describe("logout", () => {
  it("clears the jar and hands the browser on to WorkOS", async () => {
    const app = createApp();
    const { verifier, callback } = await authorizeThroughProxy(app);
    const exchanged = await exchangeThroughProxy(app, {
      code: callback.searchParams.get("code")!,
      verifier,
    });
    const jar = cookieHeaderFrom(exchanged, [SESSION_COOKIE]);
    const { sid } = decodeJwt(
      ((await exchanged.json()) as { access_token: string }).access_token,
    ) as { sid?: string };

    const res = await app.request(
      `${ORIGIN}/user_management/sessions/logout?session_id=${sid ?? "session_x"}&return_to=${encodeURIComponent(`${ORIGIN}/`)}`,
      { headers: { Cookie: jar } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      `${h.url}/user_management/sessions/logout`,
    );
    expect(setCookieFor(res, SESSION_COOKIE)).toContain("Max-Age=0");

    // And WorkOS really does send the browser back where we asked.
    const upstream = await fetch(res.headers.get("location")!, {
      redirect: "manual",
    });
    expect(upstream.headers.get("location")).toContain(ORIGIN);
  }, 30_000);
});
