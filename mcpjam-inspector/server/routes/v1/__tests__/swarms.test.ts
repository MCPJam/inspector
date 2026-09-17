import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "token",
}));
import swarms from "../swarms.js";
import { v1OnError } from "../envelope.js";
const row = {
  _id: "s",
  projectId: "p",
  name: "Swarm",
  description: null,
  environmentIds: [],
  config: { sessionsPerTarget: 1, maxTurns: 6, setupWrites: true },
  createdAt: 0,
  updatedAt: 0,
};
function patch(body: unknown) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", swarms);
  return app.request("/api/v1/projects/p/swarms/s", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  queryMock.mockResolvedValue(row);
  mutationMock.mockResolvedValue(row);
});
afterEach(() => vi.unstubAllEnvs());

describe("swarm execution config PATCH", () => {
  it.each([
    { setupWrites: true },
    { setupWrites: false },
    { sessionsPerTarget: 2 },
    { maxTurns: 4 },
    { setupWrites: false, maxTurns: 4 },
  ])("rejects incomplete config %j before a write", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "forwards the pair and explicit setupWrites=%s",
    async (setupWrites) => {
      const config = { sessionsPerTarget: 2, maxTurns: 4, setupWrites };
      expect((await patch(config)).status).toBe(200);
      expect(mutationMock).toHaveBeenCalledWith("swarms:updateSwarm", {
        swarmRefId: "s",
        config,
      });
    },
  );
  it("omits setupWrites when replacing the pair without it", async () => {
    const config = { sessionsPerTarget: 2, maxTurns: 4 };
    expect((await patch(config)).status).toBe(200);
    expect(mutationMock).toHaveBeenCalledWith("swarms:updateSwarm", {
      swarmRefId: "s",
      config,
    });
  });
});
