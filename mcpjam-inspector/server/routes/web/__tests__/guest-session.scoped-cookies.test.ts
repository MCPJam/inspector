import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import guestSession from "../guest-session.js";
import { resetGuestAuthorityForTests } from "../../../utils/guest-authority.js";
import { getLocalSessionNamespace } from "../../../utils/local-session-namespace.js";
import {
  scopedCookieName,
  unsealScopedCookie,
} from "../../../utils/scoped-cookies.js";

/**
 * A loopback Inspector keeps each instance's guest in its own sealed,
 * namespace-scoped cookie, and migrates a legacy shared guest cookie through
 * `lookup_only` at the selected authority — never creating a replacement
 * during lookup, never forwarding unrelated cookies, never deleting an
 * identity it did not match.
 */

const ENV_KEYS = [
  "NODE_ENV",
  "CONVEX_HTTP_URL",
  "MCPJAM_GUEST_SESSION_SHARED_SECRET",
  "MCPJAM_GUEST_AUTHORITY",
  "VITE_MCPJAM_HOSTED_MODE",
  "MCPJAM_BROWSER_PORT",
  "MCPJAM_WORKOS_SESSION_SECRET",
  "WORKOS_CLIENT_ID",
  "VITE_WORKOS_CLIENT_ID",
] as const;

