import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../bearer-auth.js";
import { resetSlackRateLimitForTests } from "../slack-service-auth.js";

const TOKEN = "slk_test_token_value_0123456789abcdef";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

const resolveSlackActingUser = vi.hoisted(() => vi.fn());
vi.mock("../../services/slack-backend.js", () => ({
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

function request(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-mcpjam-slack-team-id": "T1",
      "x-mcpjam-slack-user-id": "U1",
      ...headers,
    },
  });
}

const LINK = {
  userId: "user_1",
  workosUserId: "workos|alice",
  organizationId: "org_1",
  defaultProjectId: null,
};

describe("slk_ service auth", () => {
  beforeEach(() => {
    resetSlackRateLimitForTests();
    resolveSlackActingUser.mockReset();
    resolveSlackActingUser.mockResolvedValue(LINK);
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = TOKEN_HASH;
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
  });

  it("authorizes an allowlisted path as the LINKED user, not the bot", async () => {
    // The token names the bot; the identity must come from the account link.
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authMethod: "slack_service",
      workosUserId: "workos|alice",
      organizationId: "org_1",
    });
  });

  it("sets the CANONICAL surface trio, and the Slack aliases from the same values", async () => {
    // Routes read only the canonical trio, so a second wrapper is a new auth
    // branch setting these same three names. The aliases are set from the same
    // values, so the two cannot disagree.
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    await expect(response.json()).resolves.toMatchObject({
      surfaceKind: "slack",
      surfaceTenantId: "T1",
      surfaceActorId: "U1",
    });
  });

  it("allows eval-run create, read, and the project list", async () => {
    for (const path of [
      "/api/v1/projects/p1/eval-runs",
      "/api/v1/projects/p1/eval-runs/run_1",
      "/api/v1/projects",
    ]) {
      const response = await buildApp().request(request(path));
      expect(response.status, path).toBe(200);
    }
  });

  it("allows the run-evidence reads: iterations, and per-iteration steps", async () => {
    // Steps are ITERATION-scoped, so posting a run's screenshots needs both:
    // list the iterations, then fetch bounded step pages. Both are reads of a
    // run the acting user can already see.
    for (const path of [
      "/api/v1/projects/p1/eval-runs/run_1/iterations",
      "/api/v1/projects/p1/eval-runs/run_1/iterations/it_1/steps",
    ]) {
      const response = await buildApp().request(request(path));
      expect(response.status, path).toBe(200);
    }
  });

  it("does NOT open the neighbouring iteration routes it was not asked for", async () => {
    // The allowlist is the boundary, so widening it for evidence must not
    // quietly widen it for the trace (a far larger payload) or for cancel (a
    // write).
    for (const path of [
      "/api/v1/projects/p1/eval-runs/run_1/iterations/it_1/trace",
      "/api/v1/projects/p1/eval-runs/run_1/cancel",
      "/api/v1/projects/p1/eval-runs/run_1/iterations/it_1",
    ]) {
      const response = await buildApp().request(request(path));
      expect(response.status, path).toBe(401);
    }
  });

  it("REFUSES every non-allowlisted path, including the whole web surface", async () => {
    // This middleware is mounted on ~25 `/api/web/*` groups too, so a
    // default-allow posture would hand the bot's credential the entire app.
    for (const path of [
      "/api/web/chatboxes",
      "/api/web/api-keys",
      "/api/v1/projects/p1/servers",
      "/api/v1/projects/p1/eval-suites",
      "/api/v1/projects/p1/agent/extra",
    ]) {
      const response = await buildApp().request(request(path));
      expect(response.status, path).toBe(401);
    }
  });

  it("does not even ask the backend for a non-allowlisted path", async () => {
    // Cheap, and it keeps a refused path indistinguishable from an invalid
    // token by latency.
    await buildApp().request(request("/api/web/chatboxes"));
    expect(resolveSlackActingUser).not.toHaveBeenCalled();
  });

  it("rejects a token whose hash does not match", async () => {
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = createHash("sha256")
      .update("slk_some_other_token")
      .digest("hex");
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(401);
    expect(resolveSlackActingUser).not.toHaveBeenCalled();
  });

  it("fails closed when no token hash is configured", async () => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(401);
  });

  it("requires BOTH Slack identity headers", async () => {
    // The token names the bot and never a user; defaulting to any user is
    // unthinkable, so an absent header is a hard 401.
    const app = buildApp();
    const noUser = await app.request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-mcpjam-slack-team-id": "T1",
        },
      })
    );
    expect(noUser.status).toBe(401);

    const noTeam = await app.request(
      new Request("http://localhost/api/v1/projects/p1/agent", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-mcpjam-slack-user-id": "U1",
        },
      })
    );
    expect(noTeam.status).toBe(401);
  });

  it("answers 401 with link-your-account semantics for an unlinked user", async () => {
    resolveSlackActingUser.mockResolvedValue(null);
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      details: { reason: "SLACK_ACCOUNT_NOT_LINKED" },
    });
  });

  it("answers 503 — NOT 401 — when the backend is unreachable", async () => {
    // A 401 here would tell a LINKED user to reconnect their account. They
    // would follow the instruction, re-link, and still fail.
    resolveSlackActingUser.mockRejectedValue(new Error("backend down"));
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { message?: string };
    expect(body.message).not.toMatch(/not linked/i);
  });

  it("rate-limits per LINK, not per token", async () => {
    // The token is shared by every user of the bot, so a token-keyed bucket
    // would let one chatty workspace throttle everybody.
    const app = buildApp();
    let limited = 0;
    for (let index = 0; index < 15; index += 1) {
      const response = await app.request(request("/api/v1/projects/p1/agent"));
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    // A different Slack user has their own bucket and is unaffected.
    const other = await app.request(
      request("/api/v1/projects/p1/agent", {
        "x-mcpjam-slack-user-id": "U_OTHER",
      })
    );
    expect(other.status).toBe(200);
  });

  it("never falls through to the WorkOS-key or JWT branches", async () => {
    // `startsWith("sk_")` does not match `slk_`, but the branch order is
    // explicit so a prefix change cannot route a Slack token into the path
    // that mints delegated tokens.
    resolveSlackActingUser.mockResolvedValue(null);
    const response = await buildApp().request(
      request("/api/v1/projects/p1/agent")
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe("SLACK_ACCOUNT_NOT_LINKED");
  });
});
