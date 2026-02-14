import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { resolveRequestSessionId } from "../client-manager-session.js";

function createTestApp(hostedMode: boolean): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    (c as any).resolvedSessionId = resolveRequestSessionId(c, hostedMode);
    await next();
  });

  app.get("/api/test", (c) => {
    return c.json({ sessionId: (c as any).resolvedSessionId ?? null });
  });

  return app;
}

describe("resolveRequestSessionId", () => {
  it("does not create a session when hosted mode is disabled", async () => {
    const app = createTestApp(false);

    const res = await app.request("/api/test");
    const data = await res.json();

    expect(data.sessionId).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("uses explicit session header when present", async () => {
    const app = createTestApp(true);

    const res = await app.request("/api/test", {
      headers: { "x-mcpjam-session-id": "header-session-1" },
    });
    const data = await res.json();

    expect(data.sessionId).toBe("header-session-1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("uses existing cookie session when present", async () => {
    const app = createTestApp(true);

    const res = await app.request("/api/test", {
      headers: { Cookie: "mcpjam_session_id=cookie-session-1" },
    });
    const data = await res.json();

    expect(data.sessionId).toBe("cookie-session-1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("creates a new session cookie when no session identifier exists", async () => {
    const app = createTestApp(true);

    const res = await app.request("/api/test");
    const data = await res.json();
    const setCookie = res.headers.get("set-cookie");

    expect(data.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(setCookie).toContain(`mcpjam_session_id=${data.sessionId}`);
    expect(setCookie).toContain("HttpOnly");
  });
});
