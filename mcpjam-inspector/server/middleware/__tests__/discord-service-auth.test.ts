import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../bearer-auth.js";

const TOKEN = "dsc_test_token_value_0123456789abcdef";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const resolveSurfaceActingUser = vi.hoisted(() => vi.fn());

vi.mock("../../services/slack-backend.js", () => ({
  resolveSurfaceActingUser,
  resolveSlackActingUser: vi.fn(),
  SlackBackendUnavailable: class SlackBackendUnavailable extends Error {},
}));

function buildApp() {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.all("*", (c) =>
    c.json({
      ok: true,
      authMethod: c.get("authMethod"),
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
    resolveSurfaceActingUser.mockResolvedValue({
      userId: "user_1",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      defaultProjectId: "project_1",
    });
    process.env.MCPJAM_DISCORD_SERVICE_TOKEN_HASH = TOKEN_HASH;
  });

  afterEach(() => {
    delete process.env.MCPJAM_DISCORD_SERVICE_TOKEN_HASH;
  });

  it("authorizes a linked Discord actor with a separate auth method", async () => {
    const response = await buildApp().request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-mcpjam-surface-tenant-id": "guild_1",
          "x-mcpjam-surface-actor-id": "discord_user_1",
        },
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authMethod: "discord_service",
      surfaceKind: "discord",
      surfaceTenantId: "guild_1",
      surfaceActorId: "discord_user_1",
    });
  });

  it("does not accept a Slack credential in the Discord branch", async () => {
    const response = await buildApp().request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: {
          authorization: "Bearer slk_not_a_discord_token",
          "x-mcpjam-surface-tenant-id": "guild_1",
          "x-mcpjam-surface-actor-id": "discord_user_1",
        },
      })
    );
    expect(response.status).toBe(401);
    expect(resolveSurfaceActingUser).not.toHaveBeenCalled();
  });

  it("requires both generic identity headers", async () => {
    const response = await buildApp().request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );
    expect(response.status).toBe(401);
  });
});
