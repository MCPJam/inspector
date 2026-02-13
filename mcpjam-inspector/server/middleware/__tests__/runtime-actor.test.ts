import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("runtimeActorMiddleware", () => {
  const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;
  const originalIdleTtl = process.env.MCPJAM_ACTOR_IDLE_TTL_MS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHostedMode === undefined) {
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
    } else {
      process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
    }

    if (originalIdleTtl === undefined) {
      delete process.env.MCPJAM_ACTOR_IDLE_TTL_MS;
    } else {
      process.env.MCPJAM_ACTOR_IDLE_TTL_MS = originalIdleTtl;
    }
  });

  it("isolates actors per tenant and keeps sticky actor for same tenant", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    process.env.MCPJAM_ACTOR_IDLE_TTL_MS = "0";
    vi.doMock("../../services/auth/hosted-jwt-verifier.js", () => ({
      verifyHostedJwt: vi.fn(async (token: string) => {
        if (token === "token_a") {
          return {
            sub: "user_a",
            iss: "https://issuer.example.com",
            aud: "mcpjam-web",
            exp: Math.floor(Date.now() / 1000) + 60,
          };
        }
        return {
          sub: "user_b",
          iss: "https://issuer.example.com",
          aud: "mcpjam-web",
          exp: Math.floor(Date.now() / 1000) + 60,
        };
      }),
      HostedJwtVerificationError: class HostedJwtVerificationError extends Error {
        code = "invalid_token";
        status = 401;
      },
    }));

    const { hostedMcpAuthMiddleware } = await import("../hosted-mcp-auth.js");
    const { runtimeActorMiddleware } = await import("../runtime-actor.js");

    const app = new Hono();
    app.use("/api/mcp/*", hostedMcpAuthMiddleware);
    app.use("/api/mcp/*", runtimeActorMiddleware);
    app.get("/api/mcp/servers", (c) =>
      c.json({
        tenantId: c.tenantId,
        actorId: c.runtimeActor?.actorId ?? null,
      }),
    );

    const tokenA = "token_a";
    const tokenB = "token_b";

    const tenantAFirst = await app.request("/api/mcp/servers", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const tenantASecond = await app.request("/api/mcp/servers", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const tenantB = await app.request("/api/mcp/servers", {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    const bodyAFirst = (await tenantAFirst.json()) as {
      tenantId: string;
      actorId: string;
    };
    const bodyASecond = (await tenantASecond.json()) as {
      tenantId: string;
      actorId: string;
    };
    const bodyB = (await tenantB.json()) as {
      tenantId: string;
      actorId: string;
    };

    expect(bodyAFirst.tenantId).toBe("user_a");
    expect(bodyASecond.actorId).toBe(bodyAFirst.actorId);
    expect(bodyB.tenantId).toBe("user_b");
    expect(bodyB.actorId).not.toBe(bodyAFirst.actorId);
  });
});
