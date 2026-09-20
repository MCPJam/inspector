import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("../../utils/request-logger.js", () => ({
  getSystemLogger: () => ({ event: log }),
}));
import { securityHeadersMiddleware } from "../../middleware/security-headers.js";
import { originValidationMiddleware } from "../../middleware/origin-validation.js";
import { sessionAuthMiddleware } from "../../middleware/session-auth.js";
import relayRoutes, { relayBodyLimit } from "../relay";
const event = {
  event_id: "ba52198b-e99c-449a-b17d-deba083c8445",
  launch_id: "platform-launch-2026-09",
  action: "opened",
  feature: "swarms",
  presentation: "card",
  prior_status: "unseen",
  audience: "guest",
};
function send(body: unknown, prefix = "/tlm") {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.use("*", originValidationMiddleware);
  app.use("*", sessionAuthMiddleware);
  app.use(`${prefix}/*`, relayBodyLimit());
  app.route(prefix, relayRoutes);
  return app.request(`http://localhost:6274${prefix}/launch-engagement`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:6274" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => vi.clearAllMocks());
describe("launch engagement logging", () => {
  it.each(["/tlm", "/relay"])(
    "logs validated anonymous events to Axiom on %s",
    async (prefix) => {
      expect((await send(event, prefix)).status).toBe(204);
      expect(log).toHaveBeenCalledExactlyOnceWith("launch.engagement", event);
    },
  );
  it.each([
    { ...event, action: "arbitrary" },
    { ...event, email: "private@example.com" },
    { ...event, duration_ms: -1 },
    { ...event, launch_id: "unknown" },
    null,
  ])("rejects invalid or unbounded fields without logging", async (payload) => {
    expect((await send(payload)).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });
  it("bounds body size before parsing or logging", async () => {
    expect((await send({ ...event, extra: "x".repeat(3000) })).status).toBe(
      413,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
