import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => [] as string[]);

vi.mock("../../../middleware/bearer-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../middleware/bearer-auth.js")>()),
  bearerAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../middleware/guest-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../middleware/guest-rate-limit.js")>()),
  guestRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../middleware/mcp-egress-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../middleware/mcp-egress-rate-limit.js")>()),
  mcpEgressRateLimitMiddleware: async (c: { req: { path: string }; json: (body: unknown, status: number) => Response }) => {
    seen.push(c.req.path);
    return c.json({ code: "RATE_LIMITED" }, 429);
  },
}));

const { default: web } = await import("../index.js");

describe("hosted canvas refresh", () => {
  it("takes a server-check slot like doctor and validate", async () => {
    const response = await web.request("/servers/canvas/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ projectId: "prj_1", serverId: "srv_1" }),
    });
    expect(response.status).toBe(429);
    expect(seen).toEqual(["/servers/canvas/refresh"]);
  });
});
