import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authorizeTaskSources } from "../task-source-authorization";
vi.mock("../v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "acting-user",
}));
vi.mock("../../services/service-credential.js", () => ({
  serviceCredentialHeaders: () => ({ "x-inspector-service-token": "service" }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function app() {
  const app = new Hono();
  app.post("/", async (c) => {
    await authorizeTaskSources(c, await c.req.json());
    return c.json({ sent: true });
  });
  app.onError((err, c) => c.json({ message: err.message }, 403));
  return app;
}
const request = {
  projectId: "project",
  serverId: "server",
  wire: "extension",
  connectionId: "account",
  taskIds: ["a", "b"],
  sourceExecutions: { a: "receipt-a", b: "receipt-b" },
};
it("validates all per-task sources against the acting user before dispatch", async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({
      allowed: true,
      binding: "trusted",
      hostConfig: { clientCapabilities: {} },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const response = await app().request("/", {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe(
    "https://backend.test/internal/v1/hosted-task-sources/authorize",
  );
  expect(JSON.parse(options.body)).toMatchObject({
    connectionId: "account",
    sources: [
      { taskId: "a", sourceExecutionId: "receipt-a" },
      { taskId: "b", sourceExecutionId: "receipt-b" },
    ],
  });
  expect(options.headers.authorization).toBe("Bearer acting-user");
});
it.each([403, 503])(
  "refuses failed source authorization (%s)",
  async (status) => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubGlobal("fetch", async () => new Response(null, { status }));
    expect(
      (
        await app().request("/", {
          method: "POST",
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(403);
  },
);
it("rejects sources outside the requested batch without contacting the backend", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await app().request("/", {
        method: "POST",
        body: JSON.stringify({ ...request, taskIds: ["a"] }),
      })
    ).status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
