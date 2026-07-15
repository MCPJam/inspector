import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";

// Mock the upstream source module so we control mint outcomes deterministically.
const mockFetchConvexGuestSession = vi.fn();
const mockFetchRemoteGuestSession = vi.fn();

vi.mock("../../../utils/guest-session-source.js", () => ({
  fetchConvexGuestSession: (...args: unknown[]) =>
    mockFetchConvexGuestSession(...args),
  fetchRemoteGuestSession: (...args: unknown[]) =>
    mockFetchRemoteGuestSession(...args),
}));

// Deterministic IP hash; the real impl degrades to null without a pepper but
// mocking keeps the test independent of env.
vi.mock("../../../utils/guest-spend-ip.js", () => ({
  hashGuestSpendIp: vi.fn(async () => "hashed-ip"),
}));

// Avoid Sentry/Axiom side effects from the logger.
vi.mock("../../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
    debug: vi.fn(),
  },
}));

const ALLOWED_HOSTS = ["app.mcpjam.com"];
const INDEX_HTML = "<html><head><title>app</title></head><body></body></html>";

/**
 * Mirror of the production SPA document handler's guest-bootstrap block,
 * importing the REAL shared helpers + host gate. Kept in sync with
 * server/index.ts / server/app.ts. Exercising the real helpers lets us assert
 * escaping, no-store, cookie forwarding, host gating, lockdown, mint-failure,
 * and the whole-helper timeout race without booting the full server.
 */
async function buildDocumentApp() {
  const {
    appendGuestSessionSetCookie,
    buildGuestBootstrapScript,
    mintGuestSessionForDocument,
  } = await import("../guest-session-shared.js");
  const { mayServeGuestBootstrap } = await import(
    "../../../utils/localhost-check.js"
  );

  const app = new Hono();
  app.get("/*", async (c: Context) => {
    let html = INDEX_HTML;
    const host = c.req.header("Host");
    const forwardedHost = c.req.header("X-Forwarded-Host");

    if (
      process.env.NODE_ENV === "production" &&
      process.env.MCPJAM_NONPROD_LOCKDOWN !== "true" &&
      mayServeGuestBootstrap({
        host,
        forwardedHost,
        allowedHosts: ALLOWED_HOSTS,
        hostedMode: true,
      })
    ) {
      try {
        const { session, setCookies } = await mintGuestSessionForDocument(c);
        if (session && session.expiresAt > Date.now()) {
          html = html.replace(
            "</head>",
            `${buildGuestBootstrapScript(session)}</head>`
          );
          for (const cookie of setCookies) {
            appendGuestSessionSetCookie(c, cookie);
          }
        }
      } catch {
        // serve without blob
      }
    }

    c.header("Cache-Control", "no-store");
    return c.html(html);
  });
  return app;
}

function get(
  app: Awaited<ReturnType<typeof buildDocumentApp>>,
  headers: Record<string, string> = {}
) {
  return app.request("http://app.mcpjam.com/", {
    method: "GET",
    headers: {
      Host: "app.mcpjam.com",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
  });
}

describe("guest-session document bootstrap", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLockdown = process.env.MCPJAM_NONPROD_LOCKDOWN;
  const originalHosted = process.env.VITE_MCPJAM_HOSTED_MODE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    // Force the Convex source branch (shouldFetchGuestSessionFromConvex()).
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLockdown === undefined) delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    else process.env.MCPJAM_NONPROD_LOCKDOWN = originalLockdown;
    if (originalHosted === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = originalHosted;
  });

  it("injects an escaped blob and forwards cookies on a successful mint", async () => {
    mockFetchConvexGuestSession.mockResolvedValue({
      kind: "session",
      session: {
        // guestId carries breakout-attempt characters to verify escaping.
        guestId: "g</script><script>alert(1)</script>",
        token: "guest-bearer-token",
        expiresAt: Date.now() + 60_000,
      },
      setCookies: ["__Host-mcpjam_guest_session=opaque; Path=/; HttpOnly"],
    });

    const app = await buildDocumentApp();
    const res = await get(app);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("window.__MCP_GUEST_BOOTSTRAP__=");
    expect(body).toContain("guest-bearer-token");
    // No raw </script> breakout — the literal closing tag from the guestId
    // must be escaped inside the JSON payload.
    expect(body).not.toContain("</script><script>alert(1)</script>");
    expect(body).toContain("\\u003c");
    // Cookie forwarded onto the document response.
    expect(res.headers.get("set-cookie")).toContain(
      "__Host-mcpjam_guest_session=opaque"
    );
    // no-store set unconditionally.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not inject a blob for a non-allowed Host (host-allowlist gating)", async () => {
    mockFetchConvexGuestSession.mockResolvedValue({
      kind: "session",
      session: {
        guestId: "g",
        token: "t",
        expiresAt: Date.now() + 60_000,
      },
      setCookies: [],
    });

    const app = await buildDocumentApp();
    const res = await get(app, { Host: "evil.example.com" });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
    expect(mockFetchConvexGuestSession).not.toHaveBeenCalled();
    // no-store is unconditional regardless of gating.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not inject a blob for a tunnel forwarded host", async () => {
    mockFetchConvexGuestSession.mockResolvedValue({
      kind: "session",
      session: { guestId: "g", token: "t", expiresAt: Date.now() + 60_000 },
      setCookies: [],
    });

    const app = await buildDocumentApp();
    const res = await get(app, {
      "X-Forwarded-Host": "abc123.tunnels.mcpjam.com",
    });
    const body = await res.text();

    expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
    expect(mockFetchConvexGuestSession).not.toHaveBeenCalled();
  });

  it("injects nothing under lockdown (no-op)", async () => {
    process.env.MCPJAM_NONPROD_LOCKDOWN = "true";
    mockFetchConvexGuestSession.mockResolvedValue({
      kind: "session",
      session: { guestId: "g", token: "t", expiresAt: Date.now() + 60_000 },
      setCookies: [],
    });

    const app = await buildDocumentApp();
    const res = await get(app);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
    expect(mockFetchConvexGuestSession).not.toHaveBeenCalled();
  });

  it("serves 200 without a blob when the mint fails (degrade, never 500)", async () => {
    mockFetchConvexGuestSession.mockResolvedValue({
      kind: "error",
      status: 503,
      setCookies: [],
    });

    const app = await buildDocumentApp();
    const res = await get(app);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves 200 without a blob when the mint throws", async () => {
    mockFetchConvexGuestSession.mockRejectedValue(new Error("boom"));

    const app = await buildDocumentApp();
    const res = await get(app);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
  });

  it("bounds the whole mint against the 1500ms deadline (provisioning hang)", async () => {
    // Simulate a hung mint that never resolves — the whole-helper race must
    // abandon it and serve blob-less within the deadline.
    mockFetchConvexGuestSession.mockImplementation(
      () => new Promise(() => {})
    );

    vi.useFakeTimers();
    try {
      const app = await buildDocumentApp();
      const resPromise = get(app);
      // Advance past the 1500ms document deadline.
      await vi.advanceTimersByTimeAsync(1600);
      const res = await resPromise;
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).not.toContain("__MCP_GUEST_BOOTSTRAP__");
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      vi.useRealTimers();
    }
  });
});