const BACKEND_A = "https://backend-a.convex.site";
const UPSTREAM_COOKIE = (value: string, maxAge = 31536000) =>
  `__Host-mcpjam_guest_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

type Upstream = (
  body: Record<string, unknown>,
  cookie: string | undefined,
) => Response;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function session(token: string, guestId: string, setCookie?: string): Response {
  return json(
    { guestId, token, expiresAt: Date.now() + 60_000 },
    setCookie ? { headers: { "Set-Cookie": setCookie } } : {},
  );
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** Fold a response's Set-Cookie headers into a simple name→value jar. */
function applyToJar(jar: Map<string, string>, res: Response): void {
  for (const header of setCookies(res)) {
    const [nameValue, ...attributes] = header.split(";").map((p) => p.trim());
    const eq = nameValue!.indexOf("=");
    const name = nameValue!.slice(0, eq);
    const value = nameValue!.slice(eq + 1);
    const expired = attributes.some((a) => /^max-age=0$/i.test(a));
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

describe("loopback guest cookies are namespace-scoped", () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = global.fetch;
  let upstream: Upstream;
  let app: Hono;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.NODE_ENV = "test";
    process.env.CONVEX_HTTP_URL = BACKEND_A;
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = "backend-a-secret";
    process.env.MCPJAM_WORKOS_SESSION_SECRET = "machine-cookie-secret";
    process.env.MCPJAM_BROWSER_PORT = "5174";
    process.env.WORKOS_CLIENT_ID = "client_dev";
    delete process.env.MCPJAM_GUEST_AUTHORITY;
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
    resetGuestAuthorityForTests();
    upstream = () =>
      session("t-new", "guest-new", UPSTREAM_COOKIE("opaque-new"));
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return upstream(body, headers["Cookie"]);
    }) as typeof fetch;
    app = new Hono();
    app.route("/guest-session", guestSession);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetGuestAuthorityForTests();
    global.fetch = originalFetch;
  });

  async function post(
    path: string,
    cookie?: string,
    body?: Record<string, unknown>,
    ip = "203.0.113.50",
  ) {
    return app.request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  function upstreamCalls() {
    return vi.mocked(global.fetch).mock.calls.map(([url, init]) => ({
      url: String(url),
      cookie: ((init?.headers ?? {}) as Record<string, string>)["Cookie"],
      body: init?.body ? JSON.parse(String(init.body)) : {},
    }));
  }

  it("emits ONLY this namespace's sealed guest cookie, with the upstream lifetime", async () => {
    const res = await post("/guest-session", undefined, {}, "203.0.113.51");
    expect(res.status).toBe(200);
    const ns = getLocalSessionNamespace();
    const headers = setCookies(res);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(
      new RegExp(`^${scopedCookieName("guest", ns.id)}=v1\\.`),
    );
    expect(headers[0]).toContain("Max-Age=31536000");
    expect(headers[0]).toContain("HttpOnly");
    expect(headers.join("\n")).not.toContain("__Host-mcpjam_guest_session");
    expect(headers.join("\n")).not.toMatch(/(^|\n)mcpjam_guest_session=/);

    const jar = new Map<string, string>();
    applyToJar(jar, res);
    const sealed = jar.get(scopedCookieName("guest", ns.id));
    expect(
      unsealScopedCookie({ kind: "guest", nsId: ns.id, value: sealed }),
    ).toEqual({ upstream: "opaque-new" });
  });

  it("forwards exactly the stored upstream cookie on the next request — and nothing else", async () => {
    const jar = new Map<string, string>([
      ["session", "app-secret"],
      ["mcpjam_wos_0123456789ab", "someone-elses"],
    ]);
    applyToJar(
      jar,
      await post("/guest-session", cookieHeader(jar), {}, "203.0.113.52"),
    );
    vi.mocked(global.fetch).mockClear();

    await post("/guest-session", cookieHeader(jar), {}, "203.0.113.52");
    const [call] = upstreamCalls();
    expect(call!.cookie).toBe("__Host-mcpjam_guest_session=opaque-new");
  });

  it("two instances on one host never share a guest", async () => {
    const jar = new Map<string, string>();
    applyToJar(
      jar,
      await post("/guest-session", undefined, {}, "203.0.113.53"),
    );

    // Same browser, another worktree on another port.
    process.env.MCPJAM_BROWSER_PORT = "5175";
    vi.mocked(global.fetch).mockClear();
    upstream = () => session("t-b", "guest-b", UPSTREAM_COOKIE("opaque-b"));
    applyToJar(
      jar,
      await post("/guest-session", cookieHeader(jar), {}, "203.0.113.53"),
    );

    const [call] = upstreamCalls();
    expect(call!.cookie).toBeUndefined();
    // Both instances' cookies coexist; neither overwrote the other.
    const scoped = [...jar.keys()].filter((n) => n.startsWith("mcpjam_gst_"));
    expect(scoped).toHaveLength(2);
  });

  it("a value copied under another namespace's name does not open", async () => {
    const jar = new Map<string, string>();
    applyToJar(
      jar,
      await post("/guest-session", undefined, {}, "203.0.113.54"),
    );
    const nsA = getLocalSessionNamespace().id;
    process.env.MCPJAM_BROWSER_PORT = "5175";
    const nsB = getLocalSessionNamespace().id;
    const stolen = jar.get(scopedCookieName("guest", nsA))!;
    expect(
      unsealScopedCookie({ kind: "guest", nsId: nsB, value: stolen }),
    ).toBeNull();
    expect(
      unsealScopedCookie({ kind: "workos", nsId: nsA, value: stolen }),
    ).toBeNull();
  });

  describe("legacy shared cookie migration", () => {
    it("adopts a legacy guest through lookup_only, without creating one", async () => {
      upstream = (body, cookie) =>
        body.mode === "lookup_only" &&
        cookie === "__Host-mcpjam_guest_session=legacy-a"
          ? session("t-legacy", "guest-legacy", UPSTREAM_COOKIE("legacy-a"))
          : session("t-new", "guest-new", UPSTREAM_COOKIE("opaque-new"));

      const res = await post(
        "/guest-session",
        "mcpjam_guest_session=legacy-a; csrf=nope",
        { mode: "lookup_or_create" },
        "203.0.113.60",
      );
      expect(res.status).toBe(200);
      expect((await res.json()).guestId).toBe("guest-legacy");
      expect(upstreamCalls()).toEqual([
        {
          url: `${BACKEND_A}/guest/session`,
          cookie: "__Host-mcpjam_guest_session=legacy-a",
          body: { mode: "lookup_only" },
        },
      ]);

      const jar = new Map<string, string>([
        ["mcpjam_guest_session", "legacy-a"],
      ]);
      applyToJar(jar, res);
      // The legacy cookie is left in place; the scoped one now holds the guest.
      expect(jar.get("mcpjam_guest_session")).toBe("legacy-a");
      const ns = getLocalSessionNamespace().id;
      expect(
        unsealScopedCookie({
          kind: "guest",
          nsId: ns,
          value: jar.get(scopedCookieName("guest", ns)),
        }),
      ).toEqual({ upstream: "legacy-a" });
    });

    it("tries both legacy names, local name first", async () => {
      upstream = () => new Response(null, { status: 204 });
      await post(
        "/guest-session",
        "__Host-mcpjam_guest_session=host-b; mcpjam_guest_session=local-a",
        { mode: "lookup_only" },
        "203.0.113.61",
      );
      expect(upstreamCalls().map((c) => [c.cookie, c.body.mode])).toEqual([
        ["__Host-mcpjam_guest_session=local-a", "lookup_only"],
        ["__Host-mcpjam_guest_session=host-b", "lookup_only"],
        [undefined, "lookup_only"],
      ]);
    });

    it("rejects cross-backend reuse: an unmatched legacy guest is neither reused nor deleted", async () => {
      // Backend A has never seen this cookie (it came from another backend).
      upstream = (body, cookie) =>
        cookie
          ? new Response(null, { status: 204 })
          : session("t-new", "guest-fresh", UPSTREAM_COOKIE("opaque-fresh"));

      const res = await post(
        "/guest-session",
        "mcpjam_guest_session=from-backend-b",
        { mode: "lookup_or_create" },
        "203.0.113.62",
      );
      expect(res.status).toBe(200);
      expect((await res.json()).guestId).toBe("guest-fresh");
      const calls = upstreamCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        cookie: "__Host-mcpjam_guest_session=from-backend-b",
        body: { mode: "lookup_only" },
      });
      // The create carries NO cookie: the foreign identity is not reused.
      expect(calls[1]).toMatchObject({
        cookie: undefined,
        body: { mode: "lookup_or_create" },
      });
      expect(setCookies(res).join("\n")).not.toMatch(/mcpjam_guest_session=;/);
    });

    it("does not mint a replacement when the legacy lookup fails", async () => {
      upstream = () => new Response("down", { status: 502 });
      const res = await post(
        "/guest-session",
        "mcpjam_guest_session=legacy-a",
        { mode: "lookup_or_create" },
        "203.0.113.63",
      );
      expect(res.status).toBe(503);
      expect(upstreamCalls()).toHaveLength(1);
      expect(upstreamCalls()[0]!.body).toEqual({ mode: "lookup_only" });
      expect(setCookies(res)).toEqual([]);
    });

    it("never consults legacy cookies once this namespace has its own guest", async () => {
      const jar = new Map<string, string>();
      applyToJar(
        jar,
        await post("/guest-session", undefined, {}, "203.0.113.64"),
      );
      jar.set("mcpjam_guest_session", "legacy-a");
      vi.mocked(global.fetch).mockClear();
      await post("/guest-session", cookieHeader(jar), {}, "203.0.113.64");
      expect(upstreamCalls()).toHaveLength(1);
      expect(upstreamCalls()[0]!.cookie).toBe(
        "__Host-mcpjam_guest_session=opaque-new",
      );
    });
  });

  it("clears the scoped cookie when the authority revokes the guest", async () => {
    const jar = new Map<string, string>();
    applyToJar(
      jar,
      await post("/guest-session", undefined, {}, "203.0.113.70"),
    );
    upstream = () =>
      json(
        { code: "FORBIDDEN", message: "Guest session revoked" },
        {
          status: 403,
          headers: {
            "Set-Cookie":
              "__Host-mcpjam_guest_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
          },
        },
      );
    const res = await post(
      "/guest-session",
      cookieHeader(jar),
      {},
      "203.0.113.70",
    );
    expect(res.status).toBe(403);
    applyToJar(jar, res);
    expect([...jar.keys()].some((n) => n.startsWith("mcpjam_gst_"))).toBe(
      false,
    );
    expect(setCookies(res).join("\n")).not.toContain("__Host-");
  });

  describe("revoke", () => {
    it("revokes this namespace's guest, clears its cookie, and deletes only the MATCHING legacy cookie", async () => {
      upstream = (body, cookie) =>
        body.mode === "lookup_only" && cookie?.endsWith("=legacy-a")
          ? session("t", "guest-legacy", UPSTREAM_COOKIE("legacy-a"))
          : body.mode === "lookup_only"
            ? new Response(null, { status: 204 })
            : json({ revoked: true });
      const res = await post(
        "/guest-session/revoke",
        "mcpjam_guest_session=legacy-a; __Host-mcpjam_guest_session=other-identity",
        undefined,
        "203.0.113.80",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });

      const calls = upstreamCalls();
      const revokeCall = calls.find((c) =>
        c.url.endsWith("/guest/session/revoke"),
      );
      expect(revokeCall?.cookie).toBe("__Host-mcpjam_guest_session=legacy-a");

      const jar = new Map<string, string>([
        ["mcpjam_guest_session", "legacy-a"],
        ["__Host-mcpjam_guest_session", "other-identity"],
      ]);
      applyToJar(jar, res);
      expect(jar.has("mcpjam_guest_session")).toBe(false);
      expect(jar.get("__Host-mcpjam_guest_session")).toBe("other-identity");
      expect([...jar.keys()].some((n) => n.startsWith("mcpjam_gst_"))).toBe(
        false,
      );
    });

    it("fails (rather than reporting success) when a legacy guest cannot be looked up", async () => {
      upstream = () => new Response("down", { status: 502 });
      const res = await post(
        "/guest-session/revoke",
        "mcpjam_guest_session=legacy-a",
        undefined,
        "203.0.113.82",
      );
      expect(res.status).toBe(503);
      expect(
        upstreamCalls().some((c) => c.url.endsWith("/guest/session/revoke")),
      ).toBe(false);
    });

    it("is a local no-op success when this namespace has no guest", async () => {
      const res = await post(
        "/guest-session/revoke",
        undefined,
        undefined,
        "203.0.113.81",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: false });
      expect(upstreamCalls()).toHaveLength(0);
    });
  });

  it("mints a promotion proof for this namespace's guest", async () => {
    const jar = new Map<string, string>();
    applyToJar(
      jar,
      await post("/guest-session", undefined, {}, "203.0.113.90"),
    );
    vi.mocked(global.fetch).mockClear();
    upstream = () =>
      json({
        guestId: "guest-new",
        token: "proof",
        expiresAt: Date.now() + 1000,
      });
    const res = await post(
      "/guest-session/promotion-proof",
      cookieHeader(jar),
      undefined,
      "203.0.113.90",
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls()).toEqual([
      expect.objectContaining({
        url: `${BACKEND_A}/guest/promotion-proof`,
        cookie: "__Host-mcpjam_guest_session=opaque-new",
      }),
    ]);
  });

  it("forwarded headers never choose the namespace", async () => {
    const expected = scopedCookieName("guest", getLocalSessionNamespace().id);
    const res = await app.request("http://localhost/guest-session", {
      method: "POST",
      headers: {
        origin: "http://localhost:9999",
        referer: "http://localhost:9999/",
        "x-forwarded-host": "localhost:9999",
        "x-forwarded-port": "9999",
        "x-forwarded-for": "203.0.113.99",
      },
    });
    const names = setCookies(res).map((h) => h.split("=")[0]);
    expect(names).toEqual([expected]);
  });
});
