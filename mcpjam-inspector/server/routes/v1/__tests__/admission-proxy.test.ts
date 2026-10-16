import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "token",
}));
import modelLeases from "../model-leases.js";
import evalIngest from "../eval-ingest.js";
const app = new Hono()
  .route("/api/v1", modelLeases)
  .route("/api/v1", evalIngest);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function post(path: string, body: unknown) {
  return app.request(`/api/v1/projects/default/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
describe("admission proxy", () => {
  it.each(["admit", "ensure-steps"])(
    "forwards the %s operation",
    async (operation) => {
      vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
      const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetch);
      expect(
        (await post(`eval-ingest/${operation}`, { executionKey: "run" }))
          .status,
      ).toBe(200);
      expect(String(fetch.mock.calls[0][0])).toBe(
        `https://convex.example/v1/evals/ingest/${operation}`,
      );
    },
  );
  it.each([
    [402, "platform_fee_refused", "PAYMENT_REQUIRED"],
    [426, "client_upgrade_required", "UPGRADE_REQUIRED"],
    [503, "platform_fee_unavailable", "INTERNAL_ERROR"],
  ] as const)("preserves the %s remedy", async (status, domainCode, code) => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            {
              ok: false,
              code: "insufficient_credits",
              domainCode,
              error: "The original remedy.",
            },
            { status },
          ),
        ),
    );
    const response = await post("model-leases", { model: "openai/gpt-5" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      code,
      message: "The original remedy.",
      details: { code: domainCode },
    });
  });
});
