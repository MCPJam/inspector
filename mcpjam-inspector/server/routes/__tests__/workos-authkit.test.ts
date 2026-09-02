import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import workosAuthkitRoutes from "../workos-authkit.js";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SECRET = process.env.MCPJAM_WORKOS_SESSION_SECRET;

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

function extractCookie(setCookie: string, name: string): string {
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${name}`);
  return `${name}=${match[1]}`;
}

/**
 * The ONE `Set-Cookie` header that carries `name`, with its own attributes.
 *
 * `headers.get("set-cookie")` joins every cookie into a single string, so
 * asserting a flag against that tells you only that SOME cookie in the
 * response carries it — a check that passes even when the cookie you meant is
 * missing the flag entirely. Attributes are per-cookie, so the assertions have
 * to be too.
 */
function setCookieFor(res: Response, name: string): string {
  const entry = res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (!entry) throw new Error(`Missing Set-Cookie for ${name}`);
  return entry;
}

describe("workos authkit local session bridge", () => {
  beforeEach(() => {
    process.env.MCPJAM_WORKOS_SESSION_SECRET = "test-workos-session-secret";
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.MCPJAM_WORKOS_SESSION_SECRET;
    } else {
      process.env.MCPJAM_WORKOS_SESSION_SECRET = ORIGINAL_SECRET;
    }
  });

  it("stores the WorkOS refresh token in an HttpOnly local cookie after code exchange", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        user: { id: "user_1" },
      })
    );

    const res = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "authorization_code",
          code: "code_123",
          code_verifier: "verifier_123",
        }),
      }
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { refresh_token?: string };
    expect(data.refresh_token).toBe("refresh-token-1");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mcpjam_workos_sessions=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("workos-has-session=true");
  });

  it("redirects authorize requests to WorkOS", async () => {
    const app = createTestApp();

    const res = await app.request(
      "http://localhost:6274/user_management/authorize?client_id=client_123&code_challenge=abc"
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.workos.com/user_management/authorize?client_id=client_123&code_challenge=abc"
    );
  });

  it("clears the local session cookie before redirecting logout requests to WorkOS", async () => {
    const app = createTestApp();

    const res = await app.request(
      "http://localhost:6274/user_management/sessions/logout?session_id=session_123"
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.workos.com/user_management/sessions/logout?session_id=session_123"
    );
    expect(res.headers.get("set-cookie")).toContain(
      "mcpjam_workos_sessions=; Max-Age=0"
    );
  });

  it("uses the HttpOnly cookie refresh token on hard-refresh recovery", async () => {
    const app = createTestApp();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          user: { id: "user_1" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token-2",
          refresh_token: "refresh-token-2",
          user: { id: "user_1" },
        })
      );

    const loginRes = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "authorization_code",
          code: "code_123",
          code_verifier: "verifier_123",
        }),
      }
    );
    const sessionCookie = extractCookie(
      loginRes.headers.get("set-cookie") ?? "",
      "mcpjam_workos_sessions"
    );

    const refreshRes = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
          Cookie: `${sessionCookie}; workos-has-session=true`,
        },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "refresh_token",
        }),
      }
    );

    expect(refreshRes.status).toBe(200);
    expect(await refreshRes.json()).toMatchObject({
      refresh_token: "refresh-token-2",
    });

    const refreshRequest = vi.mocked(fetch).mock.calls[1]?.[1];
    expect(JSON.parse(String(refreshRequest?.body))).toMatchObject({
      client_id: "client_123",
      grant_type: "refresh_token",
      refresh_token: "refresh-token-1",
    });
  });

  it("does not use one localhost origin's refresh token for another origin", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        access_token: "access-token-1",
        refresh_token: "refresh-token-5173",
        user: { id: "user_1" },
      })
    );

    const loginRes = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "authorization_code",
          code: "code_123",
          code_verifier: "verifier_123",
        }),
      }
    );
    const sessionCookie = extractCookie(
      loginRes.headers.get("set-cookie") ?? "",
      "mcpjam_workos_sessions"
    );

    const refreshRes = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5174",
          Cookie: `${sessionCookie}; workos-has-session=true`,
        },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "refresh_token",
        }),
      }
    );

    expect(refreshRes.status).toBe(400);
    expect(await refreshRes.json()).toEqual({
      error_description: "No local WorkOS session",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refreshRes.headers.get("set-cookie")).not.toContain(
      "workos-has-session=; Max-Age=0"
    );
  });

  it("fails safely when refresh is requested without a local session cookie", async () => {
    const app = createTestApp();

    const res = await app.request(
      "http://localhost:6274/user_management/authenticate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "client_123",
          grant_type: "refresh_token",
        }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error_description: "No local WorkOS session",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // The hosted path. Everything above runs on localhost, where the refresh
  // token goes in a plain local jar; a deployed origin takes the other branch
  // entirely — sealed `__Host-` cookie, Secure flags — and that branch is what
  // staging and previews now depend on.
  describe("on a deployed https origin", () => {
    it("seals the refresh token into a Secure __Host- cookie", async () => {
      const app = createTestApp();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          user: { id: "user_1" },
        })
      );

      const res = await app.request(
        "https://staging.mcpjam.com/user_management/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: "client_123",
            grant_type: "authorization_code",
            code: "code_123",
            code_verifier: "verifier_123",
          }),
        }
      );

      expect(res.status).toBe(200);
      const sessionCookie = setCookieFor(res, "__Host-mcpjam_workos_session");
      expect(sessionCookie).toContain("HttpOnly");
      // The `__Host-` prefix is not decoration: a browser silently REJECTS a
      // cookie carrying it without Secure and Path=/, or with any Domain at
      // all. Dropped here, the session would vanish on the next page load —
      // the exact failure this whole change exists to fix, reintroduced one
      // attribute at a time.
      expect(sessionCookie).toContain("Secure");
      expect(sessionCookie).toContain("Path=/");
      expect(sessionCookie).not.toContain("Domain=");
      // The refresh token must never reach the deployed browser in the clear.
      expect(sessionCookie).not.toContain("refresh-token-1");
    });

    // THE regression. Without this cookie on the app's own origin, AuthKit's
    // initialize() short-circuits before making any request and the user is
    // silently demoted to a guest on the next page load — which is exactly how
    // staging behaved while it pointed at api.workos.com.
    it("sets workos-has-session on this origin so AuthKit will attempt a refresh", async () => {
      const app = createTestApp();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          user: { id: "user_1" },
        })
      );

      const res = await app.request(
        "https://staging.mcpjam.com/user_management/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: "client_123",
            grant_type: "authorization_code",
            code: "code_123",
            code_verifier: "verifier_123",
          }),
        }
      );

      const hasSessionCookie = setCookieFor(res, "workos-has-session");
      expect(hasSessionCookie).toContain("workos-has-session=true");
      // Secure asserted on THIS cookie specifically: a deployed browser drops
      // an insecure cookie on an https origin, and AuthKit would then skip its
      // refresh and demote the user to a guest.
      expect(hasSessionCookie).toContain("Secure");
      // Readable by the page — this is the one cookie AuthKit inspects from
      // JavaScript, so HttpOnly on it would break the flow it exists to drive.
      expect(hasSessionCookie).not.toContain("HttpOnly");
    });
  });
});
