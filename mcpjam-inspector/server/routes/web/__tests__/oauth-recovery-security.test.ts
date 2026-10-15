import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
vi.mock("../../../middleware/guest-rate-limit.js", () => ({
  guestRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
vi.mock("../../../middleware/passthrough-rate-limit.js", () => ({
  passthroughRateLimitMiddleware: async (
    _c: unknown,
    next: () => Promise<void>,
  ) => next(),
}));

describe("OAuth local recovery admission", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  async function app(hosted: boolean) {
    vi.resetModules();
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", String(hosted));
    return new Hono().route("/oauth", (await import("../oauth.js")).default);
  }
  it("does not register recovery routes in hosted mode", async () => {
    const server = await app(true);
    for (const path of [
      "/oauth/recovery-headers",
      "/oauth/recovery-headers/stage",
    ]) {
      expect(
        (
          await server.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              serverName: "server",
              serverUrl: "https://example.com",
              projectId: "project",
              serverId: "server",
              recoveryHandle: "a".repeat(48),
              headers: { "X-Key": "value" },
            }),
          })
        ).status,
      ).toBe(404);
    }
  });
  it("replaces abandoned handles for the same server without exhausting the cap", async () => {
    const server = await app(false);
    const binding = {
      serverName: "server",
      serverUrl: "https://example.com/mcp",
    };
    const post = (path: string, body: Record<string, unknown>) =>
      server.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = crypto.randomUUID();
    for (let index = 0; index < 20; index++) {
      expect(
        (
          await post("/oauth/recovery-headers/stage", {
            ...binding,
            recoveryHandle: index === 0 ? first : crypto.randomUUID(),
            headers: { "X-Project": "default" },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await post("/oauth/recovery-headers", {
          ...binding,
          recoveryHandle: first,
        })
      ).status,
    ).toBe(404);
  });
});
