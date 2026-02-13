import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { VerifiedHostedJwtPayload } from "../../services/auth/hosted-jwt-verifier";

describe("hostedMcpAuthMiddleware", () => {
  const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    if (originalHostedMode === undefined) {
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
    } else {
      process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
    }
  });

  it("rejects hosted MCP requests without bearer token", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    const verifyHostedJwt = vi.fn();
    vi.doMock("../../services/auth/hosted-jwt-verifier.js", () => ({
      verifyHostedJwt,
      HostedJwtVerificationError: class HostedJwtVerificationError extends Error {
        code = "invalid_token";
        status = 401;
      },
    }));
    const { hostedMcpAuthMiddleware } = await import("../hosted-mcp-auth.js");

    const app = new Hono();
    app.use("/api/mcp/*", hostedMcpAuthMiddleware);
    app.get("/api/mcp/servers", (c) =>
      c.json({ tenantId: c.tenantId ?? null }),
    );

    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(401);
  });

  it("resolves tenant from workspace header with fallback to token sub", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    const verifyHostedJwt =
      vi.fn<(token: string) => Promise<VerifiedHostedJwtPayload>>();
    verifyHostedJwt.mockResolvedValue({
      sub: "user_123",
      iss: "https://issuer.example.com",
      aud: "audience_1",
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    vi.doMock("../../services/auth/hosted-jwt-verifier.js", () => ({
      verifyHostedJwt,
      HostedJwtVerificationError: class HostedJwtVerificationError extends Error {
        code = "invalid_token";
        status = 401;
      },
    }));
    const { hostedMcpAuthMiddleware } = await import("../hosted-mcp-auth.js");

    const app = new Hono();
    app.use("/api/mcp/*", hostedMcpAuthMiddleware);
    app.get("/api/mcp/servers", (c) => c.json({ tenantId: c.tenantId }));

    const token = "header.payload.signature";

    const headerTenantRes = await app.request("/api/mcp/servers", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-MCPJam-Workspace-Id": "workspace_abc",
      },
    });
    expect(headerTenantRes.status).toBe(200);
    expect(await headerTenantRes.json()).toEqual({ tenantId: "workspace_abc" });

    const fallbackTenantRes = await app.request("/api/mcp/servers", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(fallbackTenantRes.status).toBe(200);
    expect(await fallbackTenantRes.json()).toEqual({ tenantId: "user_123" });
  });

  it("does not enforce bearer auth when not hosted", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "false";
    const verifyHostedJwt = vi.fn();
    vi.doMock("../../services/auth/hosted-jwt-verifier.js", () => ({
      verifyHostedJwt,
      HostedJwtVerificationError: class HostedJwtVerificationError extends Error {
        code = "invalid_token";
        status = 401;
      },
    }));
    const { hostedMcpAuthMiddleware } = await import("../hosted-mcp-auth.js");

    const app = new Hono();
    app.use("/api/mcp/*", hostedMcpAuthMiddleware);
    app.get("/api/mcp/servers", (c) => c.json({ ok: true }));

    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
