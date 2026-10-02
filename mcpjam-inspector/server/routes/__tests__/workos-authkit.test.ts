import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { revokeAuthKitSessionMock } = vi.hoisted(() => ({
  revokeAuthKitSessionMock: vi.fn(),
}));

vi.mock("../../services/auth-session-revocation.js", () => ({
  revokeAuthKitSession: revokeAuthKitSessionMock,
}));

import workosAuthkitRoutes from "../workos-authkit.js";
import { getLocalSessionNamespace } from "../../utils/local-session-namespace.js";
import {
  WORKOS_SCOPED_COOKIE_MAX_AGE_S,
  scopedCookieName,
  unsealScopedCookie,
} from "../../utils/scoped-cookies.js";

const ORIGINAL_FETCH = global.fetch;
const ENV_KEYS = [
  "MCPJAM_WORKOS_SESSION_SECRET",
  "WORKOS_CLIENT_ID",
  "VITE_WORKOS_CLIENT_ID",
  "CONVEX_HTTP_URL",
  "MCPJAM_BROWSER_PORT",
] as const;
const LOCAL = "http://localhost:6274";
const CLIENT_ID = "client_123";

function createTestApp() {
  const app = new Hono();
  app.route("/user_management", workosAuthkitRoutes);
  return app;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The ONE `Set-Cookie` header that carries `name`, with its own attributes. */
function setCookieFor(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
}

/** A browser cookie jar: what the host-wide `localhost` jar holds. */
class Jar {
  readonly cookies = new Map<string, string>();
  apply(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [nameValue, ...attributes] = header.split(";").map((p) => p.trim());
      const eq = nameValue!.indexOf("=");
      const name = nameValue!.slice(0, eq);
      const value = nameValue!.slice(eq + 1);
      if (!value || attributes.some((a) => /^max-age=0$/i.test(a))) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
  header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

function useInstance(browserPort: number): string {
  process.env.MCPJAM_BROWSER_PORT = String(browserPort);
  return scopedCookieName("workos", getLocalSessionNamespace().id);
}

function codeExchange(app: Hono, jar?: Jar, clientId = CLIENT_ID) {
  return app.request(`${LOCAL}/user_management/authenticate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jar ? { Cookie: jar.header() } : {}),
    },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "authorization_code",
      code: "code_123",
      code_verifier: "verifier_123",
    }),
  });
}

function refresh(app: Hono, jar: Jar, extra: Record<string, string> = {}) {
  return app.request(`${LOCAL}/user_management/authenticate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: jar.header(),
      ...extra,
    },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token" }),
  });
}

function logout(app: Hono, jar: Jar) {
  return app.request(
    `${LOCAL}/user_management/sessions/logout?session_id=session_123`,
    { headers: { Cookie: jar.header() } },
  );
}

function tokens(refreshToken: string) {
  return jsonResponse({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    user: { id: "user_1" },
  });
}

describe("workos authkit local session bridge", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MCPJAM_WORKOS_SESSION_SECRET = "test-workos-session-secret";
    process.env.WORKOS_CLIENT_ID = CLIENT_ID;
    delete process.env.VITE_WORKOS_CLIENT_ID;
    process.env.CONVEX_HTTP_URL = "https://backend-a.convex.site";
    process.env.MCPJAM_BROWSER_PORT = "5173";
    global.fetch = vi.fn();
    revokeAuthKitSessionMock.mockReset();
    revokeAuthKitSessionMock.mockResolvedValue({ revoked: true });
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("stores the refresh token sealed in THIS namespace's cookie, renewable for 30 days", async () => {
    const name = useInstance(5173);
    vi.mocked(fetch).mockResolvedValueOnce(tokens("refresh-token-1"));

    const res = await codeExchange(createTestApp());
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { refresh_token?: string }).refresh_token,
    ).toBe("refresh-token-1");

    const cookie = setCookieFor(res, name)!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Max-Age=${WORKOS_SCOPED_COOKIE_MAX_AGE_S}`);
    expect(cookie).not.toContain("refresh-token-1");
    const value = cookie.split(";")[0]!.slice(name.length + 1);
    expect(
      unsealScopedCookie({
        kind: "workos",
        nsId: getLocalSessionNamespace().id,
        value,
      }),
    ).toEqual({ refreshToken: "refresh-token-1" });

    // The host-wide hint is an EXPIRING hint, readable by AuthKit.
    const hint = setCookieFor(res, "workos-has-session")!;
    expect(hint).toContain("workos-has-session=1");
    expect(hint).toContain(`Max-Age=${WORKOS_SCOPED_COOKIE_MAX_AGE_S}`);
    expect(hint).not.toContain("HttpOnly");
    // No shared jar any more.
    expect(setCookieFor(res, "mcpjam_workos_sessions")).toBeUndefined();
  });

  it("uses this namespace's cookie on hard-refresh recovery", async () => {
    useInstance(5173);
    const app = createTestApp();
    const jar = new Jar();
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokens("refresh-token-1"))
      .mockResolvedValueOnce(tokens("refresh-token-2"));
    jar.apply(await codeExchange(app));

    const res = await refresh(app, jar);
    expect(res.status).toBe(200);
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-token-1",
    });
  });

  describe("client_id must be this server's", () => {
    it("refuses an authenticate request for another client, without calling WorkOS", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(tokens("never"));
      const res = await codeExchange(
        createTestApp(),
        undefined,
        "client_other",
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error_description: "client_id does not match this server",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it("refuses an authorize redirect for another client", async () => {
      const res = await createTestApp().request(
        `${LOCAL}/user_management/authorize?client_id=client_other&code_challenge=abc`,
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it("redirects an authorize request for this client", async () => {
      const res = await createTestApp().request(
        `${LOCAL}/user_management/authorize?client_id=${CLIENT_ID}&code_challenge=abc`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `https://api.workos.com/user_management/authorize?client_id=${CLIENT_ID}&code_challenge=abc`,
      );
    });

    it("answers 503 when this server has no WorkOS client at all", async () => {
      delete process.env.WORKOS_CLIENT_ID;
      const res = await codeExchange(createTestApp());
      expect(res.status).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("a missing session answers 400 and leaves the host-wide hint alone", async () => {
    const res = await refresh(createTestApp(), new Jar());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error_description: "No local WorkOS session",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(setCookieFor(res, "workos-has-session")).toBeUndefined();
  });

  it("Origin/Referer headers cannot select another instance's session", async () => {
    const app = createTestApp();
    const jar = new Jar();
    useInstance(5173);
    vi.mocked(fetch).mockResolvedValueOnce(tokens("refresh-5173"));
    jar.apply(await codeExchange(app));

    // Instance on 5174 receives a request that CLAIMS to come from 5173.
    useInstance(5174);
    const res = await refresh(app, jar, {
      Origin: "http://localhost:5173",
      Referer: "http://localhost:5173/",
      "X-Forwarded-Host": "localhost:5173",
    });
    expect(res.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe("legacy shared cookies", () => {
    it("are deleted on sign-in and never used for refresh (one sign-in after upgrade)", async () => {
      const app = createTestApp();
      const jar = new Jar();
      jar.cookies.set("mcpjam_workos_sessions", "legacy-jar-value");
      jar.cookies.set("mcpjam_workos_session", "older-legacy-value");
      jar.cookies.set("__Host-mcpjam_workos_session", "hosted-style-value");
      jar.cookies.set("workos-has-session", "1");

      // Upgrade: a refresh with only legacy cookies is NOT restored.
      const before = await refresh(app, jar);
      expect(before.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
      jar.apply(before);
      expect(jar.cookies.has("mcpjam_workos_sessions")).toBe(false);
      expect(jar.cookies.has("mcpjam_workos_session")).toBe(false);
      expect(jar.cookies.has("__Host-mcpjam_workos_session")).toBe(false);
      expect(jar.cookies.get("workos-has-session")).toBe("1");

      vi.mocked(fetch).mockResolvedValueOnce(tokens("fresh"));
      jar.apply(await codeExchange(app, jar));
      vi.mocked(fetch).mockResolvedValueOnce(tokens("fresh-2"));
      expect((await refresh(app, jar)).status).toBe(200);
    });
  });

  // A refresh that WorkOS could not answer is not a refresh WorkOS refused.
  // The cookie holds the only copy of the token, so the two have to be told
  // apart here or a blip becomes a sign-out. See `isTransientWorkosFailure`.
  describe("when WorkOS cannot answer a refresh", () => {
    async function signedIn(app: Hono): Promise<{ jar: Jar; name: string }> {
      const name = useInstance(5173);
      const jar = new Jar();
      vi.mocked(fetch).mockResolvedValueOnce(tokens("refresh-token-1"));
      jar.apply(await codeExchange(app));
      return { jar, name };
    }

    it("keeps the stored token through an outage, so the next attempt recovers", async () => {
      const app = createTestApp();
      const { jar, name } = await signedIn(app);
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ error_description: "down" }, 503))
        .mockResolvedValueOnce(tokens("refresh-token-2"));

      const failed = await refresh(app, jar);
      expect(failed.status).toBe(503);
      expect(setCookieFor(failed, name)).toBeUndefined();

      const recovered = await refresh(app, jar);
      expect(recovered.status).toBe(200);
      expect(
        JSON.parse(String(vi.mocked(fetch).mock.calls[2]?.[1]?.body)),
      ).toMatchObject({ refresh_token: "refresh-token-1" });
    });

    it.each([408, 429, 500, 502, 504])(
      "keeps the stored token on a %i",
      async (status) => {
        const app = createTestApp();
        const { jar, name } = await signedIn(app);
        vi.mocked(fetch).mockResolvedValueOnce(
          jsonResponse({ error_description: "Try later" }, status),
        );
        const res = await refresh(app, jar);
        expect(res.status).toBe(status);
        expect(setCookieFor(res, name)).toBeUndefined();
        expect(setCookieFor(res, "workos-has-session")).toBeUndefined();
      },
    );

    it("keeps the stored token when the request never reaches WorkOS", async () => {
      const app = createTestApp();
      const { jar, name } = await signedIn(app);
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(tokens("refresh-token-2"));

      const failed = await refresh(app, jar);
      expect(failed.status).toBe(500);
      expect(setCookieFor(failed, name)).toBeUndefined();

      const recovered = await refresh(app, jar);
      expect(recovered.status).toBe(200);
    });

    it("clears THIS namespace's session when WorkOS rejects the token, but never the host-wide hint", async () => {
      const app = createTestApp();
      const { jar, name } = await signedIn(app);
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: "Refresh token is invalid",
          },
          400,
        ),
      );
      const res = await refresh(app, jar);
      expect(res.status).toBe(400);
      expect(setCookieFor(res, name)).toContain("Max-Age=0");
      expect(setCookieFor(res, "workos-has-session")).toBeUndefined();
    });
  });

  describe("two instances on one host", () => {
    it("log in, refresh, and log out concurrently without overwriting one another", async () => {
      const app = createTestApp();
      const jar = new Jar();
      const nameA = useInstance(5174);
      const nameB = useInstance(5175);
      expect(nameA).not.toBe(nameB);

      const as = async <T>(port: number, run: () => Promise<T>) => {
        useInstance(port);
        return run();
      };

      // Concurrent logins: both requests leave the browser with the SAME
      // snapshot (neither sees the other's cookie), responses land in either
      // order.
      vi.mocked(fetch)
        .mockResolvedValueOnce(tokens("a-1"))
        .mockResolvedValueOnce(tokens("b-1"));
      const snapshot = jar.header();
      const loginA = await as(5174, () =>
        app.request(`${LOCAL}/user_management/authenticate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: snapshot },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: "authorization_code",
            code: "a",
            code_verifier: "va",
          }),
        }),
      );
      const loginB = await as(5175, () =>
        app.request(`${LOCAL}/user_management/authenticate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: snapshot },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: "authorization_code",
            code: "b",
            code_verifier: "vb",
          }),
        }),
      );
      jar.apply(loginB);
      jar.apply(loginA);
      expect(jar.cookies.has(nameA)).toBe(true);
      expect(jar.cookies.has(nameB)).toBe(true);

      // Concurrent refreshes from one snapshot.
      vi.mocked(fetch)
        .mockResolvedValueOnce(tokens("a-2"))
        .mockResolvedValueOnce(tokens("b-2"));
      const snap2 = new Jar();
      for (const [n, v] of jar.cookies) snap2.cookies.set(n, v);
      const refreshA = await as(5174, () => refresh(app, snap2));
      const refreshB = await as(5175, () => refresh(app, snap2));
      expect(refreshA.status).toBe(200);
      expect(refreshB.status).toBe(200);
      const sent = vi
        .mocked(fetch)
        .mock.calls.slice(2)
        .map((call) => JSON.parse(String(call[1]?.body)).refresh_token);
      expect(sent).toEqual(["a-1", "b-1"]);
      jar.apply(refreshA);
      jar.apply(refreshB);

      // A signs out. B's session and the shared hint survive it.
      vi.mocked(fetch).mockResolvedValueOnce(tokens("a-3"));
      const outA = await as(5174, () => logout(app, jar));
      expect(outA.status).toBe(302);
      expect(setCookieFor(outA, "workos-has-session")).toBeUndefined();
      expect(setCookieFor(outA, nameB)).toBeUndefined();
      jar.apply(outA);
      expect(jar.cookies.has(nameA)).toBe(false);
      expect(jar.cookies.has(nameB)).toBe(true);
      expect(jar.cookies.get("workos-has-session")).toBe("1");

      // The signed-out instance's reload cannot suppress B's: B still
      // refreshes with ITS token, and A's missing session leaves the hint.
      const reloadA = await as(5174, () => refresh(app, jar));
      expect(reloadA.status).toBe(400);
      jar.apply(reloadA);
      vi.mocked(fetch).mockResolvedValueOnce(tokens("b-3"));
      const reloadB = await as(5175, () => refresh(app, jar));
      expect(reloadB.status).toBe(200);
      expect(
        JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))
          .refresh_token,
      ).toBe("b-2");
    });
  });

  // The hosted path: a deployed origin is one instance on one origin and keeps
  // its sealed `__Host-` cookie and Secure flags.
  describe("on a deployed https origin", () => {
    async function hostedLogin() {
      vi.mocked(fetch).mockResolvedValueOnce(tokens("refresh-token-1"));
      return createTestApp().request(
        "https://staging.mcpjam.com/user_management/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: "authorization_code",
            code: "code_123",
            code_verifier: "verifier_123",
          }),
        },
      );
    }

    it("seals the refresh token into a Secure __Host- cookie", async () => {
      const res = await hostedLogin();
      expect(res.status).toBe(200);
      const sessionCookie = setCookieFor(res, "__Host-mcpjam_workos_session")!;
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("Secure");
      expect(sessionCookie).toContain("Path=/");
      expect(sessionCookie).not.toContain("Domain=");
      expect(sessionCookie).not.toContain("refresh-token-1");
      expect(
        res.headers.getSetCookie().some((c) => c.startsWith("mcpjam_wos_")),
      ).toBe(false);
    });

    it("sets workos-has-session on this origin so AuthKit will attempt a refresh", async () => {
      const res = await hostedLogin();
      const hint = setCookieFor(res, "workos-has-session")!;
      expect(hint).toContain("workos-has-session=1");
      expect(hint).toContain("Secure");
      expect(hint).not.toContain("HttpOnly");
    });
  });
});

