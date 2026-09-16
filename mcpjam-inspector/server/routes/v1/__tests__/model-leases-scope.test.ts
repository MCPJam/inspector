import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: vi.fn(async () => "delegated-token"),
}));
import modelLeases from "../model-leases.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("model lease revocation scope", () => {
  it.each(["default", "project_a"])(
    "forwards the %s path scope and SDK delivery",
    async (project) => {
      vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
      const fetchMock = vi.fn(async () =>
        Response.json({ ok: true, revoked: 1 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const app = new Hono().route("/api/v1", modelLeases);
      const response = await app.request(
        `/api/v1/projects/${project}/model-leases/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: " shared ",
            projectId: "foreign",
            delivery: "e2b-network-transform",
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("https://backend.test/web/harness/model-broker/revoke"),
        expect.objectContaining({
          body: JSON.stringify({
            runId: "shared",
            delivery: "sdk-direct",
            ...(project === "default" ? {} : { projectId: project }),
          }),
          headers: expect.objectContaining({
            authorization: "Bearer delegated-token",
          }),
        }),
      );
    },
  );
});
