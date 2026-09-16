import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "token",
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi
    .fn()
    .mockImplementation(() => ({ setAuth: vi.fn(), query })),
}));
import clients from "../clients.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("returns the configuration and its recorded version together", async () => {
  vi.stubEnv("CONVEX_URL", "https://backend.test");
  query.mockImplementation(async (name: string) =>
    name === "hosts:resolveHostByNameOrId"
      ? { hostId: "client1" }
      : {
          hostId: "client1",
          name: "My client",
          hostConfigId: "config2",
          versionId: "version2",
          versionNumber: 2,
          config: {
            modelId: "anthropic/claude-haiku-4.5",
            systemPrompt: "v2 prompt",
          },
        },
  );
  const app = new Hono().route("/api/v1", clients);
  const response = await app.request(
    "/api/v1/projects/project1/clients/My%20client",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: "client1",
    name: "My client",
    configId: "config2",
    versionId: "version2",
    versionNumber: 2,
    config: { systemPrompt: "v2 prompt" },
  });
  expect(query).toHaveBeenCalledWith("hosts:getHost", {
    hostId: "client1",
    projectId: "project1",
  });
});

it("does not invent a version when an older backend omits it", async () => {
  vi.stubEnv("CONVEX_URL", "https://backend.test");
  query.mockImplementation(async (name: string) =>
    name === "hosts:resolveHostByNameOrId"
      ? { hostId: "client1" }
      : { hostId: "client1", name: "My client", config: {} },
  );
  const response = await new Hono()
    .route("/api/v1", clients)
    .request("/api/v1/projects/project1/clients/client1");
  expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty("versionNumber");
});