describe("logout revokes the session it ends", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MCPJAM_WORKOS_SESSION_SECRET = "test-workos-session-secret";
    process.env.WORKOS_CLIENT_ID = CLIENT_ID;
    process.env.MCPJAM_BROWSER_PORT = "5173";
    global.fetch = vi.fn();
    revokeAuthKitSessionMock.mockReset();
    revokeAuthKitSessionMock.mockResolvedValue({ revoked: true });
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function signedInJar(app: Hono): Promise<Jar> {
    const jar = new Jar();
    vi.mocked(fetch).mockResolvedValueOnce(tokens("refresh-token-1"));
    jar.apply(await codeExchange(app));
    return jar;
  }

  it("proves the session with the cookie's refresh token, revokes it, then logs out", async () => {
    const app = createTestApp();
    const jar = await signedInJar(app);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        access_token: "access-token-for-revocation",
        refresh_token: "refresh-token-2",
      }),
    );

    // The query names some other session; it must not be what gets revoked.
    const res = await app.request(
      `${LOCAL}/user_management/sessions/logout?session_id=session_someone_else`,
      { headers: { Cookie: jar.header() } },
    );

    const [url, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(url)).toBe(
      "https://api.workos.com/user_management/authenticate",
    );
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: "refresh-token-1",
    });
    expect(revokeAuthKitSessionMock).toHaveBeenCalledWith(
      "access-token-for-revocation",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.workos.com/user_management/sessions/logout?session_id=session_someone_else",
    );
    const name = scopedCookieName("workos", getLocalSessionNamespace().id);
    expect(setCookieFor(res, name)).toContain("Max-Age=0");
  });

  it("still logs out when the session cannot be refreshed", async () => {
    const app = createTestApp();
    const jar = await signedInJar(app);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    const res = await logout(app, jar);
    expect(revokeAuthKitSessionMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
  });

  it("still logs out when the refresh itself throws", async () => {
    const app = createTestApp();
    const jar = await signedInJar(app);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await logout(app, jar);
    expect(revokeAuthKitSessionMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
  });

  it("does not call WorkOS when there is no stored session", async () => {
    const res = await logout(createTestApp(), new Jar());
    expect(fetch).not.toHaveBeenCalled();
    expect(revokeAuthKitSessionMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
  });
});
