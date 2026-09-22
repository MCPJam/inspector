import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../bearer-auth.js";

const TOKEN = "dsc_test_token_value_0123456789abcdef";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const resolveSurfaceActingUser = vi.hoisted(() => vi.fn());
const resolveSlackActingUser = vi.hoisted(() => vi.fn());
vi.mock("../../services/slack-backend.js", () => ({
  resolveSurfaceActingUser,
  resolveSlackActingUser,
  SlackBackendUnavailable: class SlackBackendUnavailable extends Error {},
}));

function buildApp() {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.all("*", (c) =>
    c.json({
      ok: true,
      authMethod: c.get("authMethod"),
      workosUserId: c.get("workosUserId"),
      organizationId: c.get("mcpjamOrganizationId"),
      surfaceKind: c.get("surfaceKind"),
      surfaceTenantId: c.get("surfaceTenantId"),
      surfaceActorId: c.get("surfaceActorId"),
    })
  );
  return app;
}

describe("dsc_ service auth", () => {
  beforeEach(() => {
    resolveSurfaceActingUser.mockReset();
    resolveSlackActingUser.mockReset();
    resolveSurfaceActingUser.mockResolvedValue({
      userId: "user_1",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      defaultProjectId: null,
    });
    process.env.MCPJAM_DISCORD_SERVICE_TOKEN_HASH = TOKEN_HASH;
  });

  afterEach(() => {
    delete process.env.MCPJAM_DISCORD_SERVICE_TOKEN_HASH;
  });

  it("authorizes generic surface headers as the linked Discord user", async () => {
    const response = await buildApp().request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-mcpjam-surface-tenant-id": "G1",
          "x-mcpjam-surface-actor-id": "U1",
        },
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authMethod: "discord_service",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      surfaceKind: "discord",
      surfaceTenantId: "G1",
      surfaceActorId: "U1",
    });
    expect(resolveSurfaceActingUser).toHaveBeenCalledWith(
      "discord",
      "G1",
      "U1",
      { surfaceServiceToken: TOKEN }
    );
  });

  it("does not open a non-allowlisted route", async () => {
    const response = await buildApp().request(
      new Request("http://localhost/api/v1/projects/p1/servers", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-mcpjam-surface-tenant-id": "G1",
          "x-mcpjam-surface-actor-id": "U1",
        },
      })
    );
    expect(response.status).toBe(401);
    expect(resolveSurfaceActingUser).not.toHaveBeenCalled();
  });
});
