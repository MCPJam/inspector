/**
 * MJ-001 acceptance 5 / MJ-012 slice: doctor and validate are metered per
 * credential.
 *
 * The properties worth pinning are the ones that were reasoned about rather
 * than the happy path: that a refused caller cannot spend the address budget it
 * shares with strangers, that rotating the bearer converges on that backstop
 * instead of buying a fresh allowance, and that local mode is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";

async function loadMiddleware(hosted: boolean) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  const module = await import("../mcp-egress-rate-limit.js");
  module.resetMcpEgressRateLimitForTests();
  return {
    module,
    restore: () => {
      module.resetMcpEgressRateLimitForTests();
      if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
      else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
      vi.resetModules();
    },
  };
}

/**
 * A route behind the limiter, with the identity `bearerAuthMiddleware` would
 * have set already — the middleware reads `c.get(...)`, so a test that only
 * sent a header would exercise the fallback branch and never the API-key or
 * guest one.
 */
function appWith(
  middleware: (c: Context, next: Next) => Promise<Response | void>,
  identity?: { workosApiKeyId?: string; guestId?: string }
) {
  const app = new Hono();
  app.use("/doctor", async (c, next) => {
    if (identity?.workosApiKeyId) c.set("workosApiKeyId", identity.workosApiKeyId);
    if (identity?.guestId) c.set("guestId", identity.guestId);
    return next();
  });
  app.use("/doctor", middleware);
  app.post("/doctor", (c) => c.json({ ok: true }));
  return app;
}

async function post(
  app: Hono,
  options: { bearer?: string; ip?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.bearer !== undefined) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  headers["x-forwarded-for"] = options.ip ?? "203.0.113.7";
  return app.request("/doctor", { method: "POST", headers });
}

describe("mcpEgressRateLimitMiddleware", () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it("refuses a credential past its window with 429 and Retry-After", async () => {
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_1",
    });

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT; i++) {
      expect((await post(app)).status).toBe(200);
    }
    const refused = await post(app);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await refused.json()) as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("meters guests and API keys as separate credentials", async () => {
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const key = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_1",
    });
    const guest = appWith(module.mcpEgressRateLimitMiddleware, {
      guestId: "guest_1",
    });

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT; i++) {
      expect((await post(key)).status).toBe(200);
    }
    expect((await post(key)).status).toBe(429);
    // Exhausting one credential must not touch another's budget.
    expect((await post(guest)).status).toBe(200);
  });

  it("does not let a refused credential spend the shared address budget", async () => {
    // The ordering property. If the IP window were charged first, a caller
    // already being refused would go on debiting the window it shares with
    // everyone behind the same NAT — denying service to strangers for free.
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_1",
    });

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT; i++) {
      await post(app, { ip: "198.51.100.4" });
    }
    // Well past the IP limit in rejected requests.
    for (let i = 0; i < module.MCP_EGRESS_IP_LIMIT * 2; i++) {
      expect((await post(app, { ip: "198.51.100.4" })).status).toBe(429);
    }

    // A different credential behind the same address is still served: those
    // rejections cost the address nothing.
    const neighbour = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_2",
    });
    expect((await post(neighbour, { ip: "198.51.100.4" })).status).toBe(200);
  });

  it("converges a bearer-rotating caller on the per-address backstop", async () => {
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware);

    let refusedAt = 0;
    for (let i = 0; i < module.MCP_EGRESS_IP_LIMIT + 5; i++) {
      // A fresh credential every request — each one has no window of its own,
      // so the address window is what has to stop it.
      const response = await post(app, {
        bearer: `rotated-${i}`,
        ip: "198.51.100.9",
      });
      if (response.status === 429) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThanOrEqual(module.MCP_EGRESS_IP_LIMIT);
  });

  it("meters an absent bearer rather than exempting it", async () => {
    // Sending no credential must not be a way to skip the tighter budget and
    // spend only the shared address window.
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware);

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT; i++) {
      expect((await post(app)).status).toBe(200);
    }
    expect((await post(app)).status).toBe(429);
  });

  it("does not charge the budget to a method that opens no connection", async () => {
    // The middleware is mounted on a PATH, so without the method gate a GET
    // would spend the quota the POST that actually dials needs.
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_1",
    });
    app.get("/doctor", (c) => c.json({ ok: true }));

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT * 2; i++) {
      const response = await app.request("/doctor", {
        method: "GET",
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(response.status).toBe(200);
    }
    expect((await post(app)).status).toBe(200);
  });

  it("stashes the refusal on `webErrorMeta` for the request log", async () => {
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = new Hono();
    let meta: unknown;
    app.use("/doctor", async (c, next) => {
      c.set("workosApiKeyId", "key_1");
      await next();
      meta = c.get("webErrorMeta");
    });
    app.use("/doctor", module.mcpEgressRateLimitMiddleware);
    app.post("/doctor", (c) => c.json({ ok: true }));

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT; i++) {
      expect((await post(app)).status).toBe(200);
    }
    expect((await post(app)).status).toBe(429);
    expect(meta).toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });

  it("degrades an unclassifiable credential to the address budget, not a refusal", async () => {
    // The credential map fails OPEN at its cap while the address map fails
    // closed. Refusing traffic we have merely run out of room to classify
    // would make the limiter the outage, and an entry only lands here after
    // the address backstop already admitted the request — so filling it costs
    // an attacker the address budget it would have spent anyway.
    const { module, restore: r } = await loadMiddleware(true);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware);

    for (let i = 0; i < module.MCP_EGRESS_MAX_ENTRIES; i++) {
      await post(app, {
        bearer: `filler-${i}`,
        ip: `10.0.${Math.floor(i / 60 / 256)}.${Math.floor(i / 60) % 256}`,
      });
    }

    // Past its own limit, so a credential that had been given a window would
    // be refused by now. This one never got one, and the address it arrives
    // from is fresh.
    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT + 1; i++) {
      const response = await post(app, {
        bearer: "unclassifiable",
        ip: "198.51.100.200",
      });
      expect(response.status).toBe(200);
    }
  });

  it("is inert outside hosted mode", async () => {
    const { module, restore: r } = await loadMiddleware(false);
    restore = r;
    const app = appWith(module.mcpEgressRateLimitMiddleware, {
      workosApiKeyId: "key_1",
    });

    for (let i = 0; i < module.MCP_EGRESS_CREDENTIAL_LIMIT * 3; i++) {
      expect((await post(app)).status).toBe(200);
    }
  });
});
